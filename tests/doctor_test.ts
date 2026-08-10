import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { ProcessRequest, ProcessResult } from "../src/mod.ts";
import { ZigManager } from "../src/mod.ts";
import {
  cleanup,
  createDevelopmentFiles,
  FakeProcessRunner,
  FakeSourceRef,
  testConfig,
} from "./test_helpers.ts";

Deno.test("doctor probes source-selected prerequisites without invoking Git", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-doctor-" });
  try {
    const prefix = await createDevelopmentFiles(root);
    const runner = new FakeProcessRunner(prefix);
    const manager = new ZigManager({
      projectRoot: root,
      config: testConfig(root, prefix),
      sourceRef: new FakeSourceRef(root),
      runner,
      platform: "linux",
    });
    await manager.use("0.16");
    const result = await manager.doctor();
    assertEquals(result.ok, true);
    assertEquals(result.toolchain.cmake.version, "3.30.0");
    assertEquals(result.toolchain.llvmConfig.version, "21.1.0");
    assertEquals(result.toolchain.clang.version, "21.1.0");
    assertEquals(result.toolchain.lld.version, "21.1.0");
    assertEquals(result.toolchain.cmakePrefixPath, prefix);
    assertEquals(
      runner.requests.some((request) => /(^|[/\\])git(?:\.exe)?$/.test(request.executable)),
      false,
    );
  } finally {
    await cleanup(root);
  }
});

Deno.test("doctor reports each incompatible version line precisely", async () => {
  const cases = [
    { field: "cmake" as const, version: "3.14.9", component: "cmake" },
    { field: "llvm" as const, version: "20.0.0", component: "LLVM" },
    { field: "clang" as const, version: "22.0.0", component: "Clang" },
    { field: "lld" as const, version: "19.0.0", component: "LLD" },
  ];
  for (const testCase of cases) {
    const root = await Deno.makeTempDir({ prefix: `zig-manager-doctor-${testCase.field}-` });
    try {
      const prefix = await createDevelopmentFiles(root);
      const runner = new FakeProcessRunner(prefix);
      runner.toolVersions[testCase.field] = testCase.version;
      const manager = new ZigManager({
        projectRoot: root,
        config: testConfig(root, prefix),
        sourceRef: new FakeSourceRef(root),
        runner,
        platform: "linux",
      });
      await manager.use("0.16");
      const result = await manager.doctor();
      assertEquals(result.ok, false);
      assert(
        result.issues.some((issue) =>
          issue.component === testCase.component && issue.code === "VERSION"
        ),
      );
    } finally {
      await cleanup(root);
    }
  }
});

Deno.test("doctor does not fall back when an explicit compiler path is missing", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-doctor-missing-" });
  try {
    const prefix = await createDevelopmentFiles(root);
    const config = testConfig(root, prefix);
    const missing = config.tools?.cCompiler ?? "";
    class MissingRunner extends FakeProcessRunner {
      override run(request: ProcessRequest): Promise<ProcessResult> {
        if (request.executable === missing) {
          return Promise.reject(new Deno.errors.NotFound("missing"));
        }
        return super.run(request);
      }
    }
    const runner = new MissingRunner(prefix);
    const manager = new ZigManager({
      projectRoot: root,
      config,
      sourceRef: new FakeSourceRef(root),
      runner,
      platform: "linux",
    });
    await manager.use("0.16");
    const result = await manager.doctor();
    assertEquals(result.ok, false);
    assert(
      result.issues.some((issue) => issue.component === "C compiler" && issue.code === "MISSING"),
    );
    assertEquals(runner.requests.some((request) => request.executable === "cc"), false);
  } finally {
    await cleanup(root);
  }
});

Deno.test("doctor rejects missing LLVM, Clang, or LLD development files", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-doctor-dev-" });
  try {
    const prefix = join(root, "toolchain");
    await Deno.mkdir(join(prefix, "include"), { recursive: true });
    await Deno.mkdir(join(prefix, "lib"), { recursive: true });
    const manager = new ZigManager({
      projectRoot: root,
      config: testConfig(root, prefix),
      sourceRef: new FakeSourceRef(root),
      runner: new FakeProcessRunner(prefix),
      platform: "linux",
    });
    await manager.use("0.16");
    const result = await manager.doctor();
    assertEquals(result.ok, false);
    assert(result.issues.some((issue) => issue.code === "DEVELOPMENT_FILES"));
  } finally {
    await cleanup(root);
  }
});

Deno.test("doctor rejects LLVM builds missing an upstream-required target", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-doctor-targets-" });
  try {
    const prefix = await createDevelopmentFiles(root);
    const runner = new FakeProcessRunner(prefix);
    runner.llvmTargets = "AArch64 X86 WebAssembly";
    const manager = new ZigManager({
      projectRoot: root,
      config: testConfig(root, prefix),
      sourceRef: new FakeSourceRef(root),
      runner,
      platform: "linux",
    });
    await manager.use("0.16");
    const result = await manager.doctor();
    assertEquals(result.ok, false);
    assert(
      result.issues.some((issue) =>
        issue.component === "LLVM targets" && issue.message.includes("AMDGPU")
      ),
    );
  } finally {
    await cleanup(root);
  }
});
