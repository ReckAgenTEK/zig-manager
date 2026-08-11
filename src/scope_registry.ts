import { dirname, isAbsolute, join, resolve } from "@std/path";
import {
  parseScopePin,
  resolvePhysicalScopeDirectory,
  SCOPE_DIRECTORY_NAME,
  SCOPE_PIN_FILE_NAME,
  SCOPE_PIN_SIZE_WITH_FINAL_NEWLINE,
  SCOPE_PIN_SIZE_WITHOUT_FINAL_NEWLINE,
} from "./scope_resolver.ts";

export const SCOPE_REGISTRY_SCHEMA_VERSION = 1 as const;
export const SCOPE_REGISTRY_MAX_BYTES = 4 * 1024 * 1024;
export const SCOPE_REGISTRY_MAX_SCOPES = 16_384;
export const SCOPE_REGISTRY_MAX_OPERATION_LENGTH = 512;

const PROFILE_ID = /^[0-9a-f]{64}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const encoder = new TextEncoder();

export interface ScopeRegistryEntryV1 {
  readonly scopeRoot: string;
  readonly profileId: string;
  readonly lastOperation: string;
  readonly updatedAt: string;
}

export interface ScopeRegistryV1 {
  readonly schemaVersion: 1;
  readonly scopes: readonly ScopeRegistryEntryV1[];
}

export type ScopeRegistryClassification =
  | "live"
  | "moved"
  | "deleted"
  | "unverifiable";

export interface ClassifiedScopeRegistryEntry {
  readonly entry: ScopeRegistryEntryV1;
  /** `deleted` means absent at the registered path, not proof that no moved copy exists. */
  readonly classification: ScopeRegistryClassification;
  readonly physicalScopeRoot: string | null;
  readonly pinPath: string | null;
  readonly observedProfileId: string | null;
  readonly profileMatches: boolean | null;
  readonly reason: string | null;
}

export interface ScopeRegistryKnownPin {
  readonly registeredScopeRoot: string;
  readonly physicalScopeRoot: string;
  readonly pinPath: string;
  readonly profileId: string | null;
  readonly valid: boolean;
}

export interface ScopeRegistryInspection {
  readonly registryPresent: boolean;
  readonly registry: ScopeRegistryV1 | null;
  readonly entries: readonly ClassifiedScopeRegistryEntry[];
  /** Recorded IDs plus every different valid ID observed on disk. */
  readonly referencedProfileIds: readonly string[];
  readonly definitelyReferencedProfileIds: readonly string[];
  readonly uncertainProfileIds: readonly string[];
  /** False means cleanup must retain all profiles, not merely the IDs listed above. */
  readonly profilePruningSafe: boolean;
  /** External pins to report, never paths for registry cleanup to delete. */
  readonly knownPins: readonly ScopeRegistryKnownPin[];
}

export interface ScopeRegistryProfileReferences {
  readonly registryPresent: boolean;
  readonly profileIds: readonly string[];
  readonly definitelyReferencedProfileIds: readonly string[];
  readonly uncertainProfileIds: readonly string[];
  readonly complete: boolean;
}

export interface ScopeRegistryStoreOptions {
  readonly registryPath: string;
  readonly now?: () => Date;
}

export class ScopeRegistryValidationError extends TypeError {
  readonly code = "ZIG_SCOPE_REGISTRY_INVALID";
  readonly path: string;
  readonly registryPath: string;
  readonly reason: string;

  constructor(path: string, reason: string, options?: ErrorOptions) {
    super(`Invalid scope registry '${path}': ${reason}`, options);
    this.name = "ScopeRegistryValidationError";
    this.path = path;
    this.registryPath = path;
    this.reason = reason;
  }
}

