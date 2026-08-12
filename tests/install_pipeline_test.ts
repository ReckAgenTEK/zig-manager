import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { dirname, join } from "@std/path";
import {
  canonicalInstallArtifactPath,
  createBuiltZigInstallIdentity,
  installBuiltZig,
  parseZigEnvTarget,
} from "../src/install_pipeline.ts";
import { ZigBinaryVerificationError } from "../src/errors.ts";
import { fileMetadata, pathExists } from "../src/filesystem.ts";
import {
  computeInstallationId,
  InstallStore,
  type ResolvedSource,
  type RuntimeDependencyInspector,
} from "../src/install_store.ts";
import { validateBuildManifest } from "../src/manifest.ts";
import { ZigCMake21Adapter } from "../src/release_adapter.ts";
import { createBuildPaths } from "../src/build.ts";
import { prepareZigBuildRecipe } from "../src/recipe_preparation.ts";
import { validateZigBuildRecipe, type ZigBuildRecipeV1 } from "../src/build_recipe.ts";
import type {
  BuildIdentityInput,
  BuildManifest,
  BuildToolchain,
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
  ResolvedZigManagerConfig,
  ToolProbeResult,
} from "../src/types.ts";
import {
  createDevelopmentFiles,
  FakeProcessRunner,
  writeElf64X86_64,
  zigVersionMetadata,
} from "./test_helpers.ts";

const COMMIT = "a".repeat(40);
const VERSION = "0.16.0";
const HOST_TARGET = "x86_64-unknown-linux-gnu";
const CREATED = "2026-08-10T12:00:00.000Z";
const LATER = "2026-08-11T12:00:00.000Z";
const HOST = {
  os: "linux",
  architecture: "x86_64",
  abi: "gnu",
  denoTarget: HOST_TARGET,
} as const;
const STATIC_RUNTIME_INSPECTOR: RuntimeDependencyInspector = {
  contractVersion: 1,
  inspect: () => Promise.resolve({ linkage: "static" }),
};

Deno.test("BuildManifest install identity is deterministic and excludes output paths and timestamps", async () => {
  await withFixture(async ({ root, manifest, source, adapter }) => {
    const baseInput = {
      buildManifest: manifest,
      source,
      adapter,
      host: HOST,
      expectedHostTarget: HOST_TARGET,
    };
    const identity = await createBuiltZigInstallIdentity(baseInput);
    const relocatedManifest: BuildManifest = {
      ...manifest,
      paths: {
        ...manifest.paths,
        root: join(root, "other-cache", "build"),
        install: join(root, "other-cache", "build", "install"),
        executable: join(root, "other-cache", "build", "install", "bin", "zig"),
        lib: join(root, "other-cache", "build", "install", "lib", "zig"),
      },
      commands: [{
        executable: "/different/cmake",
        args: ["--build", "/different/output"],
        cwd: "/different/source",
        env: { ZIG_LOCAL_CACHE_DIR: "/different/cache" },
        clearEnv: true,
      }],
    };
    const relocated = await createBuiltZigInstallIdentity({
      ...baseInput,
      buildManifest: relocatedManifest,
      source: { ...source, resolvedAt: LATER },
    });
    assertEquals(await computeInstallationId(identity), await computeInstallationId(relocated));

    const host = { ...HOST, architecture: "x86_64-v2" };
    const hostRecipe = { ...manifest.recipe, host };
    const otherHost = await createBuiltZigInstallIdentity({
      ...baseInput,
      buildManifest: await manifestForRecipe(manifest, hostRecipe),
      host,
    });
    const adapterIdentity = {
      id: "another-adapter",
      buildContractVersion: 1,
      verifierContractVersion: 2,
    };
    const adapterRecipe = { ...manifest.recipe, adapter: adapterIdentity };
    const otherAdapter = await createBuiltZigInstallIdentity({
      ...baseInput,
      buildManifest: await manifestForRecipe(manifest, adapterRecipe),
      adapter: adapterIdentity,
    });
    const contractAdapter = {
      id: adapter.id,
      buildContractVersion: adapter.buildContractVersion + 1,
      verifierContractVersion: 2,
    };
    const contractRecipe = { ...manifest.recipe, adapter: contractAdapter };
    const otherContract = await createBuiltZigInstallIdentity({
      ...baseInput,
      buildManifest: await manifestForRecipe(manifest, contractRecipe),
      adapter: contractAdapter,
    });
    assertNotEquals(await computeInstallationId(identity), await computeInstallationId(otherHost));
    assertNotEquals(
      await computeInstallationId(identity),
      await computeInstallationId(otherAdapter),
    );
    assertNotEquals(
      await computeInstallationId(identity),
      await computeInstallationId(otherContract),
    );

    const changedConfiguration = {
      ...manifest.configuration,
      options: { ...manifest.configuration.options, jobs: 12 },
    };
    const changedRecipe = {
      ...manifest.recipe,
      build: { ...manifest.recipe.build, jobs: 12 },
    };
    const changedBuild = validateBuildManifest({
      ...manifest,
      identity: await computeInstallationId(changedRecipe),
      recipe: changedRecipe,
      configuration: changedConfiguration,
    });
    const changedIdentity = await createBuiltZigInstallIdentity({
      ...baseInput,
      buildManifest: changedBuild,
    });
    assertNotEquals(
      await computeInstallationId(identity),
      await computeInstallationId(changedIdentity),
    );
  });
});

