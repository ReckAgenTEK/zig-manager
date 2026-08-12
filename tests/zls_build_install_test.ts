import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { dirname, join } from "@std/path";
import {
  validateZigBuildRecipe,
  ZLS_INSTALL_VERIFIER_CONTRACT_VERSION,
} from "../src/build_recipe.ts";
import { canonicalJson, fileMetadata, pathExists } from "../src/filesystem.ts";
import {
  computeInstallationId,
  type InstalledObject,
  type InstallManifestV3,
  InstallStore,
  type ResolvedSource,
  type RuntimeDependencyInspector,
  validateInstallManifest,
} from "../src/install_store.ts";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/types.ts";
import { buildManagedZls, createZlsBuildRecipe, prepareZlsBuildRecipe } from "../src/zls_build.ts";
import {
  installBuiltZls,
  type ZlsLspProtocolVerifier,
  ZlsVerificationError,
} from "../src/zls_install_pipeline.ts";
import {
  type ResolvedZlsSource,
  validateResolvedZlsSource,
  ZLS_SOURCE_REPOSITORY_IDENTITY,
  ZLS_SOURCE_REPOSITORY_URL,
} from "../src/zls_source_workspace.ts";
import { writeElf64X86_64, zigVersionMetadata } from "./test_helpers.ts";

const ZIG_COMMIT = "a".repeat(40);
const ZLS_COMMIT = "b".repeat(40);
const OTHER_ZLS_COMMIT = "c".repeat(40);
const HOST = {
  os: "linux",
  architecture: "x86_64",
  abi: "gnu",
  denoTarget: "x86_64-unknown-linux-gnu",
} as const;
const CREATED = "2026-08-11T12:00:00.000Z";
const STATIC_RUNTIME: RuntimeDependencyInspector = {
  contractVersion: 1,
  inspect: () => Promise.resolve({ linkage: "static" }),
};

Deno.test("canonical ZLS identity changes on source, Zig dependency, and every build option", async () => {
  await withFixture(async ({ root, zig, source }) => {
    const prepared = await prepareZlsBuildRecipe({
      source,
      host: HOST,
      zig,
      profile: "release-safe",
      jobs: 4,
    });
    const baseId = prepared.installationId;
    const otherSource = zlsSource(OTHER_ZLS_COMMIT);
    const sourceRecipe = createZlsBuildRecipe({
      source: otherSource,
      host: HOST,
      zigInstallationId: zig.manifest.installationId,
      zigExecutable: prepared.recipe.zig.executable,
      profile: "release-safe",
      jobs: 4,
    });
    const dependencyRecipe = createZlsBuildRecipe({
      source,
      host: HOST,
      zigInstallationId: "d".repeat(64),
      zigExecutable: prepared.recipe.zig.executable,
      profile: "release-safe",
      jobs: 4,
    });
    const profileRecipe = createZlsBuildRecipe({
      source,
      host: HOST,
      zigInstallationId: zig.manifest.installationId,
      zigExecutable: prepared.recipe.zig.executable,
      profile: "release-fast",
      jobs: 4,
    });
    const jobsRecipe = createZlsBuildRecipe({
      source,
      host: HOST,
      zigInstallationId: zig.manifest.installationId,
      zigExecutable: prepared.recipe.zig.executable,
      profile: "release-safe",
      jobs: 8,
    });

    for (const recipe of [sourceRecipe, dependencyRecipe, profileRecipe, jobsRecipe]) {
      assertNotEquals(await computeInstallationId(recipe), baseId);
    }
    assertEquals(prepared.recipe.build.optimize, "ReleaseSafe");
    assertEquals(profileRecipe.build.optimize, "ReleaseFast");
    assertEquals(prepared.recipe.dependencies.length, 1);
    assert(!canonicalJson(prepared.recipe).includes(root));
    assertEquals(Object.keys(prepared.recipe.zig.executable).sort(), [
      "installPath",
      "sha256",
      "size",
    ]);
  });
});