export function validateScopeRegistry(value: unknown): ScopeRegistryV1 {
  const root = strictObject(value, "root", ["schemaVersion", "scopes"]);
  equal(root.schemaVersion, SCOPE_REGISTRY_SCHEMA_VERSION, "schemaVersion");
  if (!Array.isArray(root.scopes)) throw new TypeError("scopes must be an array");
  if (root.scopes.length > SCOPE_REGISTRY_MAX_SCOPES) {
    throw new TypeError(`scopes must contain at most ${SCOPE_REGISTRY_MAX_SCOPES} entries`);
  }

  const scopes = root.scopes.map((value, index) =>
    validateScopeRegistryEntry(value, `scopes[${index}]`)
  );
  for (let index = 1; index < scopes.length; index++) {
    if (scopes[index - 1].scopeRoot >= scopes[index].scopeRoot) {
      throw new TypeError("scopes must be strictly sorted by scopeRoot without duplicates");
    }
  }

  const registry: ScopeRegistryV1 = {
    schemaVersion: SCOPE_REGISTRY_SCHEMA_VERSION,
    scopes,
  };
  assertSerializedSize(registry);
  return registry;
}

export function parseScopeRegistry(
  text: string,
  registryPath = "<scope-registry>",
): ScopeRegistryV1 {
  try {
    if (typeof text !== "string") throw new TypeError("registry content must be text");
    if (encoder.encode(text).byteLength > SCOPE_REGISTRY_MAX_BYTES) {
      throw new TypeError(`registry exceeds ${SCOPE_REGISTRY_MAX_BYTES} bytes`);
    }
    return validateScopeRegistry(JSON.parse(text));
  } catch (cause) {
    if (cause instanceof ScopeRegistryValidationError) throw cause;
    throw new ScopeRegistryValidationError(registryPath, errorMessage(cause), { cause });
  }
}

export function serializeScopeRegistry(value: unknown): string {
  const registry = validateScopeRegistry(value);
  const text = `${JSON.stringify(registry, null, 2)}\n`;
  if (encoder.encode(text).byteLength > SCOPE_REGISTRY_MAX_BYTES) {
    throw new TypeError(`registry exceeds ${SCOPE_REGISTRY_MAX_BYTES} bytes`);
  }
  return text;
}

/** Strict advisory registry. Cross-process callers must retain the manager metadata lock. */
export class ScopeRegistryStore {
  readonly path: string;
  readonly registryPath: string;
  readonly #now: () => Date;

  constructor(input: string | ScopeRegistryStoreOptions) {
    const options = typeof input === "string" ? { registryPath: input } : input;
    this.path = normalizeRegistryPath(options.registryPath);
    this.registryPath = this.path;
    this.#now = options.now ?? (() => new Date());
  }

  async read(): Promise<ScopeRegistryV1 | null> {
    return await this.#read();
  }