Deno.test("pipeline securely copies, publishes, and reuses without reading deleted build cache", async () => {
  await withFixture(async ({ root, manifest, source, adapter }) => {
    const dataRoot = join(root, "data-root");
    const store = new InstallStore(dataRoot);
    const runner = new RelocatingZigRunner(dataRoot);
    const first = await installBuiltZig(pipelineInput(store, runner, manifest, source, adapter));
    assertEquals(first.reused, false);
    assertEquals(first.copied, true);
    assertEquals(first.manifest.paths, {
      executable: "install/bin/zig",
      libraries: ["install/lib/zig"],
    });
    assertEquals(first.manifest.executable.hostTarget, HOST_TARGET);
    assertEquals(first.manifest.runtime, { linkage: "static" });
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.stat(first.executablePath)).mode! & 0o777, 0o751);
      assertEquals(
        (await Deno.stat(join(first.root, "install", "share", "mode.txt"))).mode! & 0o777,
        0o640,
      );
    }
    assertEquals(runner.requests.length, 10);
    assert(runner.requests.every((request) => request.clearEnv === true));
    assert(runner.requests.every((request) => request.env?.CFLAGS !== "poisoned"));

    await Deno.remove(dirname(manifest.paths.root), { recursive: true });
    const reused = await installBuiltZig(pipelineInput(store, runner, manifest, source, adapter));
    assertEquals(reused.reused, true);
    assertEquals(reused.copied, false);
    assertEquals(reused.stagedVerification, null);
    assertEquals(reused.root, first.root);
    assertEquals(runner.requests.length, 14);
    assert(await pathExists(reused.executablePath));
  });
});

