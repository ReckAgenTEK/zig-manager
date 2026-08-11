import { dirname, isAbsolute, join, relative, resolve } from "@std/path";
import { ZigOperationAbortedError } from "./errors.ts";
import {
  assertPathContained,
  atomicWriteJson,
  atomicWriteText,
  canonicalJson,
  pathExists,
  removeIfPresent,
  sha256Text,
} from "./filesystem.ts";
import {
  type InstalledObject,
  InstallStore,
  type ResolvedSource,
  type SourceRepositoryIdentity,
  validateInstallationId,
  validateResolvedSource,
  validateTimestamp,
} from "./install_store.ts";

export const TOOLCHAIN_PROFILE_SCHEMA_VERSION = 1 as const;

const HASH = /^[0-9a-f]{64}$/;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ToolchainHostIdentity {
  readonly os: string;
  readonly architecture: string;
  readonly abi: string;
  readonly denoTarget: string;
}

export interface ProfileComponents {
  readonly zig: string;
  readonly zls: string | null;
}

export interface ProfileSelectorIdentity {
  readonly component: ResolvedSource["component"];
  readonly repository: SourceRepositoryIdentity;
  readonly requestedSelector: string;
  readonly resolvedRef: ResolvedSource["resolvedRef"];
  readonly commit: string;
  readonly version: string;
  readonly versionMetadata: ResolvedSource["versionMetadata"];
}

export interface ToolchainProfileIdentityV1 {
  readonly schemaVersion: 1;
  readonly components: ProfileComponents;
  readonly selector: ProfileSelectorIdentity;
}

export interface ToolchainProfileV1 {
  readonly schemaVersion: 1;
  readonly profileId: string;
  readonly components: ProfileComponents;
  readonly source: ResolvedSource;
  readonly host: ToolchainHostIdentity;
  readonly createdAt: string;
}

export interface CreateToolchainProfileInput {
  readonly zigInstallationId: string;
  readonly zlsInstallationId?: string | null;
  readonly source: ResolvedSource;
  readonly host: ToolchainHostIdentity;
  readonly createdAt?: string;
}

export interface StoredToolchainProfileMetadata {
  readonly root: string;
  readonly manifestPath: string;
  readonly profile: ToolchainProfileV1;
}

export interface StoredToolchainProfile extends StoredToolchainProfileMetadata {
  readonly zigPath: string;
  readonly zlsPath: string | null;
}

export interface ProfileCreateResult extends StoredToolchainProfile {
  readonly reused: boolean;
}

export interface ProfileInstallSource {
  get(component: "zig" | "zls", installationId: string): Promise<InstalledObject>;
}

export interface ProfileCatalogUpdater {
  updateProfile(profile: ToolchainProfileV1): Promise<unknown>;
}

export interface ToolchainProfileStoreOptions {
  readonly dataRoot: string;
  readonly installs?: ProfileInstallSource;
  readonly catalog?: ProfileCatalogUpdater;
  readonly now?: () => Date;
  readonly createOperationId?: () => string;
}

export interface ProfileMutationOptions {
  readonly operationId?: string;
  readonly signal?: AbortSignal;
}

export type ProfileStoreErrorCode =
  | "PROFILE_INVALID"
  | "PROFILE_NOT_FOUND"
  | "PROFILE_CONFLICT"
  | "PROFILE_PATH_INVALID";

export class ProfileStoreError extends Error {
  readonly code: ProfileStoreErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ProfileStoreErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProfileStoreError";
    this.code = code;
    this.details = details;
  }
}

export function validateProfileId(value: unknown, path = "profileId"): string {
  if (typeof value !== "string" || !HASH.test(value)) {
    throw new TypeError(`${path} must be a lowercase SHA-256 digest`);
  }
  return value;
}

