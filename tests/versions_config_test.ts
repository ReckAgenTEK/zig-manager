import { assertEquals, assertInstanceOf, assertRejects, assertThrows } from "@std/assert";
import {
  ConfigValidationError,
  deriveZigSourceVersion,
  InvalidZigSelectorError,
  listStableZigVersions,
  loadZigManagerConfig,
  parseCmakeZigSourceContract,
  parseCmakeZigVersion,
  parseZigSelector,
  parseZigTag,
  resolveZigManagerConfig,
  resolveZigSelector,
  ZigReleaseUnsupportedError,
  ZigVersionNotFoundError,
} from "../src/mod.ts";
import { releaseAdapterFor } from "../src/release_adapter.ts";
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

Deno.test("locked CMake contract selects the exact LLVM adapter and rejects guesses", () => {
  const version17 = deriveZigSourceVersion("0.17.0", {
    commit: COMMIT_A,
    tag: "0.17.0",
    commitsSinceTag: 0,
    abbreviatedCommit: COMMIT_A.slice(0, 9),
  });
  const version16 = deriveZigSourceVersion("0.16.0", {
    commit: COMMIT_B,
    tag: "0.16.0",
    commitsSinceTag: 0,
    abbreviatedCommit: COMMIT_B.slice(0, 9),
  });
  const llvm21 = parseCmakeZigSourceContract(cmakeSourceContract(21));
  const declaredOnly = parseCmakeZigSourceContract(cmakeSourceContract(22));
  const llvm22 = parseCmakeZigSourceContract(cmakeSourceContract(22), llvm22Evidence());
  assertEquals(releaseAdapterFor(version17, llvm21).id, "zig-cmake-llvm21-autodoc-v1");
  assertEquals(declaredOnly.llvmCompatibility, null);
  assertThrows(
    () => releaseAdapterFor(version17, declaredOnly, COMMIT_A),
    ZigReleaseUnsupportedError,
  );
  assertEquals(releaseAdapterFor(version17, llvm22).id, "zig-cmake-llvm22-autodoc-v1");
  assertThrows(
    () => releaseAdapterFor(version16, llvm22, COMMIT_B),
    ZigReleaseUnsupportedError,
  );

  const mismatched = parseCmakeZigSourceContract(
    cmakeSourceContract(22).replace("find_package(clang 22)", "find_package(clang 21)"),
    llvm22Evidence(),
  );
  const mismatchError = assertThrows(
    () => releaseAdapterFor(version17, mismatched, COMMIT_A),
    ZigReleaseUnsupportedError,
  );
  assertEquals(mismatchError.details.sourceContract, mismatched);
  assertEquals(mismatchError.details.commit, COMMIT_A);

  const unknownLayout = parseCmakeZigSourceContract(
    cmakeSourceContract(22).replace("install(SCRIPT cmake/install.cmake)\n", ""),
    llvm22Evidence(),
  );
  assertEquals(unknownLayout.layout, null);
  assertThrows(
    () => releaseAdapterFor(version17, unknownLayout, COMMIT_A),
    ZigReleaseUnsupportedError,
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

function cmakeSourceContract(llvmMajor: number): string {
  return [
    "cmake_minimum_required(VERSION 3.15)",
    "set(ZIG_VERSION_MAJOR 0)",
    "set(ZIG_VERSION_MINOR 17)",
    "set(ZIG_VERSION_PATCH 0)",
    'set(ZIG_VERSION "" CACHE STRING "Override Zig version")',
    'set(ZIG_USE_LLVM_CONFIG ON CACHE BOOL "use llvm-config")',
    `find_package(llvm ${llvmMajor})`,
    `find_package(clang ${llvmMajor})`,
    `find_package(lld ${llvmMajor})`,
    "install(SCRIPT cmake/install.cmake)",
    "",
  ].join("\n");
}

function llvm22Evidence() {
  return {
    zigLlvm: "opt_bisect.setIntervals({0, limit});",
    zigLlvmAr: '#include "llvm/ADT/StringMap.h"',
    clangDriver: '#include "clang/Options/Options.h"',
  };
}