  /** Upsert only after the exact physical scope pin has been published and verified. */
  async record(
    scopePath: string,
    profileIdValue: string,
    lastOperationValue: string,
  ): Promise<ScopeRegistryEntryV1> {
    const profileId = validateProfileId(profileIdValue, "profileId");
    const lastOperation = operation(lastOperationValue, "lastOperation");
    return await serializeMutation(this.path, async () => {
      let scopeRoot: string;
      try {
        scopeRoot = validateScopeRoot(
          await resolvePhysicalScopeDirectory(scopePath),
          "scopeRoot",
        );
      } catch (cause) {
        throw this.#error("scope path could not be resolved physically", cause);
      }

      const pin = await inspectExactPin(scopeRoot);
      if (pin.kind !== "valid") {
        throw new ScopeRegistryValidationError(
          this.path,
          `exact scope pin must be published before recording '${scopeRoot}': ${pin.reason}`,
        );
      }
      if (pin.profileId !== profileId) {
        throw new ScopeRegistryValidationError(
          this.path,
          `published scope pin references profile ${pin.profileId}, not ${profileId}`,
        );
      }

      const current = await this.#read() ?? emptyRegistry();
      let updatedAt: string;
      try {
        updatedAt = dateTimestamp(this.#now(), "now()");
      } catch (cause) {
        throw this.#error("injected clock returned an invalid value", cause);
      }
      const entry: ScopeRegistryEntryV1 = {
        scopeRoot,
        profileId,
        lastOperation,
        updatedAt,
      };
      const scopes = current.scopes.filter((item) => item.scopeRoot !== scopeRoot);
      scopes.push(entry);
      scopes.sort(compareScopeRoots);
      await this.#write(validateScopeRegistry({
        schemaVersion: SCOPE_REGISTRY_SCHEMA_VERSION,
        scopes,
      }));
      return entry;
    });
  }

  /** Remove only the exact entry, and only after its exact on-disk pin is absent. */
  async remove(scopePath: string): Promise<boolean> {
    return await serializeMutation(this.path, async () => {
      let scopeRoot: string;
      try {
        scopeRoot = validateScopeRoot(
          await resolvePhysicalScopeDirectory(scopePath),
          "scopeRoot",
        );
      } catch (cause) {
        throw this.#error("scope path could not be resolved physically", cause);
      }

      const current = await this.#read();
      if (current === null || !current.scopes.some((item) => item.scopeRoot === scopeRoot)) {
        return false;
      }

      const pin = await inspectExactPin(scopeRoot);
      if (pin.kind === "valid") {
        throw new ScopeRegistryValidationError(
          this.path,
          `refusing to remove '${scopeRoot}' while its exact scope pin is still published`,
        );
      }
      if (pin.kind === "invalid") {
        throw new ScopeRegistryValidationError(
          this.path,
          `refusing to remove '${scopeRoot}' because exact pin absence is unverifiable: ${pin.reason}`,
        );
      }

      await this.#write(validateScopeRegistry({
        schemaVersion: SCOPE_REGISTRY_SCHEMA_VERSION,
        scopes: current.scopes.filter((item) => item.scopeRoot !== scopeRoot),
      }));
      return true;
    });
  }

  async classify(): Promise<readonly ClassifiedScopeRegistryEntry[]> {
    const registry = await this.#read();
    return registry === null ? [] : await classifyEntries(registry.scopes);
  }

  async inspect(): Promise<ScopeRegistryInspection> {
    const registry = await this.#read();
    const entries = registry === null ? [] : await classifyEntries(registry.scopes);
    const definite = new Set<string>();
    const uncertain = new Set<string>();
    const referenced = new Set<string>();
    const knownPins: ScopeRegistryKnownPin[] = [];

    for (const classified of entries) {
      const { entry, observedProfileId } = classified;
      referenced.add(entry.profileId);
      if (observedProfileId !== null) {
        definite.add(observedProfileId);
        referenced.add(observedProfileId);
      }
      if (classified.profileMatches !== true) uncertain.add(entry.profileId);
      if (classified.pinPath !== null && classified.physicalScopeRoot !== null) {
        knownPins.push({
          registeredScopeRoot: entry.scopeRoot,
          physicalScopeRoot: classified.physicalScopeRoot,
          pinPath: classified.pinPath,
          profileId: observedProfileId,
          valid: observedProfileId !== null,
        });
      }
    }
    knownPins.sort((left, right) => compareText(left.pinPath, right.pinPath));

    return {
      registryPresent: registry !== null,
      registry,
      entries,
      referencedProfileIds: sorted(referenced),
      definitelyReferencedProfileIds: sorted(definite),
      uncertainProfileIds: sorted(uncertain),
      profilePruningSafe: registry !== null &&
        entries.every((entry) => entry.classification === "live" && entry.profileMatches === true),
      knownPins,
    };
  }

  async referencedProfiles(): Promise<ScopeRegistryProfileReferences> {
    const inspection = await this.inspect();
    return {
      registryPresent: inspection.registryPresent,
      profileIds: inspection.referencedProfileIds,
      definitelyReferencedProfileIds: inspection.definitelyReferencedProfileIds,
      uncertainProfileIds: inspection.uncertainProfileIds,
      complete: inspection.profilePruningSafe,
    };
  }

  async #read(): Promise<ScopeRegistryV1 | null> {
    try {
      const parent = dirname(this.path);
      const parentInfo = await lstatIfPresent(parent);
      if (parentInfo === null) return null;
      await assertPhysicalDirectory(parent, parentInfo, "registry parent");

      const info = await lstatIfPresent(this.path);
      if (info === null) return null;
      if (!info.isFile || info.isSymlink) {
        throw new TypeError("registry path is not a physical regular file");
      }
      if (info.size > SCOPE_REGISTRY_MAX_BYTES) {
        throw new TypeError(`registry exceeds ${SCOPE_REGISTRY_MAX_BYTES} bytes`);
      }
      return parseScopeRegistry(
        await readUtf8Bounded(this.path, SCOPE_REGISTRY_MAX_BYTES),
        this.path,
      );
    } catch (cause) {
      if (cause instanceof ScopeRegistryValidationError) throw cause;
      throw this.#error("registry could not be read safely", cause);
    }
  }

  async #write(registry: ScopeRegistryV1): Promise<void> {
    let text: string;
    try {
      text = serializeScopeRegistry(registry);
    } catch (cause) {
      throw this.#error("registry could not be serialized", cause);
    }

    const temporary = `${this.path}.tmp-${crypto.randomUUID()}`;
    let file: Deno.FsFile | undefined;
    try {
      await ensurePhysicalDirectoryTree(dirname(this.path));
      const current = await lstatIfPresent(this.path);
      if (current !== null && (!current.isFile || current.isSymlink)) {
        throw new TypeError("existing registry path is not a physical regular file");
      }

      file = await Deno.open(temporary, { createNew: true, write: true, mode: 0o600 });
      await writeAll(file, encoder.encode(text));
      await file.sync();
      file.close();
      file = undefined;

      const temporaryInfo = await Deno.lstat(temporary);
      if (!temporaryInfo.isFile || temporaryInfo.isSymlink) {
        throw new TypeError("temporary registry is not a physical regular file");
      }
      parseScopeRegistry(
        await readUtf8Bounded(temporary, SCOPE_REGISTRY_MAX_BYTES),
        temporary,
      );
      await Deno.rename(temporary, this.path);
    } catch (cause) {
      file?.close();
      await removeTemporary(temporary);
      throw new ScopeRegistryValidationError(
        this.path,
        "registry could not be written atomically",
        { cause },
      );
    }
  }

  #error(reason: string, cause: unknown): ScopeRegistryValidationError {
    if (cause instanceof ScopeRegistryValidationError) return cause;
    return new ScopeRegistryValidationError(
      this.path,
      `${reason}: ${errorMessage(cause)}`,
      { cause },
    );
  }
}

