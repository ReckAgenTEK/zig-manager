import { join, resolve } from "@std/path";
import { ZigOperationAbortedError } from "./errors.ts";
import { atomicWriteJson, pathExists } from "./filesystem.ts";
import {
  type InstallDependency,
  type InstalledObject,
  type InstallManifestV3,
  InstallStore,
  validateInstallationId,
  validateInstallComponent,
  validateInstallManifest,
  validateTimestamp,
} from "./install_store.ts";
import {
  type StoredToolchainProfile,
  ToolchainProfileStore,
  type ToolchainProfileV1,
  validateProfileId,
  validateToolchainProfile,
} from "./profile_store.ts";

export const CATALOG_SCHEMA_VERSION = 3 as const;

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface CatalogInstallationV3 {
  readonly component: "zig" | "zls";
  readonly installationId: string;
  readonly version: string;
  readonly commit: string;
  readonly createdAt: string;
  readonly dependencies: readonly InstallDependency[];
}

export interface CatalogProfileV3 {
  readonly profileId: string;
  readonly requestedSelector: string;
  readonly resolvedCommit: string;
  readonly zigInstallationId: string;
  readonly zlsInstallationId: string | null;
  readonly createdAt: string;
}

export interface CatalogV3 {
  readonly schemaVersion: 3;
  readonly generatedAt: string;
  readonly installations: readonly CatalogInstallationV3[];
  readonly profiles: readonly CatalogProfileV3[];
}

export interface InstallCatalogSource {
  list(): Promise<readonly InstalledObject[]>;
  get(component: "zig" | "zls", installationId: string): Promise<InstalledObject>;
}

export interface ProfileCatalogSource {
  list(): Promise<readonly StoredToolchainProfile[]>;
}

export interface GlobalCatalogOptions {
  readonly dataRoot: string;
  readonly stateRoot: string;
  readonly installs?: InstallCatalogSource;
  readonly profiles?: ProfileCatalogSource;
  readonly now?: () => Date;
}

export interface CatalogMutationOptions {
  readonly operationId?: string;
  readonly signal?: AbortSignal;
}

export class CatalogValidationError extends Error {
  readonly path: string;

  constructor(path: string, reason: string, options?: ErrorOptions) {
    super(`Invalid catalog '${path}': ${reason}`, options);
    this.name = "CatalogValidationError";
    this.path = path;
  }
}

export function validateCatalog(value: unknown): CatalogV3 {
  const root = strictObject(value, "root", [
    "schemaVersion",
    "generatedAt",
    "installations",
    "profiles",
  ]);
  equal(root.schemaVersion, CATALOG_SCHEMA_VERSION, "schemaVersion");
  if (!Array.isArray(root.installations)) throw new TypeError("installations must be an array");
  if (!Array.isArray(root.profiles)) throw new TypeError("profiles must be an array");
  const installations = root.installations.map((item, index) =>
    catalogInstallation(item, `installations[${index}]`)
  );
  const profiles = root.profiles.map((item, index) => catalogProfile(item, `profiles[${index}]`));
  assertSortedUnique(
    installations.map((entry) => `${entry.component}:${entry.installationId}`),
    "installations",
  );
  assertSortedUnique(profiles.map((entry) => entry.profileId), "profiles");
  validateReferences(installations, profiles);
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generatedAt: validateTimestamp(root.generatedAt, "generatedAt"),
    installations,
    profiles,
  };
}

export async function readCatalog(path: string): Promise<CatalogV3> {
  let value: unknown;
  try {
    value = JSON.parse(await Deno.readTextFile(path));
  } catch (cause) {
    throw new CatalogValidationError(path, "catalog could not be read as JSON", { cause });
  }
  try {
    return validateCatalog(value);
  } catch (cause) {
    throw new CatalogValidationError(path, message(cause), { cause });
  }
}

export class GlobalCatalog {
  readonly dataRoot: string;
  readonly stateRoot: string;
  readonly catalogPath: string;
  readonly #installs: InstallCatalogSource;
  readonly #profiles: ProfileCatalogSource;
  readonly #now: () => Date;