Deno.test("canonical recipe identity changes for every material input and rejects reporting data", async () => {
  await withFixture(async ({ manifest }) => {
    const base = manifest.recipe;
    const baseId = await computeInstallationId(base);
    const mutations: Array<(recipe: Mutable<ZigBuildRecipeV1>) => void> = [
      (recipe) => recipe.component = "zls",
      (recipe) => recipe.source.repository.identity = "codeberg/zig-mirror",
      (recipe) => recipe.source.repository.url = "https://codeberg.org/ziglang/zig-mirror.git",
      (recipe) => {
        recipe.source.commit = "b".repeat(40);
        recipe.source.version.commitAbbreviation = "b".repeat(9);
      },
      (recipe) => {
        recipe.source.version.base = "0.16.1";
        recipe.source.version.text = "0.16.1";
        recipe.source.version.taggedAncestor = "0.16.1";
      },
      (recipe) => recipe.adapter.id = "other-adapter",
      (recipe) => recipe.adapter.buildContractVersion++,
      (recipe) => recipe.adapter.verifierContractVersion++,
      (recipe) => recipe.host.os = "darwin",
      (recipe) => recipe.host.architecture = "aarch64",
      (recipe) => recipe.host.abi = "musl",
      (recipe) => recipe.host.denoTarget = "x86_64-unknown-linux-musl",
      (recipe) => {
        recipe.cpuPolicy = "native";
        recipe.build.cpu = "native";
      },
      (recipe) => {
        recipe.build.profile = "debug";
        recipe.build.cmakeBuildType = "Debug";
      },
      (recipe) => {
        recipe.build.generator = "Unix Makefiles";
        recipe.cmake.configureArguments[recipe.cmake.configureArguments.indexOf("Ninja")] =
          "Unix Makefiles";
      },
      (recipe) => recipe.build.jobs = 99,
      (recipe) => recipe.build.cmakePrefixPath = "/different/llvm",
      (recipe) => recipe.cmake.configureArguments.push("-DFIXTURE_INPUT=ON"),
      (recipe) => recipe.cmake.buildArguments.push("--verbose"),
      (recipe) => recipe.environment.variables.PATH = "/different/tools",
      (recipe) => recipe.tools.cmake.path = "/different/cmake",
      (recipe) => recipe.tools.cmake.version = "3.31.0",
      (recipe) => recipe.tools.cmake.size++,
      (recipe) => recipe.tools.cmake.sha256 = "f".repeat(64),
      (recipe) => recipe.tools.cmake.queries[0].stdout += "changed\n",
      (recipe) => recipe.development.files[0].path = "/different/header.h",
      (recipe) => recipe.development.files[0].size++,
      (recipe) => recipe.development.files[0].sha256 = "e".repeat(64),
      (recipe) => recipe.development.packages[0].version = "22.0.0-1",
      (recipe) => recipe.development.packages[0].query.stdout += "changed\n",
    ];
    for (const mutate of mutations) {
      const value = structuredClone(base) as unknown as Mutable<ZigBuildRecipeV1>;
      mutate(value);
      if (value.component === "zls") {
        value.dependencies = [{ component: "zig", installationId: "d".repeat(64) }];
      }
      const recipe = validateZigBuildRecipe(value);
      assertNotEquals(await computeInstallationId(recipe), baseId);
    }
    assertThrows(
      () => validateZigBuildRecipe({ ...base, requestedSelector: "latest" }),
      TypeError,
      "unknown key",
    );
    assertThrows(
      () => validateZigBuildRecipe({ ...base, createdAt: CREATED }),
      TypeError,
      "unknown key",
    );
    const missingFingerprint = structuredClone(base) as unknown as {
      tools: { cmake: Record<string, unknown> };
    };
    delete missingFingerprint.tools.cmake.sha256;
    assertThrows(
      () => validateZigBuildRecipe(missingFingerprint),
      TypeError,
      "sha256 is required",
    );
    const missingQuery = structuredClone(base) as unknown as Mutable<ZigBuildRecipeV1>;
    missingQuery.tools.cmake.queries = [];
    assertThrows(
      () => validateZigBuildRecipe(missingQuery),
      TypeError,
      "nonempty",
    );
    const missingNoLangref = structuredClone(base) as unknown as Mutable<ZigBuildRecipeV1>;
    missingNoLangref.cmake.configureArguments = missingNoLangref.cmake.configureArguments.filter(
      (argument) => argument !== "-DZIG_EXTRA_BUILD_ARGS=-Dno-langref",
    );
    assertThrows(
      () => validateZigBuildRecipe(missingNoLangref),
      TypeError,
      "disable language-reference installation canonically",
    );
    missingNoLangref.adapter.buildContractVersion = 1;
    validateZigBuildRecipe(missingNoLangref);
  });
});

Deno.test("bare build tools resolve through captured PATH to physical fingerprinted executables", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-recipe-path-" });
  try {
    const source = sourceFixture();
    const recipe = await createRecipeFixture(root, source, new ZigCMake21Adapter(), true);
    for (const tool of Object.values(recipe.tools)) {
      assert(tool.path.startsWith(join(root, "tools")));
      assertEquals(tool.path, await Deno.realPath(tool.path));
      assert(tool.size > 0);
      assertEquals(tool.sha256.length, 64);
      assert(tool.queries.length > 0);
    }
  } finally {
    await remove(root);
  }
});

Deno.test("development library aliases fingerprint their physical targets", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-recipe-library-alias-" });
  try {
    const source = sourceFixture();
    const recipe = await createRecipeFixture(root, source, new ZigCMake21Adapter(), false, true);
    const alias = join(root, "toolchain", "lib", "liblldCommon.a");
    const physical = await Deno.realPath(alias);
    assert(recipe.development.files.some((file) => file.path === physical));
    assert(!recipe.development.files.some((file) => file.path === alias));
  } finally {
    await remove(root);
  }
});