export function validateHostIdentity(
  value: unknown,
  path = "host",
): ToolchainHostIdentity {
  const root = strictObject(value, path, ["os", "architecture", "abi", "denoTarget"]);
  return {
    os: text(root.os, `${path}.os`),
    architecture: text(root.architecture, `${path}.architecture`),
    abi: text(root.abi, `${path}.abi`),
    denoTarget: text(root.denoTarget, `${path}.denoTarget`),
  };
}

export function createToolchainProfileIdentity(
  input: Pick<CreateToolchainProfileInput, "zigInstallationId" | "zlsInstallationId" | "source">,
): ToolchainProfileIdentityV1 {
  const source = validateResolvedSource(input.source);
  return {
    schemaVersion: TOOLCHAIN_PROFILE_SCHEMA_VERSION,
    components: {
      zig: validateInstallationId(input.zigInstallationId, "zigInstallationId"),
      zls: input.zlsInstallationId === undefined || input.zlsInstallationId === null
        ? null
        : validateInstallationId(input.zlsInstallationId, "zlsInstallationId"),
    },
    selector: {
      component: source.component,
      repository: source.repository,
      requestedSelector: source.requestedSelector,
      resolvedRef: source.resolvedRef,
      commit: source.commit,
      version: source.version,
      versionMetadata: source.versionMetadata,
    },
  };
}

export function validateToolchainProfileIdentity(
  value: unknown,
): ToolchainProfileIdentityV1 {
  const root = strictObject(value, "identity", ["schemaVersion", "components", "selector"]);
  equal(root.schemaVersion, TOOLCHAIN_PROFILE_SCHEMA_VERSION, "identity.schemaVersion");
  const components = profileComponents(root.components, "identity.components");
  const selector = strictObject(root.selector, "identity.selector", [
    "component",
    "repository",
    "requestedSelector",
    "resolvedRef",
    "commit",
    "version",
    "versionMetadata",
  ]);
  const syntheticSource = validateResolvedSource({
    component: selector.component,
    repository: selector.repository,
    requestedSelector: selector.requestedSelector,
    resolvedRef: selector.resolvedRef,
    commit: selector.commit,
    version: selector.version,
    versionMetadata: selector.versionMetadata,
    resolvedAt: "1970-01-01T00:00:00.000Z",
  });
  return {
    schemaVersion: TOOLCHAIN_PROFILE_SCHEMA_VERSION,
    components,
    selector: {
      component: syntheticSource.component,
      repository: syntheticSource.repository,
      requestedSelector: syntheticSource.requestedSelector,
      resolvedRef: syntheticSource.resolvedRef,
      commit: syntheticSource.commit,
      version: syntheticSource.version,
      versionMetadata: syntheticSource.versionMetadata,
    },
  };
}

export async function computeProfileId(identity: ToolchainProfileIdentityV1): Promise<string> {
  return await sha256Text(canonicalJson(validateToolchainProfileIdentity(identity)));
}

export function validateToolchainProfile(value: unknown): ToolchainProfileV1 {
  const root = strictObject(value, "root", [
    "schemaVersion",
    "profileId",
    "components",
    "source",
    "host",
    "createdAt",
  ]);
  equal(root.schemaVersion, TOOLCHAIN_PROFILE_SCHEMA_VERSION, "schemaVersion");
  return {
    schemaVersion: TOOLCHAIN_PROFILE_SCHEMA_VERSION,
    profileId: validateProfileId(root.profileId),
    components: profileComponents(root.components, "components"),
    source: validateResolvedSource(root.source),
    host: validateHostIdentity(root.host),
    createdAt: validateTimestamp(root.createdAt, "createdAt"),
  };
}

export async function readToolchainProfile(path: string): Promise<ToolchainProfileV1> {
  let value: unknown;
  try {
    value = JSON.parse(await Deno.readTextFile(path));
  } catch (cause) {
    throw new ProfileStoreError(
      "PROFILE_INVALID",
      `Toolchain profile could not be read as JSON: ${path}`,
      { path },
      { cause },
    );
  }
  try {
    return validateToolchainProfile(value);
  } catch (cause) {
    throw new ProfileStoreError(
      "PROFILE_INVALID",
      `Invalid toolchain profile '${path}': ${message(cause)}`,
      { path, reason: message(cause) },
      { cause },
    );
  }
}

