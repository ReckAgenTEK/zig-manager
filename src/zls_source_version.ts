import type { RemoteRef, RevisionDescription } from "@zignado/source-ref";
import { join } from "@std/path";

const MAX_BUILD_ZIG_ZON_BYTES = 1024 * 1024;
const MAX_BUILD_ZIG_BYTES = 1024 * 1024;
const STABLE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const DEVELOPMENT_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-dev$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SEMANTIC_VERSION =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export interface ZlsSemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly text: string;
}

export interface ZlsStableTag {
  readonly tag: string;
  readonly version: ZlsSemanticVersion;
  readonly commit: string;
}

interface ZlsSourceVersionCommon {
  /** The literal semantic version declared by build.zig.zon. */
  readonly declaredVersion: string;
  /** The stable version for this release or next development release. */
  readonly base: string;
  /** Canonical source version reported to callers. */
  readonly text: string;
  /** Exact value to pass to ZLS as `-Dversion-string`. */
  readonly versionString: string;
  readonly taggedAncestor: string;
  readonly commitsAfterTag: number;
  readonly commitAbbreviation: string;
}

export interface ZlsReleaseSourceVersion extends ZlsSourceVersionCommon {
  readonly kind: "release";
  readonly commitsAfterTag: 0;
}

export interface ZlsDevelopmentSourceVersion extends ZlsSourceVersionCommon {
  readonly kind: "development";
}

export type ZlsSourceVersion = ZlsReleaseSourceVersion | ZlsDevelopmentSourceVersion;

export interface ZlsZigCompatibility {
  readonly minimumBuildVersion: string;
  readonly maximumBuildVersionExclusive: string | null;
}

export interface ZlsSourceMetadata {
  readonly version: ZlsSourceVersion;
  readonly zigCompatibility: ZlsZigCompatibility;
}

interface ComparableSemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: readonly (number | string)[] | null;
  readonly text: string;
}

export class ZlsSourceVersionError extends Error {
  readonly code = "ZLS_SOURCE_VERSION_INVALID";
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    reason: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(`Invalid ZLS source version metadata: ${reason}`, options);
    this.name = "ZlsSourceVersionError";
    this.details = { reason, ...details };
  }
}

export function parseZlsStableTag(tag: string): ZlsSemanticVersion | null {
  const match = STABLE_VERSION.exec(tag);
  if (match === null) return null;
  const components = match.slice(1).map(Number);
  if (components.some((component) => !Number.isSafeInteger(component))) return null;
  return {
    major: components[0],
    minor: components[1],
    patch: components[2],
    text: tag,
  };
}

export function compareZlsVersions(
  left: ZlsSemanticVersion,
  right: ZlsSemanticVersion,
): number {
  return compareNumber(left.major, right.major) || compareNumber(left.minor, right.minor) ||
    compareNumber(left.patch, right.patch) || compareText(left.text, right.text);
}

/** Selects the highest strict `major.minor.patch` tag in one release cycle. */
export function selectHighestZlsTag(
  refs: readonly RemoteRef[],
  major: number,
  minor: number,
): ZlsStableTag | null {
  requiredVersionComponent(major, "major");
  requiredVersionComponent(minor, "minor");
  let selected: ZlsStableTag | null = null;
  for (const ref of refs) {
    if (ref.kind !== "tag") continue;
    const version = parseZlsStableTag(ref.name);
    if (version === null || version.major !== major || version.minor !== minor) continue;
    const candidate = { tag: ref.name, version, commit: ref.commit };
    if (
      selected === null || compareZlsVersions(candidate.version, selected.version) > 0 ||
      compareZlsVersions(candidate.version, selected.version) === 0 &&
        compareText(candidate.commit, selected.commit) < 0
    ) {
      selected = candidate;
    }
  }
  return selected;
}

export async function readZlsSourceVersion(
  checkoutPath: string,
  revision: RevisionDescription,
): Promise<ZlsSourceVersion> {
  const text = await readSourceFile(checkoutPath, "build.zig.zon", MAX_BUILD_ZIG_ZON_BYTES);
  return deriveZlsSourceVersion(parseBuildZigZonVersion(text), revision);
}

export async function readZlsSourceMetadata(
  checkoutPath: string,
  revision: RevisionDescription,
): Promise<ZlsSourceMetadata> {
  const [zon, build] = await Promise.all([
    readSourceFile(checkoutPath, "build.zig.zon", MAX_BUILD_ZIG_ZON_BYTES),
    readSourceFile(checkoutPath, "build.zig", MAX_BUILD_ZIG_BYTES),
  ]);
  return {
    version: deriveZlsSourceVersion(parseBuildZigZonVersion(zon), revision),
    zigCompatibility: parseZlsZigCompatibility(zon, build),
  };
}