  constructor(options: GlobalCatalogOptions) {
    rejectControls(options.dataRoot, "dataRoot");
    rejectControls(options.stateRoot, "stateRoot");
    this.dataRoot = resolve(options.dataRoot);
    this.stateRoot = resolve(options.stateRoot);
    this.catalogPath = join(this.stateRoot, "catalog.json");
    const installs = options.installs ?? new InstallStore({ dataRoot: this.dataRoot });
    this.#installs = installs;
    this.#profiles = options.profiles ?? new ToolchainProfileStore({
      dataRoot: this.dataRoot,
      installs,
    });
    this.#now = options.now ?? (() => new Date());
  }

  async read(): Promise<CatalogV3 | null> {
    await this.#ensureStateRoot();
    if (!await pathExists(this.catalogPath)) return null;
    const stat = await safeLstat(this.catalogPath);
    if (!stat.isFile || stat.isSymlink) {
      throw new CatalogValidationError(this.catalogPath, "catalog path is not a regular file");
    }
    return await readCatalog(this.catalogPath);
  }

  async rebuild(options: CatalogMutationOptions = {}): Promise<CatalogV3> {
    throwIfAborted(options.signal);
    const installedObjects = await this.#installs.list();
    throwIfAborted(options.signal);
    const storedProfiles = await this.#profiles.list();
    throwIfAborted(options.signal);
    const installations = installedObjects.map(({ manifest }) => installationEntry(manifest));
    installations.sort((left, right) =>
      left.component.localeCompare(right.component) ||
      left.installationId.localeCompare(right.installationId)
    );
    const profiles = storedProfiles.map(({ profile }) => profileEntry(profile));
    profiles.sort((left, right) => left.profileId.localeCompare(right.profileId));
    const catalog = validateCatalog({
      schemaVersion: CATALOG_SCHEMA_VERSION,
      generatedAt: this.#now().toISOString(),
      installations,
      profiles,
    });

    await this.#ensureStateRoot();
    if (await pathExists(this.catalogPath)) {
      const stat = await safeLstat(this.catalogPath);
      if (!stat.isFile || stat.isSymlink) {
        throw new CatalogValidationError(this.catalogPath, "catalog path is not a regular file");
      }
    }
    throwIfAborted(options.signal);
    await atomicWriteJson(this.catalogPath, catalog, options);
    return catalog;
  }

  /** Catalog updates deliberately rebuild from authoritative immutable manifests. */
  async update(options: CatalogMutationOptions = {}): Promise<CatalogV3> {
    return await this.rebuild(options);
  }

  async updateInstallation(
    manifest: InstallManifestV3,
    options: CatalogMutationOptions = {},
  ): Promise<CatalogV3> {
    validateInstallManifest(manifest);
    return await this.rebuild(options);
  }

  async updateProfile(
    profile: ToolchainProfileV1,
    options: CatalogMutationOptions = {},
  ): Promise<CatalogV3> {
    validateToolchainProfile(profile);
    return await this.rebuild(options);
  }

  async #ensureStateRoot(): Promise<void> {
    try {
      await Deno.mkdir(this.stateRoot, { recursive: true });
    } catch (cause) {
      if (!(cause instanceof Deno.errors.AlreadyExists)) throw cause;
    }
    const stat = await safeLstat(this.stateRoot);
    if (!stat.isDirectory || stat.isSymlink) {
      throw new CatalogValidationError(this.catalogPath, "state root is not a real directory");
    }
  }
}

function installationEntry(manifestValue: InstallManifestV3): CatalogInstallationV3 {
  const manifest = validateInstallManifest(manifestValue);
  return {
    component: manifest.component,
    installationId: manifest.installationId,
    version: manifest.source.version,
    commit: manifest.source.commit,
    createdAt: manifest.createdAt,
    dependencies: manifest.dependencies,
  };
}

function profileEntry(profileValue: ToolchainProfileV1): CatalogProfileV3 {
  const profile = validateToolchainProfile(profileValue);
  return {
    profileId: profile.profileId,
    requestedSelector: profile.source.requestedSelector,
    resolvedCommit: profile.source.commit,
    zigInstallationId: profile.components.zig,
    zlsInstallationId: profile.components.zls,
    createdAt: profile.createdAt,
  };
}