export class ToolchainProfileStore {
  readonly dataRoot: string;
  readonly profilesRoot: string;
  readonly stagingRoot: string;
  readonly #installs: ProfileInstallSource;
  readonly #catalog: ProfileCatalogUpdater | undefined;
  readonly #now: () => Date;
  readonly #createOperationId: () => string;

  constructor(options: ToolchainProfileStoreOptions) {
    rejectControls(options.dataRoot, "dataRoot");
    this.dataRoot = resolve(options.dataRoot);
    this.profilesRoot = join(this.dataRoot, "profiles");
    this.stagingRoot = join(this.profilesRoot, ".staging");
    this.#installs = options.installs ?? new InstallStore({ dataRoot: this.dataRoot });
    this.#catalog = options.catalog;
    this.#now = options.now ?? (() => new Date());
    this.#createOperationId = options.createOperationId ?? (() => crypto.randomUUID());
  }

  profilePath(profileId: string): string {
    return join(this.profilesRoot, validateProfileId(profileId));
  }

  async create(
    input: CreateToolchainProfileInput,
    options: ProfileMutationOptions = {},
  ): Promise<ProfileCreateResult> {
    const operationId = operationSegment(options.operationId ?? this.#createOperationId());
    throwIfAborted(options.signal, "create toolchain profile", this.profilesRoot);
    await this.#ensureLayout();
    const identity = createToolchainProfileIdentity(input);
    const profileId = await computeProfileId(identity);
    const source = validateResolvedSource(input.source);
    const host = validateHostIdentity(input.host);
    const createdAt = input.createdAt === undefined
      ? validateTimestamp(this.#now().toISOString(), "createdAt")
      : validateTimestamp(input.createdAt, "createdAt");
    const profile = validateToolchainProfile({
      schemaVersion: TOOLCHAIN_PROFILE_SCHEMA_VERSION,
      profileId,
      components: identity.components,
      source,
      host,
      createdAt,
    });
    const installs = await this.#resolveInstalls(profile);
    throwIfAborted(options.signal, "create toolchain profile", this.profilesRoot);
    const destination = this.profilePath(profileId);
    if (await pathExists(destination)) {
      const reused = await this.#reuseExisting(profile, identity);
      throwIfAborted(options.signal, "reuse toolchain profile", destination);
      if (this.#catalog !== undefined) await this.#catalog.updateProfile(reused.profile);
      return { ...reused, reused: true };
    }

    const staging = join(this.stagingRoot, operationId);
    assertOwnedStaging(this.stagingRoot, staging, operationId);
    throwIfAborted(options.signal, "create toolchain profile staging", staging);
    try {
      await Deno.mkdir(staging);
    } catch (cause) {
      throw new ProfileStoreError(
        "PROFILE_PATH_INVALID",
        `Unable to create unique profile staging directory: ${staging}`,
        { staging, operationId },
        { cause },
      );
    }
    try {
      await atomicWriteJson(join(staging, "profile.json"), profile, {
        operationId,
        signal: options.signal,
      });
      await atomicWriteText(
        join(staging, "zig.path"),
        trustedPathLine(installs.zig.executablePath),
        { operationId, signal: options.signal },
      );
      if (installs.zls !== null) {
        await atomicWriteText(
          join(staging, "zls.path"),
          trustedPathLine(installs.zls.executablePath),
          { operationId, signal: options.signal },
        );
      }
      await this.#verifyProfileDirectory(staging, profile, installs, options.signal);
      throwIfAborted(options.signal, "publish toolchain profile", destination);
      if (await pathExists(destination)) {
        const reused = await this.#reuseExisting(profile, identity);
        throwIfAborted(options.signal, "reuse toolchain profile", destination);
        await removeIfPresent(staging, true);
        if (this.#catalog !== undefined) await this.#catalog.updateProfile(reused.profile);
        return { ...reused, reused: true };
      }
      try {
        throwIfAborted(options.signal, "publish toolchain profile", destination);
        await Deno.rename(staging, destination);
      } catch (cause) {
        if (cause instanceof ZigOperationAbortedError) throw cause;
        if (await pathExists(destination)) {
          const reused = await this.#reuseExisting(profile, identity);
          await removeIfPresent(staging, true);
          if (this.#catalog !== undefined) await this.#catalog.updateProfile(reused.profile);
          return { ...reused, reused: true };
        }
        throw new ProfileStoreError(
          "PROFILE_CONFLICT",
          `Unable to publish immutable toolchain profile: ${destination}`,
          { destination },
          { cause },
        );
      }
      const stored = await this.get(profileId);
      if (this.#catalog !== undefined) await this.#catalog.updateProfile(stored.profile);
      return { ...stored, reused: false };
    } catch (cause) {
      await cleanupOwnedStaging(this.stagingRoot, staging, operationId, cause);
      throw cause;
    }
  }

  async get(profileId: string): Promise<StoredToolchainProfile> {
    const metadata = await this.getMetadata(profileId);
    const { profile, root, manifestPath } = metadata;
    const installs = await this.#resolveInstalls(profile);
    const paths = await this.#verifyProfileDirectory(root, profile, installs);
    return { root, manifestPath, profile, ...paths };
  }

  /** Read and hash-validate immutable profile metadata without requiring its installation. */
  async read(profileId: string): Promise<ToolchainProfileV1> {
    return (await this.getMetadata(profileId)).profile;
  }

  /** Read strict profile metadata without creating store paths or resolving installations. */
  async getMetadata(profileId: string): Promise<StoredToolchainProfileMetadata> {
    const validatedId = validateProfileId(profileId);
    const root = this.profilePath(validatedId);
    if (!await pathExists(root)) {
      throw new ProfileStoreError(
        "PROFILE_NOT_FOUND",
        `Immutable toolchain profile was not found: ${validatedId}`,
        { profileId: validatedId, root },
      );
    }
    await assertNoSymlinkPath(this.dataRoot, root);
    const stat = await safeLstat(root);
    if (!stat.isDirectory || stat.isSymlink) {
      throw new ProfileStoreError(
        "PROFILE_INVALID",
        `Profile path is not a real directory: ${root}`,
        { root },
      );
    }
    const manifestPath = join(root, "profile.json");
    const manifestInfo = await safeLstat(manifestPath);
    if (!manifestInfo.isFile || manifestInfo.isSymlink) {
      throw new ProfileStoreError(
        "PROFILE_INVALID",
        `Profile manifest is not a physical regular file: ${manifestPath}`,
        { root, manifestPath },
      );
    }
    const profile = await readToolchainProfile(manifestPath);
    await assertProfileTree(root, profile.components.zls !== null);
    await readTrustedPath(join(root, "zig.path"));
    if (profile.components.zls !== null) {
      await readTrustedPath(join(root, "zls.path"));
    }
    if (profile.profileId !== validatedId) {
      throw new ProfileStoreError(
        "PROFILE_INVALID",
        `Profile ID does not match its immutable directory: ${root}`,
        { root, expected: validatedId, actual: profile.profileId },
      );
    }
    const identity = createToolchainProfileIdentity({
      zigInstallationId: profile.components.zig,
      zlsInstallationId: profile.components.zls,
      source: profile.source,
    });
    const computedId = await computeProfileId(identity);
    if (computedId !== validatedId) {
      throw new ProfileStoreError(
        "PROFILE_INVALID",
        `Profile content does not match its profile ID: ${root}`,
        { root, expected: validatedId, actual: computedId },
      );
    }
    return { root, manifestPath, profile };
  }

  async tryGet(profileId: string): Promise<StoredToolchainProfile | null> {
    try {
      return await this.get(profileId);
    } catch (cause) {
      if (cause instanceof ProfileStoreError && cause.code === "PROFILE_NOT_FOUND") return null;
      throw cause;
    }
  }

  async list(): Promise<readonly StoredToolchainProfile[]> {
    await this.#ensureLayout();
    const result: StoredToolchainProfile[] = [];
    for await (const entry of Deno.readDir(this.profilesRoot)) {
      if (entry.name === ".staging") continue;
      if (!entry.isDirectory || entry.isSymlink || !HASH.test(entry.name)) {
        throw new ProfileStoreError(
          "PROFILE_INVALID",
          `Unexpected object in immutable profile store: ${entry.name}`,
          { name: entry.name, profilesRoot: this.profilesRoot },
        );
      }
      result.push(await this.get(entry.name));
    }
    result.sort((left, right) => left.profile.profileId.localeCompare(right.profile.profileId));
    return result;
  }

  /** Enumerate strict profile metadata without requiring referenced installations to exist. */
  async listMetadata(): Promise<readonly StoredToolchainProfileMetadata[]> {
    const profilesInfo = await lstatIfPresent(this.profilesRoot);
    if (profilesInfo === null) return [];
    await assertPhysicalProfileDirectory(
      this.dataRoot,
      this.profilesRoot,
      profilesInfo,
      "profile root",
    );

    const entries: Deno.DirEntry[] = [];
    for await (const entry of Deno.readDir(this.profilesRoot)) entries.push(entry);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    const result: StoredToolchainProfileMetadata[] = [];
    for (const entry of entries) {
      if (entry.name === ".staging") continue;
      if (!entry.isDirectory || entry.isSymlink || !HASH.test(entry.name)) {
        throw new ProfileStoreError(
          "PROFILE_INVALID",
          `Unexpected object in immutable profile store: ${entry.name}`,
          { name: entry.name, profilesRoot: this.profilesRoot },
        );
      }
      result.push(await this.getMetadata(entry.name));
    }
    return result;
  }

  /** Remove exactly one metadata-valid immutable profile and never a symlinked path. */
  async remove(
    profileId: string,
    signal?: AbortSignal,
  ): Promise<StoredToolchainProfileMetadata> {
    throwIfAborted(signal, "remove toolchain profile", this.profilesRoot);
    const stored = await this.getMetadata(profileId);
    await assertProfileTree(stored.root, stored.profile.components.zls !== null, signal);
    const current = await safeLstat(stored.root);
    if (!current.isDirectory || current.isSymlink) {
      throw new ProfileStoreError(
        "PROFILE_INVALID",
        `Profile path changed before removal: ${stored.root}`,
        { root: stored.root },
      );
    }
    try {
      throwIfAborted(signal, "remove toolchain profile", stored.root);
      await Deno.remove(stored.root, { recursive: true });
    } catch (cause) {
      if (cause instanceof ZigOperationAbortedError) throw cause;
      throw new ProfileStoreError(
        "PROFILE_PATH_INVALID",
        `Unable to remove validated immutable profile: ${stored.root}`,
        { root: stored.root, profileId: stored.profile.profileId },
        { cause },
      );
    }
    return stored;
  }

  async #ensureLayout(): Promise<void> {
    await ensureDirectoryNoSymlink(this.dataRoot, true);
    await ensureDirectoryNoSymlink(this.profilesRoot);
    await ensureDirectoryNoSymlink(this.stagingRoot);
    await assertNoSymlinkPath(this.dataRoot, this.profilesRoot);
  }

  async #resolveInstalls(
    profile: ToolchainProfileV1,
  ): Promise<{ zig: InstalledObject; zls: InstalledObject | null }> {
    const zig = await this.#installs.get("zig", profile.components.zig);
    this.#assertInstallOwned(zig, "zig", profile.components.zig);
    assertSourceMatchesInstall(profile.source, zig);
    if (profile.components.zls === null) return { zig, zls: null };
    const zls = await this.#installs.get("zls", profile.components.zls);
    this.#assertInstallOwned(zls, "zls", profile.components.zls);
    if (
      zls.manifest.dependencies.length !== 1 ||
      zls.manifest.dependencies[0].installationId !== profile.components.zig
    ) {
      throw new ProfileStoreError(
        "PROFILE_INVALID",
        "Profile ZLS installation does not depend on its Zig installation",
        {
          zigInstallationId: profile.components.zig,
          zlsInstallationId: profile.components.zls,
        },
      );
    }
    return { zig, zls };
  }

  #assertInstallOwned(
    install: InstalledObject,
    component: "zig" | "zls",
    installationId: string,
  ): void {
    const expectedRoot = join(this.dataRoot, "installs", component, installationId);
    if (
      resolve(install.root) !== expectedRoot ||
      resolve(install.manifestPath) !== join(expectedRoot, "install-manifest.json")
    ) {
      throw new ProfileStoreError(
        "PROFILE_PATH_INVALID",
        "Validated installation is outside this profile store's data root",
        { component, installationId, expectedRoot, actualRoot: install.root },
      );
    }
    assertPathContained(join(expectedRoot, "install"), install.executablePath);
    trustedAbsolutePath(install.executablePath, `${component} executable path`);
  }

  async #verifyProfileDirectory(
    root: string,
    profile: ToolchainProfileV1,
    installs: { zig: InstalledObject; zls: InstalledObject | null },
    signal?: AbortSignal,
  ): Promise<{ zigPath: string; zlsPath: string | null }> {
    await assertProfileTree(root, installs.zls !== null, signal);
    throwIfAborted(signal, "verify toolchain profile", root);
    const manifest = await readToolchainProfile(join(root, "profile.json"));
    if (canonicalJson(manifest) !== canonicalJson(profile)) {
      throw new ProfileStoreError(
        "PROFILE_INVALID",
        `Profile manifest changed while being verified: ${root}`,
        { root },
      );
    }
    const zigPath = await readTrustedPath(join(root, "zig.path"));
    if (zigPath !== installs.zig.executablePath) {
      throw new ProfileStoreError(
        "PROFILE_INVALID",
        `zig.path does not match the validated Zig installation: ${root}`,
        { root, expected: installs.zig.executablePath, actual: zigPath },
      );
    }
    let zlsPath: string | null = null;
    if (installs.zls !== null) {
      zlsPath = await readTrustedPath(join(root, "zls.path"));
      if (zlsPath !== installs.zls.executablePath) {
        throw new ProfileStoreError(
          "PROFILE_INVALID",
          `zls.path does not match the validated ZLS installation: ${root}`,
          { root, expected: installs.zls.executablePath, actual: zlsPath },
        );
      }
    }
    return { zigPath, zlsPath };
  }

  async #reuseExisting(
    incoming: ToolchainProfileV1,
    identity: ToolchainProfileIdentityV1,
  ): Promise<StoredToolchainProfile> {
    let existing: StoredToolchainProfile;
    try {
      existing = await this.get(incoming.profileId);
    } catch (cause) {
      throw new ProfileStoreError(
        "PROFILE_CONFLICT",
        `An existing object blocks immutable profile publication: ${incoming.profileId}`,
        { profileId: incoming.profileId },
        { cause },
      );
    }
    const existingIdentity = createToolchainProfileIdentity({
      zigInstallationId: existing.profile.components.zig,
      zlsInstallationId: existing.profile.components.zls,
      source: existing.profile.source,
    });
    if (
      canonicalJson(existingIdentity) !== canonicalJson(identity) ||
      canonicalJson(existing.profile.host) !== canonicalJson(incoming.host)
    ) {
      throw new ProfileStoreError(
        "PROFILE_CONFLICT",
        `Existing immutable profile has different non-timestamp metadata: ${incoming.profileId}`,
        { profileId: incoming.profileId },
      );
    }
    return existing;
  }
}

export { ToolchainProfileStore as ProfileStore };

function profileComponents(value: unknown, path: string): ProfileComponents {
  const root = strictObject(value, path, ["zig", "zls"]);
  return {
    zig: validateInstallationId(root.zig, `${path}.zig`),
    zls: root.zls === null ? null : validateInstallationId(root.zls, `${path}.zls`),
  };
}

function assertSourceMatchesInstall(source: ResolvedSource, install: InstalledObject): void {
  const expected = install.manifest.identity.source;
  if (
    source.component !== install.manifest.component ||
    canonicalJson(source.repository) !== canonicalJson(expected.repository) ||
    source.commit !== expected.commit || source.version !== expected.version.text ||
    canonicalJson(source.versionMetadata) !== canonicalJson(expected.version)
  ) {
    throw new ProfileStoreError(
      "PROFILE_INVALID",
      "Profile resolved source does not identify its Zig installation",
      {
        zigInstallationId: install.manifest.installationId,
        sourceCommit: source.commit,
        installCommit: expected.commit,
      },
    );
  }
}

function trustedPathLine(path: string): string {
  const validated = trustedAbsolutePath(path, "trusted executable path");
  return `${validated}\n`;
}

async function readTrustedPath(path: string): Promise<string> {
  const stat = await safeLstat(path);
  if (!stat.isFile || stat.isSymlink) {
    throw new ProfileStoreError(
      "PROFILE_INVALID",
      `Trusted executable path file is not a regular file: ${path}`,
      { path },
    );
  }
  let contents: string;
  try {
    contents = await Deno.readTextFile(path);
  } catch (cause) {
    throw new ProfileStoreError(
      "PROFILE_INVALID",
      `Unable to read trusted executable path: ${path}`,
      { path },
      { cause },
    );
  }
  if (!contents.endsWith("\n") || contents.slice(0, -1).includes("\n")) {
    throw new ProfileStoreError(
      "PROFILE_INVALID",
      `Trusted executable path must contain exactly one line: ${path}`,
      { path },
    );
  }
  return trustedAbsolutePath(contents.slice(0, -1), path);
}

function trustedAbsolutePath(value: unknown, path: string): string {
  const result = text(value, path);
  if (!isAbsolute(result) || resolve(result) !== result) {
    throw new ProfileStoreError(
      "PROFILE_PATH_INVALID",
      `Trusted executable path must be absolute and normalized: ${result}`,
      { path, value: result },
    );
  }
  return result;
}

async function assertProfileTree(
  root: string,
  hasZls: boolean,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal, "inspect toolchain profile", root);
  const expected = new Set(["profile.json", "zig.path", ...(hasZls ? ["zls.path"] : [])]);
  const stat = await safeLstat(root);
  if (!stat.isDirectory || stat.isSymlink) {
    throw new ProfileStoreError(
      "PROFILE_INVALID",
      `Profile root is not a real directory: ${root}`,
      { root },
    );
  }
  const actual = new Set<string>();
  for await (const entry of Deno.readDir(root)) {
    throwIfAborted(signal, "inspect toolchain profile", root);
    actual.add(entry.name);
    const entryStat = await safeLstat(join(root, entry.name));
    if (!entryStat.isFile || entryStat.isSymlink) {
      throw new ProfileStoreError(
        "PROFILE_INVALID",
        `Profile contains a non-file or symlink: ${join(root, entry.name)}`,
        { root, name: entry.name },
      );
    }
  }
  if (
    actual.size !== expected.size ||
    [...actual].some((name) => !expected.has(name))
  ) {
    throw new ProfileStoreError(
      "PROFILE_INVALID",
      `Profile directory has unexpected files: ${root}`,
      { root, expected: [...expected].sort(), actual: [...actual].sort() },
    );
  }
}