Deno.test("ZLS builds with the exact Zig and immutable install reuses after cache deletion", async () => {
  await withFixture(async ({ root, store, zig, source }) => {
    const runner = new FakeZlsRunner(zig.executablePath, source.versionMetadata.versionString);
    const protocol = new FakeProtocolVerifier();
    const prepared = await prepareZlsBuildRecipe({
      source,
      host: HOST,
      zig,
      profile: "release-safe",
      jobs: 4,
    });
    const sourcePath = join(root, "source", "zls");
    const buildRoot = join(root, "cache", "builds");
    const logRoot = join(root, "cache", "logs");
    await Deno.mkdir(sourcePath, { recursive: true });
    const built = await buildManagedZls({
      recipe: prepared.recipe,
      installationId: prepared.installationId,
      sourcePath,
      zig,
      runner,
      buildRoot,
      logRoot,
      operationId: "11111111-1111-4111-8111-111111111111",
    });
    assertEquals(built.reused, false);
    const buildRequest = runner.requests.find((request) => request.args[0] === "build");
    assert(buildRequest !== undefined);
    assertEquals(buildRequest.executable, zig.executablePath);
    assertEquals(buildRequest.clearEnv, true);
    assertEquals(buildRequest.cwd, sourcePath);
    assertEquals(buildRequest.env?.PATH, dirname(zig.executablePath));
    assertStringIncludes(buildRequest.env?.HOME ?? "", join(".staging", "11111111"));
    assert(buildRequest.args.includes(`-Dversion-string=${source.versionMetadata.versionString}`));
    assert(buildRequest.args.includes("-Doptimize=ReleaseSafe"));
    assert(buildRequest.args.includes("-j4"));
    assertEquals(runner.buildCount, 1);

    const installed = await installBuiltZls({
      buildManifest: built.manifest,
      source,
      zig,
      store,
      runner,
      runtimeDependencyInspector: STATIC_RUNTIME,
      protocolVerifier: protocol,
      cacheRoot: join(root, "cache"),
      platform: "linux",
      operationId: "22222222-2222-4222-8222-222222222222",
      now: () => new Date(CREATED),
    });
    assertEquals(installed.reused, false);
    assertEquals(installed.copied, true);
    assertEquals(installed.manifest.dependencies, [{
      component: "zig",
      installationId: zig.manifest.installationId,
    }]);
    assertEquals(installed.manifest.paths, {
      executable: "install/bin/zls",
      libraries: [],
    });
    assertEquals(protocol.calls, 2);

    await Deno.remove(buildRoot, { recursive: true });
    assert(!(await pathExists(built.manifest.paths.executable)));
    const reused = await installBuiltZls({
      buildManifest: built.manifest,
      source,
      zig,
      store,
      runner,
      runtimeDependencyInspector: STATIC_RUNTIME,
      protocolVerifier: protocol,
      cacheRoot: join(root, "cache"),
      platform: "linux",
      operationId: "33333333-3333-4333-8333-333333333333",
    });
    assertEquals(reused.reused, true);
    assertEquals(reused.copied, false);
    assertEquals(reused.stagedVerification, null);
    assertEquals(runner.buildCount, 1);
    assert(await pathExists(reused.executablePath));

    runner.wrongVersion = true;
    await assertRejects(
      () =>
        installBuiltZls({
          buildManifest: built.manifest,
          source,
          zig,
          store,
          runner,
          runtimeDependencyInspector: STATIC_RUNTIME,
          protocolVerifier: protocol,
          cacheRoot: join(root, "cache"),
          platform: "linux",
        }),
      ZlsVerificationError,
      "version",
    );
    runner.wrongVersion = false;

    const wrongHash = {
      ...built.manifest,
      executable: { ...built.manifest.executable, sha256: "f".repeat(64) },
    };
    await assertRejects(
      () =>
        installBuiltZls({
          buildManifest: wrongHash,
          source,
          zig,
          store,
          runner,
          runtimeDependencyInspector: STATIC_RUNTIME,
          protocolVerifier: protocol,
          cacheRoot: join(root, "cache"),
          platform: "linux",
        }),
      ZlsVerificationError,
      "recipe",
    );

    const wrongZig: InstalledObject = {
      ...zig,
      manifest: { ...zig.manifest, installationId: "e".repeat(64) },
    };
    await assertRejects(
      () =>
        installBuiltZls({
          buildManifest: built.manifest,
          source,
          zig: wrongZig,
          store,
          runner,
          runtimeDependencyInspector: STATIC_RUNTIME,
          protocolVerifier: protocol,
          cacheRoot: join(root, "cache"),
          platform: "linux",
        }),
      TypeError,
      "wrong Zig",
    );
    assertEquals(runner.buildCount, 1);
  });
});