export function parseBuildZigZonVersion(text: string): string {
  const matches = [...text.matchAll(
    /^[ \t]*\.version[ \t]*=[ \t]*"([^"\\\r\n]+)"[ \t]*,[ \t]*(?:\/\/[^\r\n]*)?\r?$/gm,
  )];
  if (matches.length !== 1) {
    throw new ZlsSourceVersionError("build.zig.zon must declare .version exactly once");
  }
  const declaredVersion = matches[0][1];
  if (parseDeclaredVersion(declaredVersion) === null) {
    throw new ZlsSourceVersionError(
      "build.zig.zon .version must be a strict stable version or strict stable version followed by -dev",
      { declaredVersion },
    );
  }
  return declaredVersion;
}

export function parseZlsZigCompatibility(
  buildZigZon: string,
  buildZig: string,
): ZlsZigCompatibility {
  const minimumMatches = [...buildZigZon.matchAll(
    /^[ \t]*\.minimum_zig_version[ \t]*=[ \t]*"([^"\\\r\n]+)"[ \t]*,[ \t]*(?:\/\/[^\r\n]*)?\r?$/gm,
  )];
  if (minimumMatches.length !== 1) {
    throw new ZlsSourceVersionError(
      "build.zig.zon must declare .minimum_zig_version exactly once",
    );
  }
  const minimumBuildVersion = minimumMatches[0][1];
  const minimum = parseComparableSemanticVersion(minimumBuildVersion);
  if (minimum === null) {
    throw new ZlsSourceVersionError(
      "build.zig.zon .minimum_zig_version must be a strict semantic version",
      { minimumBuildVersion },
    );
  }

  const binding =
    /^[ \t]*const[ \t]+minimum_build_zig_version[ \t]*=[ \t]*@import\("build\.zig\.zon"\)\.minimum_zig_version;[ \t]*(?:\/\/[^\r\n]*)?\r?$/gm;
  if ([...buildZig.matchAll(binding)].length !== 1) {
    throw new ZlsSourceVersionError(
      "build.zig must bind minimum_build_zig_version to build.zig.zon",
    );
  }

  const maximumMatches = [...buildZig.matchAll(
    /^[ \t]*const[ \t]+version[ \t]*=[ \t]*std\.SemanticVersion\.parse\("([^"\\\r\n]+)"\)[ \t]+catch[ \t]+unreachable;\r?\n[ \t]*if[ \t]*\(builtin\.zig_version\.order\(version\)[ \t]*!=[ \t]*\.lt\)[ \t]*\{/gm,
  )];
  if (maximumMatches.length > 1) {
    throw new ZlsSourceVersionError("build.zig contains multiple Zig upper compatibility bounds");
  }
  const maximumBuildVersionExclusive = maximumMatches[0]?.[1] ?? null;
  if (
    buildZig.includes("is not yet supported by ZLS") && maximumBuildVersionExclusive === null
  ) {
    throw new ZlsSourceVersionError("build.zig Zig upper compatibility bound is unsupported");
  }
  if (maximumBuildVersionExclusive !== null) {
    const maximum = parseComparableSemanticVersion(maximumBuildVersionExclusive);
    if (maximum === null) {
      throw new ZlsSourceVersionError(
        "build.zig Zig upper compatibility bound must be a strict semantic version",
        { maximumBuildVersionExclusive },
      );
    }
    if (compareComparableSemanticVersions(maximum, minimum) <= 0) {
      throw new ZlsSourceVersionError(
        "build.zig Zig upper compatibility bound must exceed its minimum",
        { minimumBuildVersion, maximumBuildVersionExclusive },
      );
    }
  }
  return { minimumBuildVersion, maximumBuildVersionExclusive };
}

export function zlsZigCompatibilityReason(
  zigVersion: string,
  zlsVersion: ZlsSourceVersion,
  compatibility: ZlsZigCompatibility,
): string | null {
  const zig = parseComparableSemanticVersion(zigVersion);
  const minimum = parseComparableSemanticVersion(compatibility.minimumBuildVersion);
  if (zig === null || minimum === null) {
    throw new TypeError("Zig compatibility comparison received an invalid semantic version");
  }
  const minimumOrder = compareComparableSemanticVersions(zig, minimum);
  if (minimumOrder < 0) {
    return `ZLS requires Zig ${compatibility.minimumBuildVersion} or newer, not ${zigVersion}`;
  }
  if (minimumOrder > 0 && zig.prerelease === null && minimum.prerelease !== null) {
    return `development ZLS requiring ${compatibility.minimumBuildVersion} cannot be built by tagged Zig ${zigVersion}`;
  }
  if (
    zlsVersion.kind === "release" &&
    (zig.major !== minimum.major || zig.minor !== minimum.minor)
  ) {
    return `tagged ZLS ${zlsVersion.text} requires Zig release cycle ${minimum.major}.${minimum.minor}, not ${zigVersion}`;
  }
  if (compatibility.maximumBuildVersionExclusive !== null) {
    const maximum = parseComparableSemanticVersion(compatibility.maximumBuildVersionExclusive);
    if (maximum === null) {
      throw new TypeError("ZLS maximum Zig compatibility version is invalid");
    }
    if (compareComparableSemanticVersions(zig, maximum) >= 0) {
      return `ZLS supports Zig versions below ${compatibility.maximumBuildVersionExclusive}, not ${zigVersion}`;
    }
  }
  return null;
}

