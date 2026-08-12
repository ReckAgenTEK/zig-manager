import { join } from "@std/path";
import { ZigSourceNotReadyError } from "./errors.ts";
import { compareZigVersions, parseZigTag } from "./versions.ts";
import type { RevisionDescription, ZigSourceVersion } from "./types.ts";

const MAX_CMAKE_LISTS_BYTES = 1024 * 1024;
const MAX_CONTRACT_SOURCE_BYTES = 2 * 1024 * 1024;

export const ZIG_CMAKE_SOURCE_CONTRACT = "zig-cmake-stage3-v1" as const;

export interface ZigCMakeSourceContract {
  readonly layout: typeof ZIG_CMAKE_SOURCE_CONTRACT | null;
  readonly cmakeMinimum: string | null;
  readonly llvmMajor: number | null;
  readonly clangMajor: number | null;
  readonly lldMajor: number | null;
  readonly versionOverride: boolean;
  readonly llvmConfigToggle: boolean;
  readonly installScript: boolean;
  readonly extraBuildArgs: boolean;
  readonly noLangrefSupport: "cmake-default" | "extra-build-args" | null;
  readonly llvmCompatibility: "llvm21-v1" | "llvm22-v1" | null;
}

export interface ZigCMakeSourceEvidence {
  readonly buildZig?: string;
  readonly zigLlvm: string;
  readonly zigLlvmAr: string;
  readonly clangDriver: string;
}

export interface ZigSourceMetadata {
  readonly version: ZigSourceVersion;
  readonly contract: ZigCMakeSourceContract;
}

export async function readZigSourceVersion(
  checkoutPath: string,
  revision: RevisionDescription,
): Promise<ZigSourceVersion> {
  const text = await readCmakeLists(checkoutPath);
  return deriveZigSourceVersion(parseCmakeZigVersion(text), revision);
}

export async function readZigSourceMetadata(
  checkoutPath: string,
  revision: RevisionDescription,
): Promise<ZigSourceMetadata> {
  const text = await readCmakeLists(checkoutPath);
  const preliminary = parseCmakeZigSourceContract(text);
  const buildZig = await readOptionalContractSource(checkoutPath, "build.zig");
  const evidence = preliminary.llvmMajor === 22 && preliminary.clangMajor === 22 &&
      preliminary.lldMajor === 22
    ? await readLlvm22SourceEvidence(checkoutPath)
    : undefined;
  return {
    version: deriveZigSourceVersion(parseCmakeZigVersion(text), revision),
    contract: parseCmakeZigSourceContract(text, {
      buildZig,
      zigLlvm: evidence?.zigLlvm ?? "",
      zigLlvmAr: evidence?.zigLlvmAr ?? "",
      clangDriver: evidence?.clangDriver ?? "",
    }),
  };
}