type Mutable<T> = {
  -readonly [Key in keyof T]: T[Key] extends readonly (infer Item)[] ? Mutable<Item>[]
    : T[Key] extends object ? Mutable<T[Key]>
    : T[Key];
};

Deno.test("staged and promoted verification follows relocation and parses JSON/ZON targets", async () => {
  await withFixture(async ({ root, manifest, source, adapter }) => {
    const dataRoot = join(root, "data");
    const store = new InstallStore(dataRoot);
    const runner = new RelocatingZigRunner(dataRoot);
    const result = await installBuiltZig(pipelineInput(store, runner, manifest, source, adapter));
    assert(result.stagedVerification !== null);
    assertStringIncludes(result.stagedVerification.libDir, join("installs", ".staging"));
    assertEquals(
      result.promotedVerification.libDir,
      join(result.root, "install", "lib", "zig"),
    );
    assertNotEquals(result.stagedVerification.libDir, result.promotedVerification.libDir);
    assertEquals(result.stagedVerification.reportedHostTarget, HOST_TARGET);
    assertEquals(result.promotedVerification.reportedHostTarget, HOST_TARGET);
    assertEquals(parseZigEnvTarget(`{"target":"${HOST_TARGET}"}`), HOST_TARGET);
    assertEquals(parseZigEnvTarget(`.{\n  .target = "${HOST_TARGET}",\n}\n`), HOST_TARGET);
    assertEquals(parseZigEnvTarget('.{\n  .lib_dir = "/managed/lib",\n}\n'), null);

    assertEquals(
      canonicalInstallArtifactPath("/cache/build/install", "/cache/build/install/bin/zig", "linux"),
      "install/bin/zig",
    );
    assertEquals(
      canonicalInstallArtifactPath(
        "C:\\cache\\build\\install",
        "C:\\cache\\build\\install\\bin\\zig.exe",
        "windows",
      ),
      "install/bin/zig.exe",
    );
    assertThrows(
      () => canonicalInstallArtifactPath("/cache/build/install", "/cache/build/outside", "linux"),
      TypeError,
      "escapes",
    );
  });
});

Deno.test("wrong staged Zig version removes owned staging and never publishes", async () => {
  await withFixture(async ({ root, manifest, source, adapter }) => {
    const store = new InstallStore(join(root, "data"));
    const runner = new RelocatingZigRunner(store.dataRoot);
    runner.wrongVersionPhase = "staging";
    const identity = await createBuiltZigInstallIdentity({
      buildManifest: manifest,
      source,
      adapter,
      host: HOST,
      expectedHostTarget: HOST_TARGET,
    });
    const installationId = await computeInstallationId(identity);
    await assertRejects(
      () => installBuiltZig(pipelineInput(store, runner, manifest, source, adapter)),
      ZigBinaryVerificationError,
      "version",
    );
    assertEquals(await directoryNames(store.stagingRoot), []);
    assert(!(await pathExists(store.installationPath("zig", installationId))));
    assert(await pathExists(manifest.paths.executable));
  });
});

Deno.test("missing staged managed lib/std removes staging and never publishes", async () => {
  await withFixture(async ({ root, manifest, source, adapter }) => {
    const store = new InstallStore(join(root, "data"));
    const runner = new RelocatingZigRunner(store.dataRoot);
    runner.removeStdPhase = "staging";
    await assertRejects(
      () => installBuiltZig(pipelineInput(store, runner, manifest, source, adapter)),
      ZigBinaryVerificationError,
      "standard library",
    );
    assertEquals(await directoryNames(store.stagingRoot), []);
    assertEquals((await directoryNames(join(store.installsRoot, "zig"))).length, 0);
    assert(await pathExists(join(manifest.paths.lib, "std", "std.zig")));
  });
});

Deno.test("install failure cleanup removes only its operation UUID staging", async () => {
  await withFixture(async ({ root, manifest, source, adapter }) => {
    const store = new InstallStore(join(root, "data"));
    const runner = new RelocatingZigRunner(store.dataRoot);
    runner.wrongVersionPhase = "staging";
    const operationId = "11111111-1111-4111-8111-111111111111";
    const foreignId = "22222222-2222-4222-8222-222222222222";
    const foreign = join(store.stagingRoot, foreignId);
    await Deno.mkdir(foreign, { recursive: true });
    await Deno.writeTextFile(join(foreign, "foreign.txt"), "foreign staging\n");
    await assertRejects(
      () =>
        installBuiltZig({
          ...pipelineInput(store, runner, manifest, source, adapter),
          operationId,
        }),
      ZigBinaryVerificationError,
    );
    assertEquals(await Deno.readTextFile(join(foreign, "foreign.txt")), "foreign staging\n");
    assert(!(await pathExists(join(store.stagingRoot, operationId))));
  });
});