export async function readScopeRegistry(path: string): Promise<ScopeRegistryV1 | null> {
  return await new ScopeRegistryStore(path).read();
}

async function classifyEntries(
  entries: readonly ScopeRegistryEntryV1[],
): Promise<ClassifiedScopeRegistryEntry[]> {
  const result: ClassifiedScopeRegistryEntry[] = [];
  for (const entry of entries) result.push(await classifyEntry(entry));
  return result;
}

async function classifyEntry(
  entry: ScopeRegistryEntryV1,
): Promise<ClassifiedScopeRegistryEntry> {
  let rootInfo: Deno.FileInfo | null;
  try {
    rootInfo = await lstatIfPresent(entry.scopeRoot);
  } catch (cause) {
    return classified(entry, "unverifiable", null, null, null, null, errorMessage(cause));
  }
  if (rootInfo === null) {
    return classified(
      entry,
      "deleted",
      null,
      null,
      null,
      null,
      "scope is absent at its registered path; an external move cannot be ruled out",
    );
  }
  if (!rootInfo.isDirectory && !rootInfo.isSymlink) {
    return classified(
      entry,
      "unverifiable",
      null,
      null,
      null,
      null,
      "registered scope path is no longer a directory",
    );
  }

  let physicalScopeRoot: string;
  try {
    physicalScopeRoot = validateScopeRoot(
      resolve(await Deno.realPath(entry.scopeRoot)),
      "physicalScopeRoot",
    );
    const physicalInfo = await Deno.lstat(physicalScopeRoot);
    if (!physicalInfo.isDirectory || physicalInfo.isSymlink) {
      throw new TypeError("resolved scope path is not a physical directory");
    }
  } catch (cause) {
    if (rootInfo.isSymlink && cause instanceof Deno.errors.NotFound) {
      return classified(
        entry,
        "moved",
        null,
        null,
        null,
        null,
        "registered scope was replaced by a dangling relocation link",
      );
    }
    return classified(
      entry,
      "unverifiable",
      null,
      null,
      null,
      null,
      `scope path cannot be resolved safely: ${errorMessage(cause)}`,
    );
  }

  const moved = rootInfo.isSymlink || physicalScopeRoot !== entry.scopeRoot;
  const pin = await inspectExactPin(physicalScopeRoot);
  if (pin.kind === "valid") {
    const matches = pin.profileId === entry.profileId;
    return classified(
      entry,
      moved ? "moved" : "live",
      physicalScopeRoot,
      pin.pinPath,
      pin.profileId,
      matches,
      moved
        ? `registered scope now resolves to '${physicalScopeRoot}'`
        : matches
        ? null
        : `valid scope pin references profile ${pin.profileId}, not recorded profile ${entry.profileId}`,
    );
  }

  if (moved) {
    return classified(
      entry,
      pin.kind === "invalid" ? "unverifiable" : "moved",
      physicalScopeRoot,
      pin.pinPath,
      null,
      null,
      `registered scope moved to '${physicalScopeRoot}', but ${pin.reason}`,
    );
  }
  if (pin.kind === "missing") {
    return classified(
      entry,
      "deleted",
      physicalScopeRoot,
      null,
      null,
      null,
      `${pin.reason}; an external move cannot be ruled out`,
    );
  }
  return classified(
    entry,
    "unverifiable",
    physicalScopeRoot,
    pin.pinPath,
    null,
    null,
    pin.reason,
  );
}