function catalogInstallation(value: unknown, path: string): CatalogInstallationV3 {
  const root = strictObject(value, path, [
    "component",
    "installationId",
    "version",
    "commit",
    "createdAt",
    "dependencies",
  ]);
  const component = validateInstallComponent(root.component, `${path}.component`);
  if (!Array.isArray(root.dependencies)) {
    throw new TypeError(`${path}.dependencies must be an array`);
  }
  const dependencies = root.dependencies.map((item, index) => {
    const dependency = strictObject(item, `${path}.dependencies[${index}]`, [
      "component",
      "installationId",
    ]);
    equal(dependency.component, "zig", `${path}.dependencies[${index}].component`);
    return {
      component: "zig" as const,
      installationId: validateInstallationId(
        dependency.installationId,
        `${path}.dependencies[${index}].installationId`,
      ),
    };
  });
  if (component === "zig" && dependencies.length !== 0) {
    throw new TypeError(`${path}.dependencies must be empty for Zig`);
  }
  if (component === "zls" && dependencies.length !== 1) {
    throw new TypeError(`${path}.dependencies must contain exactly one Zig installation for ZLS`);
  }
  const commit = text(root.commit, `${path}.commit`);
  if (!COMMIT.test(commit)) throw new TypeError(`${path}.commit must be a lowercase object ID`);
  return {
    component,
    installationId: validateInstallationId(root.installationId, `${path}.installationId`),
    version: text(root.version, `${path}.version`),
    commit,
    createdAt: validateTimestamp(root.createdAt, `${path}.createdAt`),
    dependencies,
  };
}

function catalogProfile(value: unknown, path: string): CatalogProfileV3 {
  const root = strictObject(value, path, [
    "profileId",
    "requestedSelector",
    "resolvedCommit",
    "zigInstallationId",
    "zlsInstallationId",
    "createdAt",
  ]);
  const commit = text(root.resolvedCommit, `${path}.resolvedCommit`);
  if (!COMMIT.test(commit)) {
    throw new TypeError(`${path}.resolvedCommit must be a lowercase object ID`);
  }
  return {
    profileId: validateProfileId(root.profileId, `${path}.profileId`),
    requestedSelector: text(root.requestedSelector, `${path}.requestedSelector`),
    resolvedCommit: commit,
    zigInstallationId: validateInstallationId(
      root.zigInstallationId,
      `${path}.zigInstallationId`,
    ),
    zlsInstallationId: root.zlsInstallationId === null
      ? null
      : validateInstallationId(root.zlsInstallationId, `${path}.zlsInstallationId`),
    createdAt: validateTimestamp(root.createdAt, `${path}.createdAt`),
  };
}

function validateReferences(
  installations: readonly CatalogInstallationV3[],
  profiles: readonly CatalogProfileV3[],
): void {
  const byId = new Map(installations.map((entry) => [
    `${entry.component}:${entry.installationId}`,
    entry,
  ]));
  for (const install of installations) {
    for (const dependency of install.dependencies) {
      if (!byId.has(`${dependency.component}:${dependency.installationId}`)) {
        throw new TypeError(
          `installation ${install.installationId} references a missing ${dependency.component} dependency`,
        );
      }
    }
  }
  for (const profile of profiles) {
    if (!byId.has(`zig:${profile.zigInstallationId}`)) {
      throw new TypeError(`profile ${profile.profileId} references a missing Zig installation`);
    }
    if (profile.zlsInstallationId !== null) {
      const zls = byId.get(`zls:${profile.zlsInstallationId}`);
      if (zls === undefined) {
        throw new TypeError(`profile ${profile.profileId} references a missing ZLS installation`);
      }
      if (zls.dependencies[0]?.installationId !== profile.zigInstallationId) {
        throw new TypeError(
          `profile ${profile.profileId} references an incompatible ZLS installation`,
        );
      }
    }
  }
}

function assertSortedUnique(values: readonly string[], path: string): void {
  for (let index = 0; index < values.length; index++) {
    if (index > 0 && values[index - 1] >= values[index]) {
      throw new TypeError(`${path} must be strictly sorted without duplicates`);
    }
  }
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${path} must be a nonempty string`);
  }
  rejectControls(value, path);
  return value;
}

function rejectControls(value: string, path: string): void {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint >= 0x7f && codePoint <= 0x9f) {
      throw new TypeError(`${path} must not contain control characters`);
    }
  }
}

function strictObject(
  value: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  const result = value as Record<string, unknown>;
  const unknown = Object.keys(result).filter((key) => !keys.includes(key)).sort();
  if (unknown.length > 0) throw new TypeError(`${path} contains unknown key '${unknown[0]}'`);
  for (const key of keys) if (!(key in result)) throw new TypeError(`${path}.${key} is required`);
  return result;
}

function equal(actual: unknown, expected: unknown, path: string): void {
  if (actual !== expected) throw new TypeError(`${path} must equal ${String(expected)}`);
}

async function safeLstat(path: string): Promise<Deno.FileInfo> {
  try {
    return await Deno.lstat(path);
  } catch (cause) {
    throw new CatalogValidationError(path, "unable to inspect catalog path", { cause });
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ZigOperationAbortedError("rebuild manager catalog", {}, { cause: signal.reason });
  }
}
