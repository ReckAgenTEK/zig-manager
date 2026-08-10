import { join } from "@std/path";
import { STATE_SCHEMA_VERSION, ZIG_MANAGER_STATE_FILE } from "./constants.ts";
import { ZigStateValidationError } from "./errors.ts";
import { atomicWriteJson } from "./filesystem.ts";
import { validateZigSourceVersion } from "./source_version.ts";
import type {
  ActiveBuildState,
  ActiveDocsState,
  GitRef,
  SourceSelectionState,
  ZigManagerState,
} from "./types.ts";

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function statePath(repositoryHome: string): string {
  return join(repositoryHome, ZIG_MANAGER_STATE_FILE);
}

export function emptyState(): ZigManagerState {
  return { schemaVersion: STATE_SCHEMA_VERSION, source: null, activeBuild: null, docs: null };
}

export async function readZigManagerState(repositoryHome: string): Promise<ZigManagerState> {
  const path = statePath(repositoryHome);
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return emptyState();
    throw new ZigStateValidationError(path, "state file could not be read", { cause });
  }
  try {
    return validateState(JSON.parse(text));
  } catch (cause) {
    if (cause instanceof ZigStateValidationError) throw cause;
    throw new ZigStateValidationError(
      path,
      cause instanceof Error ? cause.message : String(cause),
      { cause },
    );
  }
}

export async function writeZigManagerState(
  repositoryHome: string,
  state: ZigManagerState,
): Promise<void> {
  const path = statePath(repositoryHome);
  try {
    const validated = validateState(state);
    await atomicWriteJson(path, validated);
  } catch (cause) {
    if (cause instanceof ZigStateValidationError) throw cause;
    throw new ZigStateValidationError(
      path,
      cause instanceof Error ? cause.message : String(cause),
      { cause },
    );
  }
}

export function validateState(value: unknown): ZigManagerState {
  const root = object(value, "root", ["schemaVersion", "source", "activeBuild", "docs"]);
  if (root.schemaVersion === 1) return migrateStateV1(root);
  if (root.schemaVersion !== STATE_SCHEMA_VERSION) {
    throw new Error(`schemaVersion must be ${STATE_SCHEMA_VERSION}`);
  }
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    source: root.source === null ? null : source(root.source),
    activeBuild: root.activeBuild === null ? null : activeBuild(root.activeBuild),
    docs: root.docs === null ? null : activeDocs(root.docs),
  };
}

function source(value: unknown): SourceSelectionState {
  const item = object(value, "source", [
    "selector",
    "version",
    "ref",
    "commit",
    "repositoryHome",
    "checkoutPath",
  ]);
  const selectedCommit = commit(item.commit, "source.commit");
  const version = validateZigSourceVersion(item.version, "source.version");
  if (!selectedCommit.startsWith(version.commitAbbreviation)) {
    throw new Error("source.version.commitAbbreviation does not identify source.commit");
  }
  return {
    selector: text(item.selector, "source.selector"),
    version,
    ref: gitRef(item.ref),
    commit: selectedCommit,
    repositoryHome: text(item.repositoryHome, "source.repositoryHome"),
    checkoutPath: text(item.checkoutPath, "source.checkoutPath"),
  };
}

function migrateStateV1(root: Record<string, unknown>): ZigManagerState {
  const oldSource = root.source === null ? null : sourceV1(root.source);
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    source: oldSource,
    activeBuild: root.activeBuild === null ? null : activeBuild(root.activeBuild),
    docs: root.docs === null ? null : activeDocs(root.docs),
  };
}

function sourceV1(value: unknown): SourceSelectionState {
  const item = object(value, "source", [
    "selector",
    "exactVersion",
    "ref",
    "commit",
    "repositoryHome",
    "checkoutPath",
  ]);
  const exactVersion = text(item.exactVersion, "source.exactVersion");
  const selectedCommit = commit(item.commit, "source.commit");
  const version = validateZigSourceVersion({
    kind: "release",
    base: exactVersion,
    text: exactVersion,
    taggedAncestor: exactVersion,
    commitsAfterTag: 0,
    commitAbbreviation: selectedCommit.slice(0, 9),
  }, "source.version");
  return {
    selector: text(item.selector, "source.selector"),
    version,
    ref: gitRef(item.ref),
    commit: selectedCommit,
    repositoryHome: text(item.repositoryHome, "source.repositoryHome"),
    checkoutPath: text(item.checkoutPath, "source.checkoutPath"),
  };
}

function activeBuild(value: unknown): ActiveBuildState {
  const item = object(value, "activeBuild", [
    "commit",
    "identity",
    "manifestPath",
    "executablePath",
  ]);
  return {
    commit: commit(item.commit, "activeBuild.commit"),
    identity: hash(item.identity, "activeBuild.identity"),
    manifestPath: text(item.manifestPath, "activeBuild.manifestPath"),
    executablePath: text(item.executablePath, "activeBuild.executablePath"),
  };
}

function activeDocs(value: unknown): ActiveDocsState {
  const item = object(value, "docs", ["commit", "manifestPath", "directory", "megaPath"]);
  return {
    commit: commit(item.commit, "docs.commit"),
    manifestPath: text(item.manifestPath, "docs.manifestPath"),
    directory: text(item.directory, "docs.directory"),
    megaPath: nullableText(item.megaPath, "docs.megaPath"),
  };
}

function gitRef(value: unknown): GitRef {
  const item = object(value, "source.ref", ["kind", "value"]);
  if (item.kind !== "tag" && item.kind !== "branch" && item.kind !== "commit") {
    throw new Error("source.ref.kind is invalid");
  }
  return { kind: item.kind, value: text(item.value, "source.ref.value") } as GitRef;
}

function object(value: unknown, path: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const result = value as Record<string, unknown>;
  const unknown = Object.keys(result).filter((key) => !keys.includes(key)).sort();
  if (unknown.length > 0) throw new Error(`${path} contains unknown key '${unknown[0]}'`);
  for (const key of keys) if (!(key in result)) throw new Error(`${path}.${key} is required`);
  return result;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a nonempty string`);
  }
  return value;
}

function nullableText(value: unknown, path: string): string | null {
  return value === null ? null : text(value, path);
}

function commit(value: unknown, path: string): string {
  const result = text(value, path);
  if (!COMMIT.test(result)) {
    throw new Error(`${path} must be a lowercase 40- or 64-digit object ID`);
  }
  return result;
}

function hash(value: unknown, path: string): string {
  const result = text(value, path);
  if (!/^[0-9a-f]{64}$/.test(result)) throw new Error(`${path} must be a lowercase SHA-256 digest`);
  return result;
}