Deno.test("full verification rejects wrong ELF, host target, compile, and run results", async () => {
  await withFixture(async ({ root, manifest, source, adapter }) => {
    const cases: Array<{
      readonly configure: (
        runner: RelocatingZigRunner,
        build: BuildManifest,
      ) => Promise<void> | void;
      readonly message: string;
    }> = [
      {
        configure: async (_runner, build) => {
          await Deno.writeTextFile(build.paths.executable, "not elf\n", { mode: 0o755 });
          Object.assign(build, {
            compiler: { version: VERSION, ...await fileMetadata(build.paths.executable) },
          });
        },
        message: "ELF64",
      },
      { configure: (runner) => void (runner.wrongTarget = true), message: "target" },
      { configure: (runner) => void (runner.failCompile = true), message: "compilation" },
      {
        configure: (runner) => void (runner.wrongCompiledElf = true),
        message: "ELF architecture",
      },
      { configure: (runner) => void (runner.failRun = true), message: "execution" },
    ];
    for (let index = 0; index < cases.length; index++) {
      const buildRoot = join(root, `failure-${index}`);
      const build = await createBuildFixture(buildRoot, manifest.recipe);
      const store = new InstallStore(join(root, `failure-data-${index}`));
      const runner = new RelocatingZigRunner(store.dataRoot);
      await cases[index].configure(runner, build);
      await assertRejects(
        () => installBuiltZig(pipelineInput(store, runner, build, source, adapter)),
        ZigBinaryVerificationError,
        cases[index].message,
      );
      assertEquals(await directoryNames(join(store.installsRoot, "zig")), []);
    }
  });
});

Deno.test({
  name: "symlinks in build output are rejected before execution or staging",
  ignore: Deno.build.os === "windows",
  async fn() {
    await withFixture(async ({ root, manifest, source, adapter }) => {
      const external = join(root, "external.txt");
      await Deno.writeTextFile(external, "outside\n");
      await Deno.symlink(external, join(manifest.paths.install, "share", "linked.txt"));
      const store = new InstallStore(join(root, "data"));
      const runner = new RelocatingZigRunner(store.dataRoot);
      await assertRejects(
        () => installBuiltZig(pipelineInput(store, runner, manifest, source, adapter)),
        ZigBinaryVerificationError,
        "symlink",
      );
      assertEquals(runner.requests.length, 0);
      assertEquals(await directoryNames(store.stagingRoot), []);
      assertEquals(await Deno.readTextFile(external), "outside\n");
    });
  },
});

Deno.test("pre-publish failures clean staging while created post-publish failures quarantine output", async () => {
  await withFixture(async ({ root, manifest, source, adapter }) => {
    const firstStore = new InstallStore(join(root, "first-data"));
    const firstRunner = new RelocatingZigRunner(firstStore.dataRoot);
    const failingProbe: RuntimeDependencyInspector = {
      contractVersion: 1,
      inspect() {
        return Promise.reject(new Error("dependency probe failed"));
      },
    };
    await assertRejects(
      () =>
        installBuiltZig({
          ...pipelineInput(firstStore, firstRunner, manifest, source, adapter),
          runtimeDependencyInspector: failingProbe,
        }),
      Error,
      "dependency probe failed",
    );
    assertEquals(await directoryNames(firstStore.stagingRoot), []);
    assertEquals(await directoryNames(join(firstStore.installsRoot, "zig")), []);

    const secondStore = new InstallStore(join(root, "second-data"));
    const secondRunner = new RelocatingZigRunner(secondStore.dataRoot);
    secondRunner.wrongVersionPhase = "promoted";
    const identity = await createBuiltZigInstallIdentity({
      buildManifest: manifest,
      source,
      adapter,
      host: HOST,
      expectedHostTarget: HOST_TARGET,
    });
    const installationId = await computeInstallationId(identity);
    await assertRejects(
      () => installBuiltZig(pipelineInput(secondStore, secondRunner, manifest, source, adapter)),
      ZigBinaryVerificationError,
      "version",
    );
    assertEquals(await directoryNames(secondStore.stagingRoot), []);
    assert(!(await pathExists(secondStore.installationPath("zig", installationId))));
    const quarantine = await directoryNames(join(secondStore.corruptRoot, "zig"));
    assertEquals(quarantine.length, 1);
    assert(quarantine[0].startsWith(`${installationId}-`));
    assert(await pathExists(manifest.paths.executable));
  });
});

