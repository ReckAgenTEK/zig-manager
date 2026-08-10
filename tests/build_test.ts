import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { computeBuildIdentity, createBuildPaths, parseZigEnvLibDir } from "../src/build.ts";
import { ZigBinaryVerificationError, ZigCMake21Adapter, ZigManager } from "../src/mod.ts";
import { readZigManagerState } from "../src/state.ts";
import type {
  BuildIdentityInput,
  BuildToolchain,
  ProcessResult,
  ToolProbeResult,
} from "../src/types.ts";
import {
  cleanup,
  COMMIT_A,
  createDevelopmentFiles,
  FakeProcessRunner,
  FakeSourceRef,
  testConfig,
} from "./test_helpers.ts";

Deno.test("build identity is deterministic and changes for every relevant input", async () => {
  const base = identityFixture();
  const first = await computeBuildIdentity(base);
  assertEquals(first, await computeBuildIdentity(structuredClone(base)));
  const variants: BuildIdentityInput[] = [
    { ...base, sourceCommit: "b".repeat(40) },
    { ...base, hostTarget: "aarch64-apple-darwin" },
    { ...base, options: { ...base.options, profile: "debug", cmakeBuildType: "Debug" } },
    { ...base, options: { ...base.options, generator: "Unix Makefiles" } },
    { ...base, tools: { ...base.tools, cmake: { path: "/new/cmake", version: "3.30.0" } } },
    { ...base, tools: { ...base.tools, llvmConfig: { path: "/llvm", version: "21.2.0" } } },
  ];
  for (const variant of variants) assertNotEquals(await computeBuildIdentity(variant), first);
});

Deno.test("Zig environment parsing accepts Zig 0.16 ZON and legacy JSON", () => {
  assertEquals(
    parseZigEnvLibDir('.{\n    .lib_dir = "C:\\\\managed\\\\lib\\\\zig",\n}\n'),
    "C:\\managed\\lib\\zig",
  );
  assertEquals(parseZigEnvLibDir('{"lib_dir":"/managed/lib/zig"}\n'), "/managed/lib/zig");
});

Deno.test("LLVM 21 adapter constructs explicit CMake commands across host path variants", () => {
  const adapter = new ZigCMake21Adapter();
  for (const platform of ["linux", "darwin", "windows"] as const) {
    const separator = platform === "windows" ? "\\" : "/";
    const root = platform === "windows"
      ? "C:\\managed\\build"
      : `${separator}managed${separator}build`;
    const paths = createBuildPaths(root, platform);
    const commands = adapter.createBuildCommands({
      platform,
      sourcePath: platform === "windows" ? "C:\\source\\zig" : "/source/zig",
      version: {
        kind: "release",
        base: "0.16.0",
        text: "0.16.0",
        taggedAncestor: "0.16.0",
        commitsAfterTag: 0,
        commitAbbreviation: COMMIT_A.slice(0, 9),
      },
      paths,
      options: {
        strategy: "cmake",
        profile: "release",
        cmakeBuildType: "Release",
        generator: "Ninja",
        jobs: 12,
        cmakePrefixPath: platform === "windows" ? "C:\\LLVM" : "/llvm21",
      },
      toolchain: toolchainFixture(platform),
    });
    assertEquals(commands.length, 2);
    assertEquals(commands[0].args.slice(0, 6), [
      "-S",
      platform === "windows" ? "C:\\source\\zig" : "/source/zig",
      "-B",
      paths.cmakeBuild,
      "-G",
      "Ninja",
    ]);
    assert(commands[0].args.includes(`-DCMAKE_INSTALL_PREFIX=${paths.install}`));
    assert(commands[0].args.includes("-DZIG_USE_LLVM_CONFIG=ON"));
    assert(commands[0].args.includes("-DZIG_VERSION=0.16.0"));
    assertEquals(commands[1].args.slice(-2), ["--parallel", "12"]);
    assertStringIncludes(
      adapter.executableCandidates(paths.install, platform)[0],
      platform === "windows" ? "zig.exe" : "zig",
    );
  }
});

Deno.test("Linux docs commands disable core handling without changing expected signals", () => {
  const adapter = new ZigCMake21Adapter();
  const context = {
    executable: "/managed/zig",
    version: {
      kind: "release" as const,
      base: "0.16.0",
      text: "0.16.0",
      taggedAncestor: "0.16.0",
      commitsAfterTag: 0,
      commitAbbreviation: COMMIT_A.slice(0, 9),
    },
    checkoutPath: "/source/zig",
    prefix: "/output",
    localCache: "/cache/local",
    globalCache: "/cache/global",
  };
  const linux = adapter.createDocsCommand({ ...context, platform: "linux" });
  assertEquals(linux.executable, "prlimit");
  assertEquals(linux.args.slice(0, 5), [
    "--core=1:",
    "--",
    "/managed/zig",
    "build",
    "docs",
  ]);
  const darwin = adapter.createDocsCommand({ ...context, platform: "darwin" });
  assertEquals(darwin.executable, "/managed/zig");
  assertEquals(darwin.args.slice(0, 2), ["build", "docs"]);
});

