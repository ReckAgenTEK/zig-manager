import { InvalidZigSelectorError, ZigVersionNotFoundError } from "./errors.ts";
import type { RemoteRef, ResolvedZigSelection, ZigSelector, ZigSemanticVersion } from "./types.ts";

const STABLE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const MINOR_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export function parseZigTag(tag: string): ZigSemanticVersion | null {
  const match = STABLE_VERSION.exec(tag);
  if (!match) return null;
  const values = match.slice(1).map(Number);
  if (values.some((value) => !Number.isSafeInteger(value))) return null;
  return { major: values[0], minor: values[1], patch: values[2], text: tag };
}

export function compareZigVersions(left: ZigSemanticVersion, right: ZigSemanticVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch ||
    compareText(left.text, right.text);
}

export function parseZigSelector(selector: string): ZigSelector {
  if (selector.length === 0 || selector.trim() !== selector) {
    throw new InvalidZigSelectorError(
      selector,
      "selector must be nonempty without surrounding whitespace",
    );
  }
  if (/\p{Cc}/u.test(selector)) {
    throw new InvalidZigSelectorError(selector, "selector contains a control character");
  }
  const exact = parseZigTag(selector);
  if (exact) return { kind: "exact", value: selector, version: exact };
  const minor = MINOR_VERSION.exec(selector);
  if (minor) {
    const major = Number(minor[1]);
    const minorNumber = Number(minor[2]);
    if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minorNumber)) {
      throw new InvalidZigSelectorError(selector, "version component is too large");
    }
    return { kind: "minor", value: selector, major, minor: minorNumber };
  }
  for (const kind of ["tag", "branch"] as const) {
    const prefix = `${kind}:`;
    if (selector.startsWith(prefix)) {
      const value = selector.slice(prefix.length);
      if (value.length === 0) throw new InvalidZigSelectorError(selector, `${kind} name is empty`);
      return { kind, value };
    }
  }
  if (selector.startsWith("commit:")) {
    const value = selector.slice("commit:".length);
    if (!COMMIT.test(value)) {
      throw new InvalidZigSelectorError(
        selector,
        "commit must be an exact 40- or 64-digit object ID",
      );
    }
    return { kind: "commit", value: value.toLowerCase() };
  }
  throw new InvalidZigSelectorError(
    selector,
    "expected x.y.z, x.y, tag:<name>, branch:<name>, or commit:<object-id>",
  );
}

export function listStableZigVersions(refs: readonly RemoteRef[]): ZigSemanticVersion[] {
  const byText = new Map<string, ZigSemanticVersion>();
  for (const ref of refs) {
    if (ref.kind !== "tag") continue;
    const version = parseZigTag(ref.name);
    if (version) byText.set(version.text, version);
  }
  return [...byText.values()].sort((left, right) => compareZigVersions(right, left));
}

export function resolveZigSelector(
  selectorText: string,
  refs: readonly RemoteRef[],
): ResolvedZigSelection {
  const selector = parseZigSelector(selectorText);
  if (selector.kind === "commit") {
    return {
      selector: selectorText,
      ref: { kind: "commit", value: selector.value },
      remoteCommit: selector.value,
    };
  }

  if (selector.kind === "tag" || selector.kind === "branch") {
    const remote = refs.find((ref) => ref.kind === selector.kind && ref.name === selector.value);
    if (!remote) throw new ZigVersionNotFoundError(selectorText);
    assertRemoteCommit(remote.commit, selectorText);
    return {
      selector: selectorText,
      ref: { kind: selector.kind, value: selector.value },
      remoteCommit: remote.commit.toLowerCase(),
    };
  }

  const candidates = refs.flatMap((ref) => {
    if (ref.kind !== "tag") return [];
    const version = parseZigTag(ref.name);
    if (!version) return [];
    if (selector.kind === "exact") {
      return version.text === selector.value ? [{ ref, version }] : [];
    }
    return version.major === selector.major && version.minor === selector.minor
      ? [{ ref, version }]
      : [];
  }).sort((left, right) => {
    return compareZigVersions(right.version, left.version) ||
      compareText(left.ref.commit, right.ref.commit);
  });
  const selected = candidates[0];
  if (!selected) throw new ZigVersionNotFoundError(selectorText);
  assertRemoteCommit(selected.ref.commit, selectorText);
  return {
    selector: selectorText,
    ref: { kind: "tag", value: selected.version.text },
    remoteCommit: selected.ref.commit.toLowerCase(),
  };
}

function assertRemoteCommit(commit: string, selector: string): void {
  if (!COMMIT.test(commit)) {
    throw new InvalidZigSelectorError(selector, "source-ref returned a malformed remote commit ID");
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