function classified(
  entry: ScopeRegistryEntryV1,
  classification: ScopeRegistryClassification,
  physicalScopeRoot: string | null,
  pinPath: string | null,
  observedProfileId: string | null,
  profileMatches: boolean | null,
  reason: string | null,
): ClassifiedScopeRegistryEntry {
  return {
    entry,
    classification,
    physicalScopeRoot,
    pinPath,
    observedProfileId,
    profileMatches,
    reason,
  };
}

type ExactPinInspection =
  | { readonly kind: "valid"; readonly pinPath: string; readonly profileId: string }
  | { readonly kind: "missing"; readonly pinPath: null; readonly reason: string }
  | { readonly kind: "invalid"; readonly pinPath: string | null; readonly reason: string };

async function inspectExactPin(scopeRoot: string): Promise<ExactPinInspection> {
  const metadataDirectory = join(scopeRoot, SCOPE_DIRECTORY_NAME);
  const pinPath = join(metadataDirectory, SCOPE_PIN_FILE_NAME);
  try {
    const metadataInfo = await lstatIfPresent(metadataDirectory);
    if (metadataInfo === null) {
      return { kind: "missing", pinPath: null, reason: "exact scope metadata is absent" };
    }
    if (!metadataInfo.isDirectory || metadataInfo.isSymlink) {
      return {
        kind: "invalid",
        pinPath,
        reason: "scope metadata path is not a physical directory",
      };
    }
    if (resolve(await Deno.realPath(metadataDirectory)) !== resolve(metadataDirectory)) {
      return {
        kind: "invalid",
        pinPath,
        reason: "scope metadata path traverses a symbolic link",
      };
    }

    const pinInfo = await lstatIfPresent(pinPath);
    if (pinInfo === null) {
      return { kind: "missing", pinPath: null, reason: "exact scope pin is absent" };
    }
    if (!pinInfo.isFile || pinInfo.isSymlink) {
      return {
        kind: "invalid",
        pinPath,
        reason: "exact scope pin is not a physical regular file",
      };
    }
    if (
      pinInfo.size !== SCOPE_PIN_SIZE_WITHOUT_FINAL_NEWLINE &&
      pinInfo.size !== SCOPE_PIN_SIZE_WITH_FINAL_NEWLINE
    ) {
      return {
        kind: "invalid",
        pinPath,
        reason: "exact scope pin does not contain exactly two protocol lines",
      };
    }
    if (resolve(await Deno.realPath(pinPath)) !== resolve(pinPath)) {
      return {
        kind: "invalid",
        pinPath,
        reason: "exact scope pin traverses a symbolic link",
      };
    }

    const pin = parseScopePin(
      await readUtf8Bounded(pinPath, SCOPE_PIN_SIZE_WITH_FINAL_NEWLINE),
      pinPath,
    );
    return { kind: "valid", pinPath, profileId: pin.profileId };
  } catch (cause) {
    return {
      kind: "invalid",
      pinPath: await pathIsPresent(pinPath) ? pinPath : null,
      reason: `exact scope pin cannot be inspected safely: ${errorMessage(cause)}`,
    };
  }
}