class FakeProtocolVerifier implements ZlsLspProtocolVerifier {
  readonly contractVersion = ZLS_INSTALL_VERIFIER_CONTRACT_VERSION;
  calls = 0;

  verify() {
    this.calls++;
    return Promise.resolve({ initialized: true as const, shutdown: true as const });
  }
}

class FakeZlsRunner implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];
  readonly zigExecutable: string;
  readonly version: string;
  buildCount = 0;
  wrongVersion = false;

  constructor(zigExecutable: string, version: string) {
    this.zigExecutable = zigExecutable;
    this.version = version;
  }

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push({
      ...request,
      args: [...request.args],
      env: request.env === undefined ? undefined : { ...request.env },
    });
    if (request.executable === this.zigExecutable && request.args[0] === "build") {
      this.buildCount++;
      const prefixIndex = request.args.indexOf("--prefix");
      if (prefixIndex < 0) throw new Error("fake build did not receive --prefix");
      const executable = join(request.args[prefixIndex + 1], "bin", "zls");
      await Deno.mkdir(dirname(executable), { recursive: true });
      await writeElf64X86_64(executable);
      return await fakeResult(request, "built ZLS\n");
    }
    if (request.args.length === 1 && request.args[0] === "--version") {
      return await fakeResult(request, `${this.wrongVersion ? "0.15.0" : this.version}\n`);
    }
    return await fakeResult(request, "", "unexpected command\n", 2);
  }
}