async function readCmakeLists(checkoutPath: string): Promise<string> {
  const path = join(checkoutPath, "CMakeLists.txt");
  try {
    const stat = await Deno.stat(path);
    if (!stat.isFile || stat.size > MAX_CMAKE_LISTS_BYTES) {
      throw new Error(`expected a file no larger than ${MAX_CMAKE_LISTS_BYTES} bytes`);
    }
    return await Deno.readTextFile(path);
  } catch (cause) {
    throw new ZigSourceNotReadyError("CMakeLists.txt could not be read for version metadata", {
      path,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

export function parseCmakeZigVersion(text: string): string {
  const major = cmakeVersionComponent(text, "MAJOR");
  const minor = cmakeVersionComponent(text, "MINOR");
  const patch = cmakeVersionComponent(text, "PATCH");
  const base = `${major}.${minor}.${patch}`;
  if (parseZigTag(base) === null) {
    throw new ZigSourceNotReadyError("CMakeLists.txt declares an invalid Zig semantic version", {
      base,
    });
  }
  return base;
}

export function parseCmakeZigSourceContract(
  text: string,
  evidence?: ZigCMakeSourceEvidence,
): ZigCMakeSourceContract {
  const cmakeMinimum = uniqueCapture(
    text,
    /^[ \t]*cmake_minimum_required\s*\(\s*VERSION\s+([0-9]+(?:\.[0-9]+){1,2})\s*\)[ \t]*(?:#[^\r\n]*)?$/gim,
  );
  const llvmMajor = cmakePackageMajor(text, "llvm");
  const clangMajor = cmakePackageMajor(text, "clang");
  const lldMajor = cmakePackageMajor(text, "lld");
  const versionOverride = hasUniqueStatement(
    text,
    /^[ \t]*set\s*\(\s*ZIG_VERSION\s+""\s+CACHE\s+STRING(?:\s+[^)\r\n]*)?\)[ \t]*(?:#[^\r\n]*)?$/gim,
  );
  const llvmConfigToggle = hasUniqueStatement(
    text,
    /^[ \t]*set\s*\(\s*ZIG_USE_LLVM_CONFIG\s+ON\s+CACHE\s+BOOL(?:\s+[^)\r\n]*)?\)[ \t]*(?:#[^\r\n]*)?$/gim,
  );
  const installScript = hasUniqueStatement(
    text,
    /^[ \t]*install\s*\(\s*SCRIPT\s+"?cmake\/install\.cmake"?\s*\)[ \t]*(?:#[^\r\n]*)?$/gim,
  );
  const extraBuildArgs = hasUniqueStatement(
    text,
    /^[ \t]*set\s*\(\s*ZIG_EXTRA_BUILD_ARGS\s+""\s+CACHE\s+STRING(?:\s+[^)\r\n]*)?\)[ \t]*(?:#[^\r\n]*)?$/gim,
  ) && hasUniqueStatement(
    text,
    /^[ \t]*list\s*\(\s*APPEND\s+ZIG_BUILD_ARGS\s+\$\{ZIG_EXTRA_BUILD_ARGS\}\s*\)[ \t]*(?:#[^\r\n]*)?$/gim,
  );
  const cmakeDisablesLangref = hasUniqueStatement(
    text,
    /^[ \t]*-Dno-langref[ \t]*(?:#[^\r\n]*)?$/gim,
  );
  const noLangrefBuildOption = hasUniqueStatement(
    evidence?.buildZig ?? "",
    /^[ \t]*const\s+skip_install_langref\s*=\s*b\.option\s*\(\s*bool\s*,\s*"no-langref"\s*,[^\r\n]*$/gim,
  );
  const noLangrefSupport = cmakeDisablesLangref
    ? "cmake-default"
    : extraBuildArgs && noLangrefBuildOption
    ? "extra-build-args"
    : null;
  const layout = versionOverride && llvmConfigToggle && installScript
    ? ZIG_CMAKE_SOURCE_CONTRACT
    : null;
  const alignedMajor = llvmMajor !== null && llvmMajor === clangMajor && llvmMajor === lldMajor;
  const llvmCompatibility = layout !== null && alignedMajor && llvmMajor === 21
    ? "llvm21-v1"
    : layout !== null && alignedMajor && llvmMajor === 22 && supportsLlvm22SourceApi(evidence)
    ? "llvm22-v1"
    : null;
  return {
    layout,
    cmakeMinimum,
    llvmMajor,
    clangMajor,
    lldMajor,
    versionOverride,
    llvmConfigToggle,
    installScript,
    extraBuildArgs,
    noLangrefSupport,
    llvmCompatibility,
  };
}

async function readLlvm22SourceEvidence(checkoutPath: string): Promise<ZigCMakeSourceEvidence> {
  const [zigLlvm, zigLlvmAr, clangDriver] = await Promise.all([
    readOptionalContractSource(checkoutPath, "src/zig_llvm.cpp"),
    readOptionalContractSource(checkoutPath, "src/zig_llvm-ar.cpp"),
    readOptionalContractSource(checkoutPath, "src/zig_clang_driver.cpp"),
  ]);
  return { zigLlvm, zigLlvmAr, clangDriver };
}

async function readOptionalContractSource(
  checkoutPath: string,
  relativePath: string,
): Promise<string> {
  const path = join(checkoutPath, ...relativePath.split("/"));
  try {
    const stat = await Deno.lstat(path);
    if (!stat.isFile || stat.isSymlink || stat.size > MAX_CONTRACT_SOURCE_BYTES) return "";
    return await Deno.readTextFile(path);
  } catch {
    return "";
  }
}

function supportsLlvm22SourceApi(evidence: ZigCMakeSourceEvidence | undefined): boolean {
  return evidence !== undefined &&
    evidence.zigLlvm.includes("opt_bisect.setIntervals({0, limit});") &&
    evidence.zigLlvmAr.includes('#include "llvm/ADT/StringMap.h"') &&
    evidence.clangDriver.includes('#include "clang/Options/Options.h"');
}

export function deriveZigSourceVersion(
  base: string,
  revision: RevisionDescription,
): ZigSourceVersion {
  const baseVersion = parseZigTag(base);
  if (baseVersion === null) {
    throw new ZigSourceNotReadyError("source base version is not a stable semantic version", {
      base,
    });
  }
  if (
    revision.tag === null || revision.commitsSinceTag === null ||
    !Number.isSafeInteger(revision.commitsSinceTag) || revision.commitsSinceTag < 0
  ) {
    throw new ZigSourceNotReadyError("locked commit has no usable semantic-version tag ancestry", {
      commit: revision.commit,
    });
  }
  const taggedAncestor = revision.tag.startsWith("v") ? revision.tag.slice(1) : revision.tag;
  const ancestorVersion = parseZigTag(taggedAncestor);
  if (ancestorVersion === null) {
    throw new ZigSourceNotReadyError("nearest tagged ancestor is not a stable Zig version", {
      tag: revision.tag,
    });
  }
  const abbreviation = revision.abbreviatedCommit.toLowerCase();
  if (
    !/^[0-9a-f]{4,64}$/.test(abbreviation) ||
    !revision.commit.toLowerCase().startsWith(abbreviation)
  ) {
    throw new ZigSourceNotReadyError("revision abbreviation does not identify the locked commit", {
      commit: revision.commit,
      abbreviation,
    });
  }
  if (revision.commitsSinceTag === 0) {
    if (compareZigVersions(baseVersion, ancestorVersion) !== 0) {
      throw new ZigSourceNotReadyError("source base version does not match its exact Git tag", {
        base,
        tag: taggedAncestor,
      });
    }
    return {
      kind: "release",
      base,
      text: base,
      taggedAncestor,
      commitsAfterTag: 0,
      commitAbbreviation: abbreviation,
    };
  }
  if (compareZigVersions(baseVersion, ancestorVersion) <= 0) {
    throw new ZigSourceNotReadyError(
      "development source version is not newer than its tagged ancestor",
      {
        base,
        taggedAncestor,
      },
    );
  }
  return {
    kind: "development",
    base,
    text: `${base}-dev.${revision.commitsSinceTag}+${abbreviation}`,
    taggedAncestor,
    commitsAfterTag: revision.commitsSinceTag,
    commitAbbreviation: abbreviation,
  };
}

export function validateZigSourceVersion(value: unknown, path = "version"): ZigSourceVersion {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const item = value as Record<string, unknown>;
  const keys = [
    "kind",
    "base",
    "text",
    "taggedAncestor",
    "commitsAfterTag",
    "commitAbbreviation",
  ];
  const unknown = Object.keys(item).filter((key) => !keys.includes(key)).sort();
  if (unknown.length > 0) throw new Error(`${path} contains unknown key '${unknown[0]}'`);
  for (const key of keys) if (!(key in item)) throw new Error(`${path}.${key} is required`);
  if (item.kind !== "release" && item.kind !== "development") {
    throw new Error(`${path}.kind must be 'release' or 'development'`);
  }
  const base = requiredText(item.base, `${path}.base`);
  const text = requiredText(item.text, `${path}.text`);
  const taggedAncestor = requiredText(item.taggedAncestor, `${path}.taggedAncestor`);
  const commitAbbreviation = requiredText(
    item.commitAbbreviation,
    `${path}.commitAbbreviation`,
  );
  const baseVersion = parseZigTag(base);
  const ancestorVersion = parseZigTag(taggedAncestor);
  if (baseVersion === null) throw new Error(`${path}.base must be a stable semantic version`);
  if (ancestorVersion === null) {
    throw new Error(`${path}.taggedAncestor must be a stable semantic version`);
  }
  if (!Number.isSafeInteger(item.commitsAfterTag) || (item.commitsAfterTag as number) < 0) {
    throw new Error(`${path}.commitsAfterTag must be a nonnegative safe integer`);
  }
  if (!/^[0-9a-f]{4,64}$/.test(commitAbbreviation)) {
    throw new Error(`${path}.commitAbbreviation must be lowercase hexadecimal`);
  }
  const commitsAfterTag = item.commitsAfterTag as number;
  if (item.kind === "release") {
    if (commitsAfterTag !== 0 || base !== taggedAncestor || text !== base) {
      throw new Error(`${path} contains inconsistent release provenance`);
    }
  } else {
    if (
      commitsAfterTag === 0 || compareZigVersions(baseVersion, ancestorVersion) <= 0 ||
      text !== `${base}-dev.${commitsAfterTag}+${commitAbbreviation}`
    ) {
      throw new Error(`${path} contains inconsistent development provenance`);
    }
  }
  return { kind: item.kind, base, text, taggedAncestor, commitsAfterTag, commitAbbreviation };
}

function cmakeVersionComponent(text: string, component: "MAJOR" | "MINOR" | "PATCH"): number {
  const pattern = new RegExp(
    `^[ \\t]*set\\s*\\(\\s*ZIG_VERSION_${component}\\s+([0-9]+)\\s*\\)[ \\t]*$`,
    "gm",
  );
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new ZigSourceNotReadyError(
      `CMakeLists.txt must declare ZIG_VERSION_${component} exactly once`,
    );
  }
  const value = Number(matches[0][1]);
  if (!Number.isSafeInteger(value)) {
    throw new ZigSourceNotReadyError(`ZIG_VERSION_${component} is too large`);
  }
  return value;
}

function cmakePackageMajor(
  text: string,
  component: "llvm" | "clang" | "lld",
): number | null {
  const value = uniqueCapture(
    text,
    new RegExp(
      `^[ \\t]*find_package\\s*\\(\\s*${component}\\s+([0-9]+)(?:\\.[0-9]+)*\\s*\\)[ \\t]*(?:#[^\\r\\n]*)?$`,
      "gim",
    ),
  );
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function uniqueCapture(text: string, pattern: RegExp): string | null {
  const matches = [...text.matchAll(pattern)];
  return matches.length === 1 ? matches[0][1] ?? null : null;
}

function hasUniqueStatement(text: string, pattern: RegExp): boolean {
  return [...text.matchAll(pattern)].length === 1;
}

function requiredText(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a nonempty string`);
  }
  return value;
}