export function deriveZlsSourceVersion(
  declaredVersion: string,
  revision: RevisionDescription,
): ZlsSourceVersion {
  const declaration = parseDeclaredVersion(declaredVersion);
  if (declaration === null) {
    throw new ZlsSourceVersionError("declared version is not a supported ZLS semantic version", {
      declaredVersion,
    });
  }
  const commit = canonicalRevisionCommit(revision.commit);
  const taggedAncestor = revision.tag === null ? null : parseZlsStableTag(revision.tag);
  if (taggedAncestor === null) {
    throw new ZlsSourceVersionError("locked commit has no strict stable ZLS tag ancestry", {
      commit,
      tag: revision.tag,
    });
  }
  if (
    revision.commitsSinceTag === null || !Number.isSafeInteger(revision.commitsSinceTag) ||
    revision.commitsSinceTag < 0
  ) {
    throw new ZlsSourceVersionError("revision height from its stable tag is invalid", {
      commit,
      commitsSinceTag: revision.commitsSinceTag,
    });
  }
  const abbreviation = revision.abbreviatedCommit.toLowerCase();
  if (!/^[0-9a-f]{4,64}$/.test(abbreviation) || !commit.startsWith(abbreviation)) {
    throw new ZlsSourceVersionError("revision abbreviation does not identify the locked commit", {
      commit,
      abbreviation,
    });
  }

  if (revision.commitsSinceTag === 0) {
    if (declaration.kind !== "release" || declaration.version.text !== taggedAncestor.text) {
      throw new ZlsSourceVersionError(
        "build.zig.zon version does not match the exact stable ZLS tag",
        { declaredVersion, tag: taggedAncestor.text },
      );
    }
    return {
      kind: "release",
      declaredVersion,
      base: taggedAncestor.text,
      text: taggedAncestor.text,
      versionString: taggedAncestor.text,
      taggedAncestor: taggedAncestor.text,
      commitsAfterTag: 0,
      commitAbbreviation: abbreviation,
    };
  }

  if (
    declaration.kind !== "development" ||
    compareZlsVersions(declaration.version, taggedAncestor) <= 0
  ) {
    throw new ZlsSourceVersionError(
      "development version in build.zig.zon is not newer than its stable tagged ancestor",
      { declaredVersion, tag: taggedAncestor.text },
    );
  }
  const text = `${declaration.version.text}-dev.${revision.commitsSinceTag}+${abbreviation}`;
  return {
    kind: "development",
    declaredVersion,
    base: declaration.version.text,
    text,
    versionString: text,
    taggedAncestor: taggedAncestor.text,
    commitsAfterTag: revision.commitsSinceTag,
    commitAbbreviation: abbreviation,
  };
}