async function fakeResult(
  request: ProcessRequest,
  stdout = "",
  stderr = "",
  code = 0,
): Promise<ProcessResult> {
  const encoder = new TextEncoder();
  if (stdout && request.onStdout !== undefined) await request.onStdout(encoder.encode(stdout));
  if (stderr && request.onStderr !== undefined) await request.onStderr(encoder.encode(stderr));
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

function zlsSource(commit = ZLS_COMMIT): ResolvedZlsSource {
  const version = {
    kind: "release" as const,
    declaredVersion: "0.16.0",
    base: "0.16.0",
    text: "0.16.0",
    versionString: "0.16.0",
    taggedAncestor: "0.16.0",
    commitsAfterTag: 0 as const,
    commitAbbreviation: commit.slice(0, 9),
  };
  return validateResolvedZlsSource({
    component: "zls",
    repository: {
      identity: ZLS_SOURCE_REPOSITORY_IDENTITY,
      url: ZLS_SOURCE_REPOSITORY_URL,
    },
    requestedSelector: "0.16.0",
    resolvedRef: { kind: "tag", value: "0.16.0" },
    commit,
    version: version.text,
    versionMetadata: version,
    resolvedAt: CREATED,
  });
}

async function publishZig(store: InstallStore): Promise<InstalledObject> {
  const source: ResolvedSource = {
    component: "zig",
    repository: {
      identity: "codeberg/zig",
      url: "https://codeberg.org/ziglang/zig.git",
    },
    requestedSelector: "0.16.0",
    resolvedRef: { kind: "tag", value: "0.16.0" },
    commit: ZIG_COMMIT,
    version: "0.16.0",
    versionMetadata: zigVersionMetadata(ZIG_COMMIT, "0.16.0"),
    resolvedAt: CREATED,
  };
  const tool = (name: string) => ({
    path: `/fixture/${name}`,
    version: "1.0.0",
    size: 1,
    sha256: "1".repeat(64),
    queries: [{ args: ["--version"], stdout: `${name} 1.0.0\n`, stderr: "" }],
  });
  const recipe = validateZigBuildRecipe({
    schemaVersion: 1,
    component: "zig",
    source: {
      repository: source.repository,
      commit: source.commit,
      version: source.versionMetadata,
    },
    adapter: { id: "fixture", buildContractVersion: 1, verifierContractVersion: 2 },
    host: HOST,
    cpuPolicy: "baseline",
    build: {
      strategy: "cmake",
      profile: "release",
      cmakeBuildType: "Release",
      generator: "Ninja",
      jobs: 4,
      cmakePrefixPath: "/fixture/llvm",
      cpu: "baseline",
    },
    cmake: {
      configureArguments: [
        "-S",
        "$SOURCE",
        "-B",
        "$BUILD/cmake-build",
        "-G",
        "Ninja",
        "-DCMAKE_INSTALL_PREFIX=$BUILD/install",
        "-DZIG_EXTRA_BUILD_ARGS=-Dno-langref",
      ],
      buildArguments: ["--build", "$BUILD/cmake-build"],
    },
    environment: {
      clearEnv: true,
      inherited: [],
      variables: {
        CFLAGS: "",
        CXXFLAGS: "",
        CPPFLAGS: "",
        LDFLAGS: "",
        CPATH: "",
        C_INCLUDE_PATH: "",
        CPLUS_INCLUDE_PATH: "",
        LIBRARY_PATH: "",
        CMAKE_PREFIX_PATH: "",
        PKG_CONFIG_PATH: "",
        LANG: "C",
        LC_ALL: "C",
        PATH: "/fixture",
        HOME: "$BUILD/home",
        TMPDIR: "$BUILD/tmp",
        XDG_CACHE_HOME: "$BUILD/cache/xdg",
        ZIG_GLOBAL_CACHE_DIR: "$BUILD/cache/zig-global",
        ZIG_LOCAL_CACHE_DIR: "$BUILD/cache/zig-local",
      },
    },
    tools: {
      cmake: tool("cmake"),
      cCompiler: tool("cc"),
      cxxCompiler: tool("cxx"),
      llvmConfig: tool("llvm-config"),
      clang: tool("clang"),
      lld: tool("lld"),
      generatorTool: tool("ninja"),
    },
    development: {
      files: [{ path: "/fixture/header.h", size: 1, sha256: "2".repeat(64) }],
      packages: [{
        name: "fixture-devel",
        version: "1.0.0",
        query: { args: ["-Q", "fixture-devel"], stdout: "fixture-devel 1.0.0\n", stderr: "" },
      }],
    },
    dependencies: [],
  });
  const installationId = await computeInstallationId(recipe);
  const staging = await store.createStaging("zig", installationId);
  const executablePath = join(staging.installPath, "bin", "zig");
  await Deno.mkdir(dirname(executablePath), { recursive: true });
  await writeElf64X86_64(executablePath);
  const metadata = await fileMetadata(executablePath);
  const manifest: InstallManifestV3 = validateInstallManifest({
    schemaVersion: 3,
    installationId,
    component: "zig",
    identity: recipe,
    source,
    paths: { executable: "install/bin/zig", libraries: [] },
    executable: {
      version: source.version,
      hostTarget: HOST.denoTarget,
      size: metadata.size,
      sha256: metadata.sha256,
      format: {
        format: "elf",
        class: 64,
        endianness: "little",
        machine: "x86_64",
        type: "executable",
        dynamicallyLinked: false,
        interpreter: null,
      },
    },
    runtime: { linkage: "static" },
    commands: [],
    dependencies: [],
    createdAt: CREATED,
    verifierContractVersion: 2,
  });
  return await store.publish(staging, manifest);
}

async function withFixture(
  action: (fixture: {
    readonly root: string;
    readonly store: InstallStore;
    readonly zig: InstalledObject;
    readonly source: ResolvedZlsSource;
  }) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-zls-build-install-" });
  try {
    const store = new InstallStore(join(root, "data"));
    await action({ root, store, zig: await publishZig(store), source: zlsSource() });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}
