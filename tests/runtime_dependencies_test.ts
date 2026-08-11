import { assertEquals, assertRejects } from "@std/assert";
import { join, resolve } from "@std/path";
import { LinuxRuntimeDependencyInspector } from "../src/runtime_dependencies.ts";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../src/types.ts";
import { cleanup, writeElf64X86_64 } from "./test_helpers.ts";

Deno.test("Linux runtime inspector records physical interpreter and dependency fingerprints", async () => {
  await withRuntimeFixture(async ({ root, cacheRoot, executable, interpreter, library }) => {
    const libraryAlias = join(root, "libfixture.so.1");
    await Deno.symlink(library, libraryAlias);
    const runner = new LddRunner(
      `linux-vdso.so.1 (0x1)\nlibfixture.so => ${libraryAlias} (0x2)\n${interpreter} (0x3)\n`,
    );
    const inspector = new LinuxRuntimeDependencyInspector({ runner });
    const runtime = await inspector.inspect({
      executablePath: executable,
      installPath: join(root, "install"),
      cacheRoot,
      platform: "linux",
    });
    if (runtime.linkage !== "dynamic") throw new Error("expected dynamic runtime");
    assertEquals(runtime.interpreter.name, "interpreter");
    assertEquals(runtime.interpreter.path, interpreter);
    assertEquals(runtime.dependencies.map((dependency) => dependency.name), ["libfixture.so"]);
    assertEquals(runtime.dependencies[0].path, library);
    assertEquals(runtime.dependencies[0].sha256.length, 64);
    assertEquals(runner.requests.length, 1);
    assertEquals(runner.requests[0].executable, "/usr/bin/ldd");
    assertEquals(runner.requests[0].args, [executable]);
    assertEquals(runner.requests[0].clearEnv, true);
    assertEquals(runner.requests[0].maxDiagnosticBytes, 1024 * 1024);
  });
});

Deno.test("Linux runtime inspector represents static linkage without invoking ldd", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-runtime-static-" });
  try {
    const executable = join(root, "zig");
    await writeElf64X86_64(executable);
    const runner = new LddRunner("unexpected\n");
    const runtime = await new LinuxRuntimeDependencyInspector({ runner }).inspect({
      executablePath: executable,
      installPath: root,
      cacheRoot: join(root, "cache"),
      platform: "linux",
    });
    assertEquals(runtime, { linkage: "static" });
    assertEquals(runner.requests, []);
  } finally {
    await cleanup(root);
  }
});

Deno.test("Linux runtime inspector records the physical interpreter behind a parent alias", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-runtime-interpreter-alias-" });
  try {
    const physicalDirectory = join(root, "physical-system");
    const aliasDirectory = join(root, "system-alias");
    const install = join(root, "install");
    await Deno.mkdir(physicalDirectory);
    await Deno.mkdir(install);
    await Deno.symlink(physicalDirectory, aliasDirectory);
    const physicalInterpreter = join(physicalDirectory, "ld-fixture.so");
    const reportedInterpreter = join(aliasDirectory, "ld-fixture.so");
    await Deno.writeTextFile(physicalInterpreter, "interpreter\n");
    const executable = join(install, "zig");
    await writeElf64X86_64(executable, 0o755, reportedInterpreter);

    const runtime = await new LinuxRuntimeDependencyInspector({
      runner: new LddRunner(`${reportedInterpreter} (0x1)\n`),
    }).inspect({
      executablePath: executable,
      installPath: install,
      cacheRoot: join(root, "cache"),
      platform: "linux",
    });
    if (runtime.linkage !== "dynamic") throw new Error("expected dynamic runtime");
    assertEquals(runtime.interpreter.path, physicalInterpreter);
  } finally {
    await cleanup(root);
  }
});

Deno.test("Linux runtime inspector rejects unresolved, duplicate, missing, and cache dependencies", async () => {
  await withRuntimeFixture(async ({ root, cacheRoot, executable, library }) => {
    const cases = [
      { output: "libmissing.so => not found\n", message: "unresolved" },
      {
        output: `libone.so => ${library} (0x1)\nlibtwo.so => ${library} (0x2)\n`,
        message: "duplicated",
      },
      { output: `libmissing.so => ${join(root, "missing.so")} (0x1)\n`, message: "missing" },
    ];
    const cached = join(cacheRoot, "libcache.so");
    const cachedAlias = join(root, "libcache-alias.so");
    await Deno.mkdir(cacheRoot, { recursive: true });
    await Deno.writeTextFile(cached, "cache dependency\n");
    await Deno.symlink(cached, cachedAlias);
    cases.push({ output: `libcache.so => ${cached} (0x1)\n`, message: "cache root" });
    cases.push({ output: `libcache.so => ${cachedAlias} (0x1)\n`, message: "cache root" });
    for (const item of cases) {
      await assertRejects(
        () =>
          new LinuxRuntimeDependencyInspector({ runner: new LddRunner(item.output) }).inspect({
            executablePath: executable,
            installPath: join(root, "install"),
            cacheRoot,
            platform: "linux",
          }),
        TypeError,
        item.message,
      );
    }
  });
});

class LddRunner implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];
  readonly output: string;

  constructor(output: string) {
    this.output = output;
  }

  run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push(request);
    return Promise.resolve({
      success: true,
      code: 0,
      signal: null,
      stdout: this.output,
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
    });
  }
}

async function withRuntimeFixture(
  action: (fixture: {
    readonly root: string;
    readonly cacheRoot: string;
    readonly executable: string;
    readonly interpreter: string;
    readonly library: string;
  }) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-runtime-" });
  try {
    const system = join(root, "system");
    const install = join(root, "install");
    const cacheRoot = join(root, "cache");
    await Deno.mkdir(system);
    await Deno.mkdir(install);
    const interpreter = resolve(join(system, "ld-fixture.so"));
    const library = resolve(join(system, "libfixture.so"));
    await Deno.writeTextFile(interpreter, "interpreter\n");
    await Deno.writeTextFile(library, "library\n");
    const executable = join(install, "zig");
    await writeElf64X86_64(executable, 0o755, interpreter);
    await action({ root, cacheRoot, executable, interpreter, library });
  } finally {
    await cleanup(root);
  }
}