function operationSegment(value: unknown): string {
  const result = text(value, "operationId");
  if (!OPERATION_ID.test(result)) {
    throw new ProfileStoreError(
      "PROFILE_PATH_INVALID",
      "operationId is not safe for a profile staging path",
      { operationId: result },
    );
  }
  return result;
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

async function ensureDirectoryNoSymlink(path: string, recursive = false): Promise<void> {
  try {
    await Deno.mkdir(path, { recursive });
  } catch (cause) {
    if (!(cause instanceof Deno.errors.AlreadyExists)) throw cause;
  }
  const stat = await safeLstat(path);
  if (!stat.isDirectory || stat.isSymlink) {
    throw new ProfileStoreError(
      "PROFILE_PATH_INVALID",
      `Managed profile path is not a real directory: ${path}`,
      { path },
    );
  }
}

async function assertNoSymlinkPath(root: string, candidate: string): Promise<void> {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = assertPathContained(normalizedRoot, candidate);
  const rel = relative(normalizedRoot, normalizedCandidate);
  let current = normalizedRoot;
  for (const segment of ["", ...(rel === "" ? [] : rel.split(/[\\/]/))]) {
    if (segment !== "") current = join(current, segment);
    const stat = await safeLstat(current);
    if (stat.isSymlink) {
      throw new ProfileStoreError(
        "PROFILE_PATH_INVALID",
        `Managed profile path contains a symlink: ${current}`,
        { root: normalizedRoot, candidate: normalizedCandidate, symlink: current },
      );
    }
  }
}

async function assertPhysicalProfileDirectory(
  root: string,
  path: string,
  stat: Deno.FileInfo,
  label: string,
): Promise<void> {
  if (!stat.isDirectory || stat.isSymlink) {
    throw new ProfileStoreError(
      "PROFILE_PATH_INVALID",
      `Managed ${label} is not a real directory: ${path}`,
      { path },
    );
  }
  await assertNoSymlinkPath(root, path);
}

async function lstatIfPresent(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.lstat(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return null;
    throw new ProfileStoreError(
      "PROFILE_PATH_INVALID",
      `Unable to inspect managed profile path: ${path}`,
      { path },
      { cause },
    );
  }
}

async function safeLstat(path: string): Promise<Deno.FileInfo> {
  try {
    return await Deno.lstat(path);
  } catch (cause) {
    throw new ProfileStoreError(
      "PROFILE_PATH_INVALID",
      `Unable to inspect managed profile path: ${path}`,
      { path },
      { cause },
    );
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function assertOwnedStaging(root: string, staging: string, operationId: string): void {
  const expected = join(resolve(root), operationSegment(operationId));
  if (resolve(staging) !== expected || dirname(expected) !== resolve(root)) {
    throw new ProfileStoreError(
      "PROFILE_PATH_INVALID",
      "Profile staging path does not match its operation UUID",
      { root, staging, operationId },
    );
  }
}

async function cleanupOwnedStaging(
  root: string,
  staging: string,
  operationId: string,
  operationCause: unknown,
): Promise<void> {
  try {
    assertOwnedStaging(root, staging, operationId);
    const info = await Deno.lstat(staging);
    await Deno.remove(staging, { recursive: info.isDirectory && !info.isSymlink });
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return;
    throw new AggregateError(
      [operationCause, cause],
      "Profile operation failed and its owned staging could not be removed",
    );
  }
}

function throwIfAborted(
  signal: AbortSignal | undefined,
  operation: string,
  path: string,
): void {
  if (signal?.aborted) {
    throw new ZigOperationAbortedError(operation, { path }, { cause: signal.reason });
  }
}