Deno.test("runtime inspection runs at staging and final paths while cache/data roots stay separate", async () => {
  await withFixture(async ({ root, manifest, source, adapter }) => {
    const cacheRoot = join(root, "cache-filesystem");
    const relocatedBuild = await createBuildFixture(join(cacheRoot, "zig-build"), manifest.recipe);
    const dataRoot = join(root, "data-filesystem");
    const store = new InstallStore(dataRoot);
    const runner = new RelocatingZigRunner(dataRoot);
    const inspected: string[] = [];
    let rejectInspection = false;
    const probe: RuntimeDependencyInspector = {
      contractVersion: 1,
      inspect(input) {
        if (rejectInspection) return Promise.reject(new Error("runtime dependency changed"));
        inspected.push(input.installPath);
        return Promise.resolve({ linkage: "static" });
      },
    };
    const result = await installBuiltZig({
      ...pipelineInput(store, runner, relocatedBuild, source, adapter),
      runtimeDependencyInspector: probe,
    });
    assertStringIncludes(relocatedBuild.paths.root, cacheRoot);
    assertStringIncludes(result.root, dataRoot);
    assertEquals(result.manifest.runtime, { linkage: "static" });
    assert(inspected.some((path) => path.includes(join("installs", ".staging"))));
    assert(inspected.includes(join(result.root, "install")));
    await Deno.remove(cacheRoot, { recursive: true });
    assert((await Deno.stat(result.executablePath)).isFile);
    assertEquals(result.manifest.source.version, VERSION);
    rejectInspection = true;
    await assertRejects(
      () =>
        installBuiltZig({
          ...pipelineInput(store, runner, relocatedBuild, source, adapter),
          runtimeDependencyInspector: probe,
        }),
      Error,
      "runtime dependency changed",
    );
    assert(await pathExists(result.root));

    // Keep the fixture supplied by withFixture live until its own cleanup.
    assert(await pathExists(manifest.paths.executable));
  });
});

class RelocatingZigRunner implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];
  readonly dataRoot: string;
  wrongVersionPhase: "build" | "staging" | "promoted" | null = null;
  removeStdPhase: "build" | "staging" | "promoted" | null = null;
  wrongTarget = false;
  failCompile = false;
  wrongCompiledElf = false;
  failRun = false;

  constructor(dataRoot: string) {
    this.dataRoot = dataRoot;
  }

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push({ ...request, args: [...request.args] });
    const phase = this.phase(request.executable);
    if (request.args[0] === "version") {
      const version = this.wrongVersionPhase === phase ? "0.15.2" : VERSION;
      return result(`${version}\n`);
    }
    if (request.args[0] === "env") {
      const install = dirname(dirname(request.executable));
      const lib = join(install, "lib", "zig");
      if (this.removeStdPhase === phase) {
        await Deno.remove(join(lib, "std", "std.zig"));
      }
      const target = this.wrongTarget ? "aarch64-unknown-linux-gnu" : HOST_TARGET;
      return phase === "promoted"
        ? result(`.{\n  .lib_dir = ${JSON.stringify(lib)},\n  .target = "${target}",\n}\n`)
        : result(`${JSON.stringify({ lib_dir: lib, target })}\n`);
    }
    if (request.args[0] === "build-exe") {
      if (this.failCompile) return result("", "compile failed\n", 2);
      const output = request.args.find((arg) => arg.startsWith("-femit-bin="))?.slice(
        "-femit-bin=".length,
      );
      if (output === undefined) throw new Error("fake compile omitted output path");
      if (this.wrongCompiledElf) await Deno.writeTextFile(output, "wrong architecture\n");
      else await writeElf64X86_64(output);
      return result("compiled\n");
    }
    if (request.executable.endsWith("verify-host") && request.args.length === 0) {
      if (this.failRun) return result("", "run failed\n", 3);
      return result("", "zig-manager verification passed\n");
    }
    return result("", "unexpected fake command\n", 2);
  }

  private phase(executable: string): "build" | "staging" | "promoted" {
    if (executable.startsWith(join(this.dataRoot, "installs", ".staging"))) return "staging";
    if (executable.startsWith(join(this.dataRoot, "installs", "zig"))) return "promoted";
    return "build";
  }
}