function validateScopeRegistryEntry(value: unknown, path: string): ScopeRegistryEntryV1 {
  const root = strictObject(value, path, [
    "scopeRoot",
    "profileId",
    "lastOperation",
    "updatedAt",
  ]);
  return {
    scopeRoot: validateScopeRoot(root.scopeRoot, `${path}.scopeRoot`),
    profileId: validateProfileId(root.profileId, `${path}.profileId`),
    lastOperation: operation(root.lastOperation, `${path}.lastOperation`),
    updatedAt: timestamp(root.updatedAt, `${path}.updatedAt`),
  };
}

function validateScopeRoot(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${path} must be a nonempty path`);
  }
  rejectControls(value, path);
  if (!isAbsolute(value)) throw new TypeError(`${path} must be absolute`);
  if (resolve(value) !== value) throw new TypeError(`${path} must be normalized`);
  return value;
}

function validateProfileId(value: unknown, path: string): string {
  if (typeof value !== "string" || !PROFILE_ID.test(value)) {
    throw new TypeError(`${path} must be exactly 64 lowercase hexadecimal characters`);
  }
  return value;
}

function operation(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${path} must be nonempty without surrounding whitespace`);
  }
  if (value.length > SCOPE_REGISTRY_MAX_OPERATION_LENGTH) {
    throw new TypeError(
      `${path} must contain at most ${SCOPE_REGISTRY_MAX_OPERATION_LENGTH} characters`,
    );
  }
  rejectControls(value, path);
  return value;
}

function timestamp(value: unknown, path: string): string {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) {
    throw new TypeError(`${path} must be a UTC RFC 3339 timestamp`);
  }
  const date = new Date(value);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString() !== (value.includes(".") ? value : value.replace("Z", ".000Z"))
  ) {
    throw new TypeError(`${path} must be a valid timestamp`);
  }
  return value;
}

