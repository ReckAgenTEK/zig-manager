import { join } from "@std/path";
import { ZigSourceNotReadyError } from "./errors.ts";
import { compareZigVersions, parseZigTag } from "./versions.ts";
import type { RevisionDescription, ZigSourceVersion } from "./types.ts";

const MAX_CMAKE_LISTS_BYTES = 1024 * 1024;

export async function readZigSourceVersion(
  checkoutPath: string,
  revision: RevisionDescription,
): Promise<ZigSourceVersion> {
  const path = join(checkoutPath, "CMakeLists.txt");
  let text: string;
  try {
    const stat = await Deno.stat(path);
    if (!stat.isFile || stat.size > MAX_CMAKE_LISTS_BYTES) {
      throw new Error(`expected a file no larger than ${MAX_CMAKE_LISTS_BYTES} bytes`);
    }
    text = await Deno.readTextFile(path);
  } catch (cause) {
    throw new ZigSourceNotReadyError("CMakeLists.txt could not be read for version metadata", {
      path,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
  return deriveZigSourceVersion(parseCmakeZigVersion(text), revision);
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

function requiredText(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a nonempty string`);
  }
  return value;
}