function pipelineInput(
  store: InstallStore,
  runner: ProcessRunner,
  buildManifest: BuildManifest,
  source: ResolvedSource,
  adapter: ZigCMake21Adapter,
) {
  return {
    store,
    runner,
    buildManifest,
    source,
    adapter,
    host: HOST,
    expectedHostTarget: HOST_TARGET,
    platform: "linux" as const,
    runtimeDependencyInspector: STATIC_RUNTIME_INSPECTOR,
    cacheRoot: join(store.dataRoot, "cache"),
    now: () => new Date(CREATED),
  };
}

async function createBuildFixture(
  root: string,
  recipe: BuildManifest["recipe"],
): Promise<BuildManifest> {
  const paths = createBuildPaths(root, "linux");
  await Deno.mkdir(join(paths.install, "bin"), { recursive: true });
  await Deno.mkdir(join(paths.install, "lib", "zig", "std"), { recursive: true });
  await Deno.mkdir(join(paths.install, "share"), { recursive: true });
  await writeElf64X86_64(paths.executable, 0o751);
  await Deno.writeTextFile(
    join(paths.install, "lib", "zig", "std", "std.zig"),
    "pub const fixture = true;\n",
  );
  await Deno.writeTextFile(join(paths.install, "lib", "libfixture.so"), "fixture library\n");
  await Deno.writeTextFile(join(paths.install, "share", "mode.txt"), "mode fixture\n", {
    mode: 0o640,
  });
  if (Deno.build.os !== "windows") {
    await Deno.chmod(paths.executable, 0o751);
    await Deno.chmod(join(paths.install, "share", "mode.txt"), 0o640);
  }
  const configuration = buildIdentityFixture(recipe);
  const identity = await computeInstallationId(recipe);
  const metadata = await fileMetadata(paths.executable);
  const sourcePath = join(root, "source");
  const replace = (value: string) =>
    value.replaceAll("$SOURCE", sourcePath).replaceAll(
      "$BUILD",
      paths.root,
    );
  const commandEnvironment = Object.fromEntries(
    Object.entries(recipe.environment.variables).map(([key, value]) => [key, replace(value)]),
  );
  return validateBuildManifest({
    schemaVersion: 2,
    identity,
    recipe,
    source: {
      selector: VERSION,
      version: zigVersionMetadata(COMMIT, VERSION),
      commit: COMMIT,
    },
    hostTarget: HOST_TARGET,
    configuration,
    paths,
    commands: [recipe.cmake.configureArguments, recipe.cmake.buildArguments].map((args) => ({
      executable: recipe.tools.cmake.path,
      args: args.map(replace),
      cwd: sourcePath,
      env: commandEnvironment,
      clearEnv: true,
    })),
    compiler: { version: VERSION, size: metadata.size, sha256: metadata.sha256 },
    verified: true,
  });
}

function buildIdentityFixture(recipe: BuildManifest["recipe"]): BuildIdentityInput {
  return {
    sourceCommit: COMMIT,
    hostTarget: HOST_TARGET,
    options: recipe.build,
    tools: {
      cmake: toolIdentity(recipe.tools.cmake),
      cCompiler: toolIdentity(recipe.tools.cCompiler),
      cxxCompiler: toolIdentity(recipe.tools.cxxCompiler),
      llvmConfig: toolIdentity(recipe.tools.llvmConfig),
      clang: toolIdentity(recipe.tools.clang),
      lld: toolIdentity(recipe.tools.lld),
      generatorTool: toolIdentity(recipe.tools.generatorTool),
    },
  };
}