function dateTimestamp(value: Date, path: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${path} must return a valid Date`);
  }
  return value.toISOString();
}

function strictObject(
  value: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const result = value as Record<string, unknown>;
  const unknown = Object.keys(result).filter((key) => !keys.includes(key)).sort();
  if (unknown.length > 0) throw new TypeError(`${path} contains unknown key '${unknown[0]}'`);
  for (const key of keys) {
    if (!hasOwn(result, key)) throw new TypeError(`${path}.${key} is required`);
  }
  return result;
}

function equal(actual: unknown, expected: unknown, path: string): void {
  if (actual !== expected) throw new TypeError(`${path} must equal ${String(expected)}`);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function rejectControls(value: string, path: string): void {
  if (/\p{Cc}/u.test(value)) throw new TypeError(`${path} contains a control character`);
}

function assertSerializedSize(registry: ScopeRegistryV1): void {
  const size = encoder.encode(`${JSON.stringify(registry, null, 2)}\n`).byteLength;
  if (size > SCOPE_REGISTRY_MAX_BYTES) {
    throw new TypeError(`registry exceeds ${SCOPE_REGISTRY_MAX_BYTES} bytes`);
  }
}

function emptyRegistry(): ScopeRegistryV1 {
  return { schemaVersion: SCOPE_REGISTRY_SCHEMA_VERSION, scopes: [] };
}

function compareScopeRoots(left: ScopeRegistryEntryV1, right: ScopeRegistryEntryV1): number {
  return compareText(left.scopeRoot, right.scopeRoot);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sorted(values: ReadonlySet<string>): string[] {
  return [...values].sort(compareText);
}

function normalizeRegistryPath(path: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError("scope registry path must be nonempty");
  }
  rejectControls(path, "scope registry path");
  const normalized = resolve(path);
  if (dirname(normalized) === normalized) {
    throw new TypeError("scope registry path must identify a file");
  }
  return normalized;
}

async function ensurePhysicalDirectoryTree(path: string): Promise<void> {
  const target = resolve(path);
  const missing: string[] = [];
  let current = target;
  while (true) {
    const info = await lstatIfPresent(current);
    if (info !== null) {
      await assertPhysicalDirectory(current, info, "directory");
      break;
    }
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) throw new TypeError(`no physical ancestor exists for ${target}`);
    current = parent;
  }
  for (const directory of missing.reverse()) {
    try {
      await Deno.mkdir(directory, { mode: 0o700 });
    } catch (cause) {
      if (!(cause instanceof Deno.errors.AlreadyExists)) throw cause;
    }
    await assertPhysicalDirectory(directory, await Deno.lstat(directory), "directory");
  }
}

async function assertPhysicalDirectory(
  path: string,
  info: Deno.FileInfo,
  label: string,
): Promise<void> {
  if (!info.isDirectory || info.isSymlink) {
    throw new TypeError(`${label} is not a physical directory: ${path}`);
  }
  if (resolve(await Deno.realPath(path)) !== resolve(path)) {
    throw new TypeError(`${label} traverses a symbolic link: ${path}`);
  }
}

async function lstatIfPresent(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.lstat(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return null;
    throw cause;
  }
}

async function pathIsPresent(path: string): Promise<boolean> {
  try {
    return await lstatIfPresent(path) !== null;
  } catch {
    return false;
  }
}

async function readUtf8Bounded(path: string, maximum: number): Promise<string> {
  const file = await Deno.open(path, { read: true });
  try {
    const chunks: Uint8Array[] = [];
    const buffer = new Uint8Array(Math.min(64 * 1024, maximum + 1));
    let total = 0;
    while (true) {
      const count = await file.read(buffer);
      if (count === null) break;
      total += count;
      if (total > maximum) throw new TypeError(`file exceeds ${maximum} bytes`);
      chunks.push(buffer.slice(0, count));
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } finally {
    file.close();
  }
}

async function writeAll(file: Deno.FsFile, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const count = await file.write(bytes.subarray(offset));
    if (count === 0) throw new TypeError("registry write made no progress");
    offset += count;
  }
}

async function removeTemporary(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound)) {
      // Preserve the original atomic-write failure.
    }
  }
}

const mutationTails = new Map<string, Promise<void>>();

function serializeMutation<T>(path: string, action: () => Promise<T>): Promise<T> {
  const previous = mutationTails.get(path) ?? Promise.resolve();
  const result = previous.then(action, action);
  const tail = result.then(() => undefined, () => undefined);
  mutationTails.set(path, tail);
  void tail.then(() => {
    if (mutationTails.get(path) === tail) mutationTails.delete(path);
  });
  return result;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
