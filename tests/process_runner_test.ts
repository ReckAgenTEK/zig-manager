import { assert, assertEquals, assertStringIncludes } from "@std/assert";
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

Deno.test("Deno process runner terminates an aborted child and returns signal status", async () => {
  if (Deno.build.os === "windows") return;
  const controller = new AbortController();
  const pending = new DenoProcessRunner().run({
    executable: Deno.execPath(),
    args: ["eval", "await new Promise((resolve) => setTimeout(resolve, 30000))"],
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 30);
  const result = await pending;
  assertEquals(result.success, false);
  assertEquals(result.signal, "SIGTERM");
});