Deno.test("managed build publishes only after compiler and lib verification", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-build-" });
  try {
    const prefix = await createDevelopmentFiles(root);
    const sourceRef = new FakeSourceRef(root);
    const runner = new FakeProcessRunner(prefix);
    const manager = new ZigManager({
      projectRoot: root,
      config: testConfig(root, prefix),
      sourceRef,
      runner,
      hostTarget: "x86_64-unknown-linux-gnu",
      platform: "linux",
    });
    await manager.use("0.16");
    const built = await manager.build();
    assertEquals(built.manifest.source.commit, COMMIT_A);
    assertEquals(built.manifest.compiler.version, "0.16.0");
    assertStringIncludes(
      built.manifest.paths.root,
      `/builds/${COMMIT_A}/x86_64-unknown-linux-gnu/release/`,
    );
    assertEquals(await manager.path(), built.manifest.paths.executable);
    const state = await readZigManagerState(sourceRef.repositoryHome);
    assertEquals(state.activeBuild?.identity, built.manifest.identity);
    assertEquals(
      runner.requests.some((request) => /(^|[/\\])git(?:\.exe)?$/.test(request.executable)),
      false,
    );
    const reused = await manager.build();
    assertEquals(reused.reused, true);
    assertStringIncludes(
      await Deno.readTextFile(join(built.manifest.paths.logs, "configure.stdout.log")),
      "configured",
    );
    assertStringIncludes(
      await Deno.readTextFile(join(built.manifest.paths.logs, "build.stdout.log")),
      "built",
    );
    await Deno.writeTextFile(built.manifest.paths.executable, "tampered\n");
    await assertRejects(() => manager.path(), ZigBinaryVerificationError, "hash or size");
  } finally {
    await cleanup(root);
  }
});

Deno.test("wrong Zig version never selects or publishes a build", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-build-version-" });
  try {
    const prefix = await createDevelopmentFiles(root);
    const sourceRef = new FakeSourceRef(root);
    const runner = new FakeProcessRunner(prefix);
    runner.wrongZigVersion = true;
    const manager = new ZigManager({
      projectRoot: root,
      config: testConfig(root, prefix),
      sourceRef,
      runner,
      platform: "linux",
    });
    await manager.use("0.16");
    await assertRejects(() => manager.build(), ZigBinaryVerificationError, "version");
    assertEquals((await readZigManagerState(sourceRef.repositoryHome)).activeBuild, null);
  } finally {
    await cleanup(root);
  }
});

Deno.test("missing managed lib never selects or publishes a build", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-build-lib-" });
  try {
    const prefix = await createDevelopmentFiles(root);
    const sourceRef = new FakeSourceRef(root);
    const runner = new FakeProcessRunner(prefix);
    runner.omitLib = true;
    const manager = new ZigManager({
      projectRoot: root,
      config: testConfig(root, prefix),
      sourceRef,
      runner,
      platform: "linux",
    });
    await manager.use("0.16");
    await assertRejects(() => manager.build(), ZigBinaryVerificationError, "lib directory");
    assertEquals((await readZigManagerState(sourceRef.repositoryHome)).activeBuild, null);
  } finally {
    await cleanup(root);
  }
});

Deno.test("run returns the managed child's exact exit and signal status", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-run-" });
  try {
    const prefix = await createDevelopmentFiles(root);
    const sourceRef = new FakeSourceRef(root);
    const runner = new FakeProcessRunner(prefix);
    const manager = new ZigManager({
      projectRoot: root,
      config: testConfig(root, prefix),
      sourceRef,
      runner,
      platform: "linux",
    });
    await manager.use("0.16");
    const built = await manager.build();
    runner.runExit = processResult(37, null);
    const exited = await manager.run(["fixture-exit"]);
    assertEquals(exited.code, 37);
    assertEquals(exited.signal, null);
    assertEquals(runner.requests.at(-1)?.executable, built.manifest.paths.executable);

    runner.runExit = processResult(143, "SIGTERM");
    const signaled = await manager.run(["fixture-signal"]);
    assertEquals(signaled.code, 143);
    assertEquals(signaled.signal, "SIGTERM");
  } finally {
    await cleanup(root);
  }
});

function identityFixture(): BuildIdentityInput {
  return {
    sourceCommit: COMMIT_A,
    hostTarget: "x86_64-unknown-linux-gnu",
    options: {
      strategy: "cmake",
      profile: "release",
      cmakeBuildType: "Release",
      generator: "Ninja",
      jobs: 4,
      cmakePrefixPath: "/llvm21",
    },
    tools: {
      cmake: { path: "/cmake", version: "3.30.0" },
      cCompiler: { path: "/cc", version: "15.0.0" },
      cxxCompiler: { path: "/c++", version: "15.0.0" },
      llvmConfig: { path: "/llvm-config", version: "21.1.0" },
      clang: { path: "/clang", version: "21.1.0" },
      lld: { path: "/ld.lld", version: "21.1.0" },
      generatorTool: { path: "/ninja", version: "1.12.0" },
    },
  };
}

function toolchainFixture(platform: "linux" | "darwin" | "windows"): BuildToolchain {
  const root = platform === "windows" ? "C:\\tools" : "/tools";
  const tool = (name: string, version: string): ToolProbeResult => ({
    name,
    executable: join(root, name),
    available: true,
    version,
    supported: true,
    required: "fixture",
    message: null,
  });
  return {
    cmake: tool("cmake", "3.30.0"),
    cCompiler: tool("cc", "15.0.0"),
    cxxCompiler: tool("c++", "15.0.0"),
    llvmConfig: tool("llvm-config", "21.1.0"),
    clang: tool("clang", "21.1.0"),
    lld: tool("ld.lld", "21.1.0"),
    generatorTool: tool("ninja", "1.12.0"),
    cmakePrefixPath: join(root, "llvm"),
    llvmIncludeDir: join(root, "llvm", "include"),
    llvmLibDir: join(root, "llvm", "lib"),
  };
}

function processResult(code: number, signal: Deno.Signal | null): ProcessResult {
  return {
    success: code === 0 && signal === null,
    code,
    signal,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}
