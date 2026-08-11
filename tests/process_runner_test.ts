import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { ZigOperationAbortedError } from "../src/errors.ts";
import { DenoProcessRunner } from "../src/process_runner.ts";
import { sha256Text } from "../src/filesystem.ts";

Deno.test("streaming SHA-256 matches the standard known vector", async () => {
  assertEquals(
    await sha256Text("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

Deno.test("Deno process runner uses direct args, streams all output, and bounds diagnostics", async () => {
  const runner = new DenoProcessRunner();
  let streamed = "";
  const result = await runner.run({
    executable: Deno.execPath(),
    args: ["eval", "Deno.stdout.write(new TextEncoder().encode('x'.repeat(10000)))"],
    maxDiagnosticBytes: 64,
    onStdout: (chunk) => {
      streamed += new TextDecoder().decode(chunk);
    },
  });
  assert(result.success);
  assertEquals(result.stdout.length, 64);
  assertEquals(result.stdoutTruncated, true);
  assertEquals(streamed.length, 10000);
});

Deno.test("Deno process runner reports nonzero exits without throwing", async () => {
  const result = await new DenoProcessRunner().run({
    executable: Deno.execPath(),
    args: ["eval", "Deno.stderr.write(new TextEncoder().encode('failure')); Deno.exit(23)"],
  });
  assertEquals(result.success, false);
  assertEquals(result.code, 23);
  assertEquals(result.signal, null);
  assertStringIncludes(result.stderr, "failure");
});

Deno.test("Deno process runner rejects a pre-aborted request without spawning", async () => {
  const controller = new AbortController();
  controller.abort("SIGINT");
  const error = await assertRejects(
    () =>
      new DenoProcessRunner().run({
        executable: "/definitely/not/a/real/executable",
        args: [],
        signal: controller.signal,
      }),
    ZigOperationAbortedError,
  );
  assertEquals(error.details.signal, "SIGINT");
});

Deno.test("Deno process runner propagates SIGINT and SIGTERM and rejects child exit zero", async () => {
  if (Deno.build.os === "windows") return;
  for (
    const [reason, expected] of [
      ["SIGINT", "SIGINT"],
      ["SIGTERM", "SIGTERM"],
      [undefined, "SIGTERM"],
    ] as const
  ) {
    const controller = new AbortController();
    let output = "";
    let readyResolve!: () => void;
    const ready = new Promise<void>((resolve) => readyResolve = resolve);
    const script = `
      const signal = Deno.args[0];
      Deno.addSignalListener(signal, async () => {
        await Deno.stdout.write(new TextEncoder().encode(signal + "\\n"));
        Deno.exit(0);
      });
      await Deno.stdout.write(new TextEncoder().encode("ready\\n"));
      await new Promise(() => {});
    `;
    const pending = new DenoProcessRunner({ terminationGraceMs: 100 }).run({
      executable: Deno.execPath(),
      args: ["eval", script, expected],
      signal: controller.signal,
      onStdout: (chunk) => {
        output += new TextDecoder().decode(chunk);
        if (output.includes("ready\n")) readyResolve();
      },
    });
    await ready;
    controller.abort(reason);
    const error = await assertRejects(() => pending, ZigOperationAbortedError);
    assertEquals(error.details.signal, expected);
    assertStringIncludes(output, `${expected}\n`);
  }
});
