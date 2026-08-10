import { assertEquals, assertInstanceOf, assertRejects, assertThrows } from "@std/assert";
import {
  ConfigValidationError,
  deriveZigSourceVersion,
  InvalidZigSelectorError,
  listStableZigVersions,
  loadZigManagerConfig,
  parseCmakeZigVersion,
  parseZigSelector,
  parseZigTag,
  resolveZigManagerConfig,
  resolveZigSelector,
  ZigVersionNotFoundError,
} from "../src/mod.ts";
import { COMMIT_A, COMMIT_B, testConfig } from "./test_helpers.ts";

Deno.test("strict Zig tags and selectors reject malformed and prerelease values", () => {
  assertEquals(parseZigTag("0.16.0"), { major: 0, minor: 16, patch: 0, text: "0.16.0" });
  for (const value of ["v0.16.0", "0.16", "0.16.0-dev.1", "01.16.0", "0.16.0 "]) {
    assertEquals(parseZigTag(value), null);
  }
  assertEquals(parseZigSelector("0.16").kind, "minor");
  assertEquals(parseZigSelector("tag:nightly"), { kind: "tag", value: "nightly" });
  assertEquals(parseZigSelector("branch:master"), { kind: "branch", value: "master" });
  assertEquals(parseZigSelector(`commit:${COMMIT_A}`), { kind: "commit", value: COMMIT_A });
  assertThrows(() => parseZigSelector("0.16.0-beta.1"), InvalidZigSelectorError);
  assertThrows(() => parseZigSelector("commit:abc"), InvalidZigSelectorError);
});

Deno.test("minor selector deterministically chooses highest stable patch", () => {
  const refs = [
    { kind: "tag" as const, name: "0.16.2", commit: COMMIT_B },
    { kind: "tag" as const, name: "0.16.10", commit: COMMIT_A },
    { kind: "tag" as const, name: "0.16.9", commit: COMMIT_B },
    { kind: "tag" as const, name: "0.16.11-dev.1", commit: COMMIT_A },
    { kind: "tag" as const, name: "v0.16.99", commit: COMMIT_A },
    { kind: "branch" as const, name: "0.16.99", commit: COMMIT_A },
  ];
  const selected = resolveZigSelector("0.16", refs);
  assertEquals(selected.ref, { kind: "tag", value: "0.16.10" });
  assertEquals(listStableZigVersions(refs).map((item) => item.text), [
    "0.16.10",
    "0.16.9",
    "0.16.2",
  ]);
  assertThrows(() => resolveZigSelector("0.15", refs), ZigVersionNotFoundError);
});

Deno.test("source metadata derives Zig's stable and development version text", () => {
  assertEquals(
    parseCmakeZigVersion(
      "set(ZIG_VERSION_MAJOR 0)\nset(ZIG_VERSION_MINOR 17)\nset(ZIG_VERSION_PATCH 0)\n",
    ),
    "0.17.0",
  );
  assertEquals(
    deriveZigSourceVersion("0.17.0", {
      commit: COMMIT_A,
      tag: "0.16.0",
      commitsSinceTag: 135,
      abbreviatedCommit: COMMIT_A.slice(0, 9),
    }),
    {
      kind: "development",
      base: "0.17.0",
      text: `0.17.0-dev.135+${COMMIT_A.slice(0, 9)}`,
      taggedAncestor: "0.16.0",
      commitsAfterTag: 135,
      commitAbbreviation: COMMIT_A.slice(0, 9),
    },
  );
  assertThrows(() =>
    deriveZigSourceVersion("0.16.0", {
      commit: COMMIT_A,
      tag: "0.16.0",
      commitsSinceTag: 1,
      abbreviatedCommit: COMMIT_A.slice(0, 9),
    })
  );
});

Deno.test("explicit selectors require matching remote refs while commits remain exact", () => {
  const refs = [
    { kind: "tag" as const, name: "nightly", commit: COMMIT_A },
    { kind: "branch" as const, name: "master", commit: COMMIT_B },
  ];
  assertEquals(resolveZigSelector("tag:nightly", refs).remoteCommit, COMMIT_A);
  assertEquals(resolveZigSelector("branch:master", refs).remoteCommit, COMMIT_B);
  assertEquals(resolveZigSelector(`commit:${COMMIT_A}`, []).remoteCommit, COMMIT_A);
  assertThrows(() => resolveZigSelector("tag:missing", refs), ZigVersionNotFoundError);
});

Deno.test("configuration rejects unknown keys and source-root traversal", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-config-" });
  const valid = testConfig(root);
  const resolved = resolveZigManagerConfig(valid, root);
  assertEquals(resolved.sourceRoot, `${root}/.source-ref`);

  const unknown = { ...valid, typo: true };
  const unknownError = assertThrows(() => resolveZigManagerConfig(unknown, root));
  assertInstanceOf(unknownError, ConfigValidationError);

  const traversal = { ...valid, sourceRoot: "../outside" };
  assertThrows(
    () => resolveZigManagerConfig(traversal, root),
    ConfigValidationError,
  );
  await Deno.remove(root, { recursive: true });
});

Deno.test("configuration loading rejects a managed root symlink escaping the project", async () => {
  if (Deno.build.os === "windows") return;
  const root = await Deno.makeTempDir({ prefix: "zig-manager-config-symlink-" });
  const outside = await Deno.makeTempDir({ prefix: "zig-manager-config-outside-" });
  try {
    await Deno.symlink(outside, `${root}/.source-ref`);
    await Deno.writeTextFile(`${root}/zig-manager.json`, JSON.stringify(testConfig(root)));
    await assertRejects(() => loadZigManagerConfig(root), ConfigValidationError, "outside");
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});