export function validateZlsSourceVersion(
  value: unknown,
  path = "version",
): ZlsSourceVersion {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const item = value as Record<string, unknown>;
  const keys = [
    "kind",
    "declaredVersion",
    "base",
    "text",
    "versionString",
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

  const declaredVersion = requiredText(item.declaredVersion, `${path}.declaredVersion`);
  const base = requiredText(item.base, `${path}.base`);
  const text = requiredText(item.text, `${path}.text`);
  const versionString = requiredText(item.versionString, `${path}.versionString`);
  const taggedAncestor = requiredText(item.taggedAncestor, `${path}.taggedAncestor`);
  const commitAbbreviation = requiredText(
    item.commitAbbreviation,
    `${path}.commitAbbreviation`,
  );
  const baseVersion = parseZlsStableTag(base);
  const ancestorVersion = parseZlsStableTag(taggedAncestor);
  if (baseVersion === null) throw new Error(`${path}.base must be a strict stable version`);
  if (ancestorVersion === null) {
    throw new Error(`${path}.taggedAncestor must be a strict stable version`);
  }
  if (!Number.isSafeInteger(item.commitsAfterTag) || (item.commitsAfterTag as number) < 0) {
    throw new Error(`${path}.commitsAfterTag must be a nonnegative safe integer`);
  }
  if (!/^[0-9a-f]{4,64}$/.test(commitAbbreviation)) {
    throw new Error(`${path}.commitAbbreviation must be lowercase hexadecimal`);
  }

  const commitsAfterTag = item.commitsAfterTag as number;
  if (item.kind === "release") {
    if (
      parseZlsStableTag(declaredVersion) === null || commitsAfterTag !== 0 ||
      declaredVersion !== base || base !== taggedAncestor || text !== taggedAncestor ||
      versionString !== text
    ) {
      throw new Error(`${path} contains inconsistent release provenance`);
    }
    return {
      kind: "release",
      declaredVersion,
      base,
      text,
      versionString,
      taggedAncestor,
      commitsAfterTag: 0,
      commitAbbreviation,
    };
  }

  if (
    declaredVersion !== `${base}-dev` || commitsAfterTag === 0 ||
    compareZlsVersions(baseVersion, ancestorVersion) <= 0 ||
    text !== `${base}-dev.${commitsAfterTag}+${commitAbbreviation}` || versionString !== text
  ) {
    throw new Error(`${path} contains inconsistent development provenance`);
  }
  return {
    kind: "development",
    declaredVersion,
    base,
    text,
    versionString,
    taggedAncestor,
    commitsAfterTag,
    commitAbbreviation,
  };
}

type ParsedDeclaredVersion =
  | { readonly kind: "release"; readonly version: ZlsSemanticVersion }
  | { readonly kind: "development"; readonly version: ZlsSemanticVersion };

function parseDeclaredVersion(value: string): ParsedDeclaredVersion | null {
  const stable = parseZlsStableTag(value);
  if (stable !== null) return { kind: "release", version: stable };
  const development = DEVELOPMENT_VERSION.exec(value);
  if (development === null) return null;
  const base = value.slice(0, -"-dev".length);
  const version = parseZlsStableTag(base);
  return version === null ? null : { kind: "development", version };
}

function parseComparableSemanticVersion(value: string): ComparableSemanticVersion | null {
  const match = SEMANTIC_VERSION.exec(value);
  if (match === null) return null;
  const components = match.slice(1, 4).map(Number);
  if (components.some((component) => !Number.isSafeInteger(component))) return null;
  const prerelease = match[4] === undefined
    ? null
    : match[4].split(".").map((identifier): number | string => {
      if (!/^(?:0|[1-9][0-9]*)$/.test(identifier)) return identifier;
      const number = Number(identifier);
      return Number.isSafeInteger(number) ? number : identifier;
    });
  if (
    prerelease?.some((identifier) => typeof identifier === "string" && /^[0-9]+$/.test(identifier))
  ) return null;
  return {
    major: components[0],
    minor: components[1],
    patch: components[2],
    prerelease,
    text: value,
  };
}

function compareComparableSemanticVersions(
  left: ComparableSemanticVersion,
  right: ComparableSemanticVersion,
): number {
  const core = compareNumber(left.major, right.major) || compareNumber(left.minor, right.minor) ||
    compareNumber(left.patch, right.patch);
  if (core !== 0) return core;
  if (left.prerelease === null) return right.prerelease === null ? 0 : 1;
  if (right.prerelease === null) return -1;
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index++) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    if (typeof a === "number" && typeof b === "number") return compareNumber(a, b);
    if (typeof a === "number") return -1;
    if (typeof b === "number") return 1;
    return compareText(a, b);
  }
  return 0;
}

async function readSourceFile(
  checkoutPath: string,
  name: "build.zig" | "build.zig.zon",
  maximumBytes: number,
): Promise<string> {
  const path = join(checkoutPath, name);
  try {
    const stat = await Deno.lstat(path);
    if (!stat.isFile || stat.isSymlink || stat.size > maximumBytes) {
      throw new Error(`expected a physical file no larger than ${maximumBytes} bytes`);
    }
    return await Deno.readTextFile(path);
  } catch (cause) {
    throw new ZlsSourceVersionError(`${name} could not be read`, {
      path,
      cause: errorMessage(cause),
    }, { cause });
  }
}

function canonicalRevisionCommit(value: unknown): string {
  if (typeof value !== "string" || !OBJECT_ID.test(value)) {
    throw new ZlsSourceVersionError("revision commit is not a full object ID", { commit: value });
  }
  return value.toLowerCase();
}

function requiredVersionComponent(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a nonnegative safe integer`);
  }
}

function requiredText(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a nonempty string`);
  }
  return value;
}

function compareNumber(left: number, right: number): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