async function createRecipeFixture(
  root: string,
  source: ResolvedSource,
  adapter: ZigCMake21Adapter,
  bareTools = false,
  linkedLld = false,
): Promise<BuildManifest["recipe"]> {
  const prefix = await createDevelopmentFiles(root);
  if (linkedLld) {
    const alias = join(prefix, "lib", "liblldCommon.a");
    const physicalDirectory = join(root, "system-lib");
    const physical = join(physicalDirectory, "liblldCommon.so.21.1");
    await Deno.mkdir(physicalDirectory);
    await Deno.writeTextFile(physical, "fixture\n");
    await Deno.remove(alias);
    await Deno.symlink(physical, alias);
  }
  const executable = (name: string) => join(root, "tools", name);
  const probe = (name: string, version: string): ToolProbeResult => ({
    name,
    executable: bareTools ? name : executable(name),
    arguments: ["--version"],
    checkedCandidates: [bareTools ? name : executable(name)],
    explicit: true,
    available: true,
    version,
    supported: true,
    required: "fixture",
    message: null,
  });
  const toolchain: BuildToolchain = {
    cmake: probe("cmake", "3.30.0"),
    cCompiler: probe("cc", "15.0.0"),
    cxxCompiler: probe("c++", "15.0.0"),
    llvmConfig: probe("llvm-config", "21.1.0"),
    clang: probe("clang", "21.1.0"),
    lld: probe("ld.lld", "21.1.0"),
    generatorTool: probe("ninja", "15.0.0"),
    cmakePrefixPath: prefix,
    llvmIncludeDir: join(prefix, "include"),
    llvmLibDir: join(prefix, "lib"),
  };
  const config: ResolvedZigManagerConfig = {
    configPath: join(root, "config.json"),
    projectRoot: root,
    sourceRoot: join(root, "source"),
    repository: source.repository.url,
    provider: "codeberg",
    name: "zig",
    selector: source.requestedSelector,
    build: {
      strategy: "cmake",
      profile: "release",
      generator: "Ninja",
      cmakePrefixPath: prefix,
      jobs: 4,
      cpu: "baseline",
    },
    docs: { mega: false },
    tools: {
      cmake: null,
      cCompiler: null,
      cxxCompiler: null,
      llvmConfig: null,
      clang: null,
      lld: null,
      generatorTool: null,
    },
    warnings: { cacheBytes: null, movingSelectorMaxAgeHours: 24 },
  };
  return (await prepareZigBuildRecipe({
    source,
    sourceVersion: source.versionMetadata,
    adapter,
    host: HOST,
    config,
    toolchain,
    runner: new FakeProcessRunner(prefix),
    env: { PATH: join(root, "tools") },
    cwd: root,
  })).recipe;
}

function toolIdentity(tool: BuildManifest["recipe"]["tools"]["cmake"]) {
  return { path: tool.path, version: tool.version };
}

async function manifestForRecipe(
  manifest: BuildManifest,
  recipe: BuildManifest["recipe"],
): Promise<BuildManifest> {
  return validateBuildManifest({
    ...manifest,
    identity: await computeInstallationId(recipe),
    recipe,
    hostTarget: recipe.host.denoTarget,
    configuration: buildIdentityFixture(recipe),
  });
}

function sourceFixture(): ResolvedSource {
  return {
    component: "zig",
    repository: {
      identity: "codeberg/zig",
      url: "https://codeberg.org/ziglang/zig.git",
    },
    requestedSelector: VERSION,
    resolvedRef: { kind: "tag", value: VERSION },
    commit: COMMIT,
    version: VERSION,
    versionMetadata: zigVersionMetadata(COMMIT, VERSION),
    resolvedAt: CREATED,
  };
}

async function withFixture(
  action: (fixture: {
    readonly root: string;
    readonly manifest: BuildManifest;
    readonly source: ResolvedSource;
    readonly adapter: ZigCMake21Adapter;
  }) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-install-pipeline-" });
  try {
    const source = sourceFixture();
    const adapter = new ZigCMake21Adapter();
    const recipe = await createRecipeFixture(root, source, adapter);
    await action({
      root,
      manifest: await createBuildFixture(join(root, "cache", "builds", "zig"), recipe),
      source,
      adapter,
    });
  } finally {
    await remove(root);
  }
}

async function directoryNames(path: string): Promise<string[]> {
  const names = [];
  for await (const entry of Deno.readDir(path)) names.push(entry.name);
  names.sort();
  return names;
}

async function remove(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound)) throw cause;
  }
}

function result(stdout = "", stderr = "", code = 0): ProcessResult {
  return {
    success: code === 0,
    code,
    signal: null,
    stdout,
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}
