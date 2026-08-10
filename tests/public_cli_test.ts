import { assertEquals, assertStringIncludes } from "@std/assert";
import * as publicApi from "../src/mod.ts";
import { runCli } from "../src/cli.ts";

Deno.test("public API is domain-oriented and excludes the concrete process runner", () => {
  assertEquals(typeof publicApi.ZigManager, "function");
  assertEquals(publicApi.CONFIG_SCHEMA_VERSION, 1);
  assertEquals(publicApi.STATE_SCHEMA_VERSION, 2);
  assertEquals(publicApi.BUILD_MANIFEST_SCHEMA_VERSION, 2);
  assertEquals(publicApi.DOCS_MANIFEST_SCHEMA_VERSION, 2);
  assertEquals(publicApi.MEGA_FORMAT_VERSION, 1);
  assertEquals(
    publicApi.INITIAL_ZIG_SELECTOR,
    "commit:9df02121d0d87c17173f79d55692bed9cb65722c",
  );
  assertEquals(publicApi.REQUIRED_LLVM_MAJOR, 21);
  assertEquals(Object.keys(publicApi).includes("DenoProcessRunner"), false);
  assertEquals(Object.keys(publicApi).includes("GitClient"), false);
});

Deno.test("CLI import is inert, help lists all commands, and JSON errors are stable", async () => {
  let stdout = "";
  let stderr = "";
  const io = {
    stdout: (text: string) => {
      stdout += text;
    },
    stderr: (text: string) => {
      stderr += text;
    },
  };
  assertEquals(await runCli(["help"], io), 0);
  for (
    const command of [
      "versions",
      "use",
      "sync",
      "update",
      "doctor",
      "build",
      "docs",
      "setup",
      "path",
      "run",
      "env",
      "status",
    ]
  ) assertStringIncludes(stdout, command);
  assertEquals(stderr, "");

  stdout = "";
  assertEquals(await runCli(["unknown", "--json"], io), 1);
  const document = JSON.parse(stdout);
  assertEquals(document.schemaVersion, 2);
  assertEquals(document.error.code, "ZIG_INVALID_ARGUMENT");

  stdout = "";
  assertEquals(await runCli(["doctor", "--json", "--project-root"], io), 1);
  assertEquals(JSON.parse(stdout).error.code, "ZIG_INVALID_ARGUMENT");
});

Deno.test("all published JSON schemas are valid JSON and reject additional properties", async () => {
  const schemaRoot = new URL("../schema/", import.meta.url);
  for (
    const name of [
      "zig-manager.schema.json",
      "state.schema.json",
      "build-manifest.schema.json",
      "docs-manifest.schema.json",
    ]
  ) {
    const schema = JSON.parse(await Deno.readTextFile(new URL(name, schemaRoot)));
    assertEquals(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assertEquals(schema.additionalProperties, false);
  }
});
