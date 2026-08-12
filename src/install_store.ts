import { isAbsolute, join, relative, resolve } from "@std/path";
import { ZigOperationAbortedError } from "./errors.ts";
import {
  type BuildRecipeDependency,
  type BuildRecipeRepository,
  type BuildRecipeV1,
  isZlsBuildRecipe,
  validateBuildRecipe,
} from "./build_recipe.ts";
import { type Elf64X86_64Info, inspectElf64X86_64 } from "./elf.ts";
import { validateZigSourceVersion } from "./source_version.ts";
import type { ZigSourceVersion } from "./types.ts";
import { type ResolvedZlsSource, validateResolvedZlsSource } from "./zls_source_workspace.ts";
import type { ZlsSourceVersion } from "./zls_source_version.ts";
import {
  assertPathContained,
  atomicWriteJson,
  canonicalJson,
  fileMetadata,
  isPathContained,
  pathExists,
  removeIfPresent,
  sha256Text,
} from "./filesystem.ts";

export const INSTALL_MANIFEST_SCHEMA_VERSION = 3 as const;
export const INSTALL_IDENTITY_SCHEMA_VERSION = 1 as const;

const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type InstallComponent = "zig" | "zls";
export type ResolvedRefKind = "head" | "tag" | "branch" | "commit";
export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export type SourceRepositoryIdentity = BuildRecipeRepository;

export interface InstallSourceIdentity {
  readonly repository: SourceRepositoryIdentity;
  readonly commit: string;
  readonly version: string;
  readonly versionMetadata: ZigSourceVersion | ZlsSourceVersion;
}

export interface LegacyResolvedSource {
  readonly component: InstallComponent;
  readonly repository: SourceRepositoryIdentity;
  readonly requestedSelector: string;
  readonly resolvedRef: {
    readonly kind: ResolvedRefKind;
    readonly value: string;
  };
  readonly commit: string;
  readonly version: string;
  readonly versionMetadata: ZigSourceVersion;
  readonly resolvedAt: string;
}

export type ResolvedSource = LegacyResolvedSource | ResolvedZlsSource;

export type InstallDependency = BuildRecipeDependency;

/** The complete canonical component recipe is the install identity. */
export type InstallIdentityV1 = BuildRecipeV1;

export interface InstallCommandRecord {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly clearEnv: true;
}

export interface RuntimeDependencyRecord {
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export type RuntimeLinkageRecord =
  | { readonly linkage: "static" }
  | {
    readonly linkage: "dynamic";
    readonly interpreter: RuntimeDependencyRecord;
    readonly dependencies: readonly RuntimeDependencyRecord[];
  };

export interface RuntimeDependencyInspectorInput {
  readonly executablePath: string;
  readonly installPath: string;
  readonly cacheRoot: string;
  readonly platform: "linux" | "darwin" | "windows";
  readonly signal?: AbortSignal;
}

export interface RuntimeDependencyInspector {
  readonly contractVersion: number;
  inspect(input: RuntimeDependencyInspectorInput): Promise<RuntimeLinkageRecord>;
}

export interface InstallManifestV3 {
  readonly schemaVersion: 3;
  readonly installationId: string;
  readonly component: InstallComponent;
  readonly identity: InstallIdentityV1;
  readonly source: ResolvedSource;
  readonly paths: {
    readonly executable: string;
    readonly libraries: readonly string[];
  };
  readonly executable: {
    readonly version: string;
    readonly hostTarget: string;
    readonly size: number;
    readonly sha256: string;
    readonly format: Elf64X86_64Info;
  };
  readonly runtime: RuntimeLinkageRecord;
  readonly commands: readonly InstallCommandRecord[];
  readonly dependencies: readonly InstallDependency[];
  readonly createdAt: string;
  readonly verifierContractVersion: number;
}

export interface InstallStaging {
  readonly operationId: string;
  readonly component: InstallComponent;
  readonly installationId: string;
  readonly root: string;
  readonly installPath: string;
  readonly manifestPath: string;
}

export interface StoredInstallMetadata {
  readonly root: string;
  readonly manifestPath: string;
  readonly manifest: InstallManifestV3;
}

export interface InstalledObject extends StoredInstallMetadata {
  readonly executablePath: string;
}

export interface InstallPublishResult extends InstalledObject {
  readonly reused: boolean;
}

export type InstallInspection =
  | { readonly state: "missing"; readonly root: string }
  | { readonly state: "healthy"; readonly installed: InstalledObject }
  | { readonly state: "corrupt"; readonly root: string; readonly error: InstallStoreError };

export interface QuarantinedInstall {
  readonly component: InstallComponent;
  readonly installationId: string;
  readonly sourcePath: string;
  readonly quarantinePath: string;
  readonly operationId: string;
}

export interface InstallStoreOptions {
  /** The manager data root, whose children include installs/ and profiles/. */
  readonly dataRoot: string;
  readonly catalog?: InstallCatalogUpdater;
  readonly createOperationId?: () => string;
}

export interface InstallCatalogUpdater {
  updateInstallation(manifest: InstallManifestV3): Promise<unknown>;
}

export type InstallStoreErrorCode =
  | "INSTALL_INVALID"
  | "INSTALL_CORRUPT"
  | "INSTALL_NOT_FOUND"
  | "INSTALL_CONFLICT"
  | "INSTALL_PATH_INVALID"
  | "INSTALL_STAGING_INVALID";

export class InstallStoreError extends Error {
  readonly code: InstallStoreErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: InstallStoreErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InstallStoreError";
    this.code = code;
    this.details = details;
  }
}

export function validateInstallComponent(value: unknown, path = "component"): InstallComponent {
  if (value !== "zig" && value !== "zls") {
    throw new TypeError(`${path} must be 'zig' or 'zls'`);
  }
  return value;
}

export function validateInstallationId(value: unknown, path = "installationId"): string {
  const result = text(value, path);
  if (!HASH.test(result)) throw new TypeError(`${path} must be a lowercase SHA-256 digest`);
  return result;
}

export function validateTimestamp(value: unknown, path: string): string {
  const result = text(value, path);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(result)) {
    throw new TypeError(`${path} must be a UTC RFC 3339 timestamp`);
  }
  const parsed = new Date(result);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString() !== (result.includes(".") ? result : result.replace("Z", ".000Z"))
  ) {
    throw new TypeError(`${path} must be a valid timestamp`);
  }
  return result;
}

export function validateResolvedSource(value: unknown, path = "source"): ResolvedSource {
  const discriminator = looseObject(value, path);
  if (discriminator.component === "zls") return validateResolvedZlsSource(value, path);
  return validateLegacyResolvedSource(value, path, false);
}

function validateLegacyResolvedSource(
  value: unknown,
  path: string,
  allowLegacyZls: boolean,
): LegacyResolvedSource {
  const root = strictObject(value, path, [
    "component",
    "repository",
    "requestedSelector",
    "resolvedRef",
    "commit",
    "version",
    "versionMetadata",
    "resolvedAt",
  ]);
  const component = validateInstallComponent(root.component, `${path}.component`);
  if (component !== "zig" && !allowLegacyZls) {
    throw new TypeError(`${path}.component must be 'zig'`);
  }
  const repository = sourceRepository(root.repository, `${path}.repository`);
  const resolvedRef = strictObject(root.resolvedRef, `${path}.resolvedRef`, ["kind", "value"]);
  const kind = resolvedRef.kind;
  if (kind !== "head" && kind !== "tag" && kind !== "branch" && kind !== "commit") {
    throw new TypeError(`${path}.resolvedRef.kind is invalid`);
  }
  const commit = objectId(root.commit, `${path}.commit`);
  const version = text(root.version, `${path}.version`);
  const versionMetadata = validateZigSourceVersion(
    root.versionMetadata,
    `${path}.versionMetadata`,
  );
  if (versionMetadata.text !== version) {
    throw new TypeError(`${path}.versionMetadata.text must equal ${path}.version`);
  }
  if (!commit.startsWith(versionMetadata.commitAbbreviation)) {
    throw new TypeError(`${path}.versionMetadata.commitAbbreviation must identify commit`);
  }
  const refValue = text(resolvedRef.value, `${path}.resolvedRef.value`);
  if (kind === "commit" && refValue !== commit) {
    throw new TypeError(`${path}.resolvedRef.value must equal ${path}.commit for a commit ref`);
  }
  return {
    component,
    repository,
    requestedSelector: text(root.requestedSelector, `${path}.requestedSelector`),
    resolvedRef: { kind, value: refValue },
    commit,
    version,
    versionMetadata,
    resolvedAt: validateTimestamp(root.resolvedAt, `${path}.resolvedAt`),
  };
}

export function validateInstallIdentity(value: unknown, path = "identity"): InstallIdentityV1 {
  return validateBuildRecipe(value, path);
}

export async function computeInstallationId(identity: InstallIdentityV1): Promise<string> {
  return await sha256Text(canonicalJson(validateInstallIdentity(identity)));
}

export function validateInstallManifest(value: unknown): InstallManifestV3 {
  const root = strictObject(value, "root", [
    "schemaVersion",
    "installationId",
    "component",
    "identity",
    "source",
    "paths",
    "executable",
    "runtime",
    "commands",
    "dependencies",
    "createdAt",
    "verifierContractVersion",
  ]);
  equal(root.schemaVersion, INSTALL_MANIFEST_SCHEMA_VERSION, "schemaVersion");
  const component = validateInstallComponent(root.component);
  const installationId = validateInstallationId(root.installationId);
  const identity = validateInstallIdentity(root.identity);
  if (identity.component !== component) {
    throw new TypeError("identity.component must equal component");
  }
  const source = isZlsBuildRecipe(identity)
    ? validateResolvedZlsSource(root.source)
    : identity.component === "zls"
    ? validateLegacyResolvedSource(root.source, "source", true)
    : validateResolvedSource(root.source);
  if (!sourceMatchesIdentity(source, identity)) {
    throw new TypeError("source must match identity.source");
  }
  const dependencies = dependencyList(root.dependencies, "dependencies", component);
  if (canonicalJson(dependencies) !== canonicalJson(identity.dependencies)) {
    throw new TypeError("dependencies must match identity.dependencies");
  }
  const paths = strictObject(root.paths, "paths", ["executable", "libraries"]);
  const executablePath = safeInstallPath(paths.executable, "paths.executable");
  const libraries = stringArray(paths.libraries, "paths.libraries").map((item, index) =>
    safeInstallPath(item, `paths.libraries[${index}]`)
  );
  if (new Set(libraries).size !== libraries.length) {
    throw new TypeError("paths.libraries must not contain duplicates");
  }
  const executable = strictObject(root.executable, "executable", [
    "version",
    "hostTarget",
    "size",
    "sha256",
    "format",
  ]);
  const executableVersion = text(executable.version, "executable.version");
  if (executableVersion !== source.version) {
    throw new TypeError("executable.version must equal source.version");
  }
  if (!Array.isArray(root.commands)) throw new TypeError("commands must be an array");
  const format = elfFormat(executable.format, "executable.format");
  const runtime = runtimeLinkage(root.runtime, "runtime");
  const hostTarget = text(executable.hostTarget, "executable.hostTarget");
  if (hostTarget !== identity.host.denoTarget) {
    throw new TypeError("executable.hostTarget must equal identity.host.denoTarget");
  }
  const verifierContractVersion = positiveSafeInteger(
    root.verifierContractVersion,
    "verifierContractVersion",
  );
  if (verifierContractVersion !== identity.adapter.verifierContractVersion) {
    throw new TypeError("verifierContractVersion must equal identity adapter contract");
  }
  if ((runtime.linkage === "dynamic") !== format.dynamicallyLinked) {
    throw new TypeError("runtime linkage must match executable.format.dynamicallyLinked");
  }
  return {
    schemaVersion: INSTALL_MANIFEST_SCHEMA_VERSION,
    installationId,
    component,
    identity,
    source,
    paths: { executable: executablePath, libraries },
    executable: {
      version: executableVersion,
      hostTarget,
      size: positiveSafeInteger(executable.size, "executable.size"),
      sha256: digest(executable.sha256, "executable.sha256"),
      format,
    },
    runtime,
    commands: root.commands.map((item, index) => command(item, `commands[${index}]`)),
    dependencies,
    createdAt: validateTimestamp(root.createdAt, "createdAt"),
    verifierContractVersion,
  };
}

export async function readInstallManifest(path: string): Promise<InstallManifestV3> {
  let value: unknown;
  try {
    value = JSON.parse(await Deno.readTextFile(path));
  } catch (cause) {
    throw new InstallStoreError(
      "INSTALL_INVALID",
      `Install manifest could not be read as JSON: ${path}`,
      { path },
      { cause },
    );
  }
  try {
    return validateInstallManifest(value);
  } catch (cause) {
    throw new InstallStoreError(
      "INSTALL_INVALID",
      `Invalid install manifest '${path}': ${message(cause)}`,
      { path, reason: message(cause) },
      { cause },
    );
  }
}

export class InstallStore {
  readonly dataRoot: string;
  readonly installsRoot: string;
  readonly stagingRoot: string;
  readonly corruptRoot: string;
  readonly #catalog: InstallCatalogUpdater | undefined;
  readonly #createOperationId: () => string;

  constructor(options: InstallStoreOptions | string) {
    const resolvedOptions: InstallStoreOptions = typeof options === "string"
      ? { dataRoot: options }
      : options;
    rejectControls(resolvedOptions.dataRoot, "dataRoot");
    this.dataRoot = resolve(resolvedOptions.dataRoot);
    this.installsRoot = join(this.dataRoot, "installs");
    this.stagingRoot = join(this.installsRoot, ".staging");
    this.corruptRoot = join(this.installsRoot, ".corrupt");
    this.#catalog = resolvedOptions.catalog;
    this.#createOperationId = resolvedOptions.createOperationId ?? (() => crypto.randomUUID());
  }

  installationPath(component: InstallComponent, installationId: string): string {
    return join(
      this.installsRoot,
      validateInstallComponent(component),
      validateInstallationId(installationId),
    );
  }

  installManifestPath(component: InstallComponent, installationId: string): string {
    return join(this.installationPath(component, installationId), "install-manifest.json");
  }

  resolveArtifactPath(
    component: InstallComponent,
    installationId: string,
    artifactPath: string,
  ): string {
    const root = this.installationPath(component, installationId);
    const validated = safeInstallPath(artifactPath, "artifactPath");
    const result = join(root, ...validated.split("/"));
    assertPathContained(root, result);
    return result;
  }

  async createStaging(
    component: InstallComponent,
    installationId: string,
    operationId: string = this.#createOperationId(),
    signal?: AbortSignal,
  ): Promise<InstallStaging> {
    throwIfAborted(signal, "create install staging", this.stagingRoot);
    await this.#ensureLayout();
    throwIfAborted(signal, "create install staging", this.stagingRoot);
    const validatedComponent = validateInstallComponent(component);
    const validatedId = validateInstallationId(installationId);
    const validatedOperationId = operationSegment(operationId);
    const root = join(this.stagingRoot, validatedOperationId);
    assertPathContained(this.stagingRoot, root);
    let rootCreated = false;
    try {
      await Deno.mkdir(root);
      rootCreated = true;
      throwIfAborted(signal, "create install staging", root);
      await Deno.mkdir(join(root, "install"));
    } catch (cause) {
      if (rootCreated) await removeIfPresent(root, true);
      if (cause instanceof ZigOperationAbortedError) throw cause;
      throw new InstallStoreError(
        "INSTALL_STAGING_INVALID",
        `Unable to create unique install staging directory: ${root}`,
        { root, operationId: validatedOperationId },
        { cause },
      );
    }
    return Object.freeze({
      operationId: validatedOperationId,
      component: validatedComponent,
      installationId: validatedId,
      root,
      installPath: join(root, "install"),
      manifestPath: join(root, "install-manifest.json"),
    });
  }

  async writeStagedManifest(
    staging: InstallStaging,
    value: InstallManifestV3,
    signal?: AbortSignal,
  ): Promise<InstallManifestV3> {
    throwIfAborted(signal, "write staged install manifest", staging.root);
    const checkedStaging = await this.#validateStaging(staging, signal);
    const manifest = validateInstallManifest(value);
    await this.#assertManifestMatchesStaging(manifest, checkedStaging);
    if (await pathExists(checkedStaging.manifestPath)) {
      throw new InstallStoreError(
        "INSTALL_STAGING_INVALID",
        `Staged install manifest already exists: ${checkedStaging.manifestPath}`,
        { path: checkedStaging.manifestPath },
      );
    }
    await this.#verifyArtifacts(checkedStaging.root, manifest, signal);
    await this.#verifyDependencies(manifest, signal);
    throwIfAborted(signal, "write staged install manifest", checkedStaging.manifestPath);
    await atomicWriteJson(checkedStaging.manifestPath, manifest, {
      operationId: checkedStaging.operationId,
      signal,
    });
    return await readInstallManifest(checkedStaging.manifestPath);
  }

  async publish(
    staging: InstallStaging,
    manifest: InstallManifestV3,
    signal?: AbortSignal,
  ): Promise<InstallPublishResult> {
    await this.writeStagedManifest(staging, manifest, signal);
    throwIfAborted(signal, "promote immutable installation", staging.root);
    return await this.promote(staging, signal);
  }

  async promote(staging: InstallStaging, signal?: AbortSignal): Promise<InstallPublishResult> {
    throwIfAborted(signal, "promote immutable installation", staging.root);
    const checkedStaging = await this.#validateStaging(staging, signal);
    const manifest = await readInstallManifest(checkedStaging.manifestPath);
    await this.#assertManifestMatchesStaging(manifest, checkedStaging);
    await assertTreeHasNoSymlinks(checkedStaging.root, signal);
    await this.#verifyArtifacts(checkedStaging.root, manifest, signal);
    await this.#verifyDependencies(manifest, signal);

    const destination = this.installationPath(manifest.component, manifest.installationId);
    await ensureDirectoryNoSymlink(join(this.installsRoot, manifest.component));
    await assertNoSymlinkPath(this.dataRoot, join(this.installsRoot, manifest.component), false);
    if (await pathExists(destination)) {
      return await this.#reuseExisting(destination, checkedStaging, manifest, signal);
    }

    try {
      // Both paths are below data/installs, so this is one same-filesystem atomic rename.
      throwIfAborted(signal, "promote immutable installation", destination);
      await Deno.rename(checkedStaging.root, destination);
    } catch (cause) {
      if (cause instanceof ZigOperationAbortedError) throw cause;
      if (await pathExists(destination)) {
        return await this.#reuseExisting(destination, checkedStaging, manifest, signal);
      }
      throw new InstallStoreError(
        "INSTALL_CONFLICT",
        `Unable to promote immutable installation: ${destination}`,
        { destination },
        { cause },
      );
    }

    const promoted = await this.get(manifest.component, manifest.installationId);
    if (this.#catalog !== undefined) await this.#catalog.updateInstallation(promoted.manifest);
    return { ...promoted, reused: false };
  }

  async get(component: InstallComponent, installationId: string): Promise<InstalledObject> {
    await this.#ensureLayout();
    const metadata = await this.readMetadata(component, installationId);
    const { root, manifest, manifestPath } = metadata;
    const validatedComponent = manifest.component;
    const validatedId = manifest.installationId;
    await assertTreeHasNoSymlinks(root);
    await this.#verifyArtifacts(root, manifest);
    await this.#verifyDependencies(manifest);
    return {
      root,
      manifestPath,
      executablePath: this.resolveArtifactPath(
        validatedComponent,
        validatedId,
        manifest.paths.executable,
      ),
      manifest,
    };
  }

  /** Read validated immutable metadata without inspecting artifacts or resolving dependencies. */
  async readMetadata(
    component: InstallComponent,
    installationId: string,
  ): Promise<StoredInstallMetadata> {
    const validatedComponent = validateInstallComponent(component);
    const validatedId = validateInstallationId(installationId);
    const root = this.installationPath(validatedComponent, validatedId);
    if (!await pathExists(root)) {
      throw new InstallStoreError(
        "INSTALL_NOT_FOUND",
        `Immutable ${validatedComponent} installation was not found: ${validatedId}`,
        { component: validatedComponent, installationId: validatedId, root },
      );
    }
    await assertNoSymlinkPath(this.dataRoot, root, false);
    const stat = await safeLstat(root, "INSTALL_INVALID");
    if (!stat.isDirectory || stat.isSymlink) {
      throw new InstallStoreError(
        "INSTALL_INVALID",
        `Installation path is not a real directory: ${root}`,
        { root },
      );
    }

    const manifestPath = join(root, "install-manifest.json");
    await assertNoSymlinkPath(root, manifestPath, false);
    const manifestStat = await safeLstat(manifestPath, "INSTALL_INVALID");
    if (!manifestStat.isFile || manifestStat.isSymlink) {
      throw new InstallStoreError(
        "INSTALL_INVALID",
        `Install manifest is not a physical regular file: ${manifestPath}`,
        { root, manifestPath },
      );
    }
    const manifest = await readInstallManifest(manifestPath);
    if (manifest.component !== validatedComponent || manifest.installationId !== validatedId) {
      throw new InstallStoreError(
        "INSTALL_INVALID",
        `Install manifest does not match its immutable directory: ${root}`,
        { root, component: manifest.component, installationId: manifest.installationId },
      );
    }
    const computedId = await computeInstallationId(manifest.identity);
    if (computedId !== validatedId) {
      throw new InstallStoreError(
        "INSTALL_INVALID",
        `Install identity does not match its installation ID: ${root}`,
        { root, expected: validatedId, actual: computedId },
      );
    }
    return { root, manifestPath, manifest };
  }

  async tryReadMetadata(
    component: InstallComponent,
    installationId: string,
  ): Promise<StoredInstallMetadata | null> {
    try {
      return await this.readMetadata(component, installationId);
    } catch (cause) {
      if (cause instanceof InstallStoreError && cause.code === "INSTALL_NOT_FOUND") return null;
      throw cause;
    }
  }

  async tryGet(
    component: InstallComponent,
    installationId: string,
  ): Promise<InstalledObject | null> {
    try {
      return await this.get(component, installationId);
    } catch (cause) {
      if (cause instanceof InstallStoreError && cause.code === "INSTALL_NOT_FOUND") return null;
      throw cause;
    }
  }

  /** Classify one canonical final object without mutating it. */
  async inspect(
    component: InstallComponent,
    installationId: string,
  ): Promise<InstallInspection> {
    const validatedComponent = validateInstallComponent(component);
    const validatedId = validateInstallationId(installationId);
    const root = this.installationPath(validatedComponent, validatedId);
    try {
      return { state: "healthy", installed: await this.get(validatedComponent, validatedId) };
    } catch (cause) {
      if (cause instanceof InstallStoreError && cause.code === "INSTALL_NOT_FOUND") {
        return { state: "missing", root };
      }
      const error = cause instanceof InstallStoreError ? cause : new InstallStoreError(
        "INSTALL_CORRUPT",
        `Unable to validate immutable installation: ${root}`,
        { component: validatedComponent, installationId: validatedId, root },
        { cause },
      );
      return { state: "corrupt", root, error };
    }
  }

  /**
   * Atomically preserve one exact final object under manager-owned quarantine. The caller must
   * explicitly authorize either a previously corrupt object or an object created by its operation.
   */
  async quarantine(
    component: InstallComponent,
    installationId: string,
    operationId: string,
    authorization: "corrupt" | "created",
    signal?: AbortSignal,
  ): Promise<QuarantinedInstall> {
    throwIfAborted(signal, "quarantine immutable installation", this.installsRoot);
    const validatedComponent = validateInstallComponent(component);
    const validatedId = validateInstallationId(installationId);
    const validatedOperationId = operationSegment(operationId);
    if (authorization !== "corrupt" && authorization !== "created") {
      throw new InstallStoreError("INSTALL_INVALID", "Install quarantine requires authorization");
    }
    const sourcePath = this.installationPath(validatedComponent, validatedId);
    if (authorization === "corrupt") {
      const inspection = await this.inspect(validatedComponent, validatedId);
      throwIfAborted(signal, "quarantine immutable installation", sourcePath);
      if (inspection.state === "missing") {
        throw new InstallStoreError(
          "INSTALL_NOT_FOUND",
          `Immutable installation disappeared before quarantine: ${sourcePath}`,
          { component: validatedComponent, installationId: validatedId, root: sourcePath },
        );
      }
      // A structurally healthy object may still have failed the caller's full Zig verification.
    } else if (!await pathExists(sourcePath)) {
      throw new InstallStoreError(
        "INSTALL_NOT_FOUND",
        `Created immutable installation disappeared before quarantine: ${sourcePath}`,
        { component: validatedComponent, installationId: validatedId, root: sourcePath },
      );
    }

    await this.#ensureLayout();
    const componentRoot = join(this.corruptRoot, validatedComponent);
    await ensureDirectoryNoSymlink(componentRoot);
    const quarantinePath = join(componentRoot, `${validatedId}-${validatedOperationId}`);
    assertPathContained(componentRoot, quarantinePath);
    if (await pathExists(quarantinePath)) {
      throw new InstallStoreError(
        "INSTALL_CONFLICT",
        `Install quarantine destination already exists: ${quarantinePath}`,
        { quarantinePath },
      );
    }
    try {
      throwIfAborted(signal, "quarantine immutable installation", sourcePath);
      await Deno.rename(sourcePath, quarantinePath);
    } catch (cause) {
      if (cause instanceof ZigOperationAbortedError) throw cause;
      throw new InstallStoreError(
        "INSTALL_PATH_INVALID",
        `Unable to quarantine immutable installation: ${sourcePath}`,
        { sourcePath, quarantinePath },
        { cause },
      );
    }
    return {
      component: validatedComponent,
      installationId: validatedId,
      sourcePath,
      quarantinePath,
      operationId: validatedOperationId,
    };
  }

  async list(): Promise<readonly InstalledObject[]> {
    await this.#ensureLayout();
    const result: InstalledObject[] = [];
    for (const component of ["zig", "zls"] as const) {
      const componentRoot = join(this.installsRoot, component);
      for await (const entry of Deno.readDir(componentRoot)) {
        if (!entry.isDirectory || entry.isSymlink || !HASH.test(entry.name)) {
          throw new InstallStoreError(
            "INSTALL_INVALID",
            `Unexpected object in immutable ${component} install store: ${entry.name}`,
            { component, name: entry.name, componentRoot },
          );
        }
        result.push(await this.get(component, entry.name));
      }
    }
    result.sort((left, right) =>
      left.manifest.component.localeCompare(right.manifest.component) ||
      left.manifest.installationId.localeCompare(right.manifest.installationId)
    );
    return result;
  }

  /** Enumerate strict manifests without creating store directories or validating final artifacts. */
  async listMetadata(): Promise<readonly StoredInstallMetadata[]> {
    const installsInfo = await lstatIfPresent(this.installsRoot, "INSTALL_PATH_INVALID");
    if (installsInfo === null) return [];
    await assertPhysicalStoreDirectory(
      this.dataRoot,
      this.installsRoot,
      installsInfo,
      "install root",
    );

    const result: StoredInstallMetadata[] = [];
    for (const component of ["zig", "zls"] as const) {
      const componentRoot = join(this.installsRoot, component);
      const componentInfo = await lstatIfPresent(componentRoot, "INSTALL_PATH_INVALID");
      if (componentInfo === null) continue;
      await assertPhysicalStoreDirectory(
        this.dataRoot,
        componentRoot,
        componentInfo,
        `${component} install root`,
      );
      const entries: Deno.DirEntry[] = [];
      for await (const entry of Deno.readDir(componentRoot)) entries.push(entry);
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (!entry.isDirectory || entry.isSymlink || !HASH.test(entry.name)) {
          throw new InstallStoreError(
            "INSTALL_INVALID",
            `Unexpected object in immutable ${component} install store: ${entry.name}`,
            { component, name: entry.name, componentRoot },
          );
        }
        result.push(await this.readMetadata(component, entry.name));
      }
    }
    return result;
  }

  /** Remove exactly one fully validated immutable installation and never a symlinked tree. */
  async remove(
    component: InstallComponent,
    installationId: string,
    signal?: AbortSignal,
  ): Promise<InstalledObject> {
    throwIfAborted(signal, "remove immutable installation", this.installsRoot);
    const installed = await this.get(component, installationId);
    await assertTreeHasNoSymlinks(installed.root, signal);
    const current = await safeLstat(installed.root, "INSTALL_INVALID");
    if (!current.isDirectory || current.isSymlink) {
      throw new InstallStoreError(
        "INSTALL_INVALID",
        `Installation path changed before removal: ${installed.root}`,
        { root: installed.root },
      );
    }
    try {
      throwIfAborted(signal, "remove immutable installation", installed.root);
      await Deno.remove(installed.root, { recursive: true });
    } catch (cause) {
      if (cause instanceof ZigOperationAbortedError) throw cause;
      throw new InstallStoreError(
        "INSTALL_PATH_INVALID",
        `Unable to remove validated immutable installation: ${installed.root}`,
        { root: installed.root, component, installationId },
        { cause },
      );
    }
    return installed;
  }

  async discardStaging(staging: InstallStaging): Promise<void> {
    const checked = await this.#validateStaging(staging);
    await removeIfPresent(checked.root, true);
  }

  async #ensureLayout(): Promise<void> {
    await ensureDirectoryNoSymlink(this.dataRoot, true);
    await ensureDirectoryNoSymlink(this.installsRoot);
    await ensureDirectoryNoSymlink(this.stagingRoot);
    await ensureDirectoryNoSymlink(this.corruptRoot);
    await ensureDirectoryNoSymlink(join(this.corruptRoot, "zig"));
    await ensureDirectoryNoSymlink(join(this.corruptRoot, "zls"));
    await ensureDirectoryNoSymlink(join(this.installsRoot, "zig"));
    await ensureDirectoryNoSymlink(join(this.installsRoot, "zls"));
    await assertNoSymlinkPath(this.dataRoot, this.installsRoot, false);
  }

  async #validateStaging(
    staging: InstallStaging,
    signal?: AbortSignal,
  ): Promise<InstallStaging> {
    throwIfAborted(signal, "validate install staging", staging.root);
    await this.#ensureLayout();
    const operationId = operationSegment(staging.operationId);
    const component = validateInstallComponent(staging.component);
    const installationId = validateInstallationId(staging.installationId);
    const root = join(this.stagingRoot, operationId);
    const installPath = join(root, "install");
    const manifestPath = join(root, "install-manifest.json");
    if (
      resolve(staging.root) !== root || resolve(staging.installPath) !== installPath ||
      resolve(staging.manifestPath) !== manifestPath
    ) {
      throw new InstallStoreError(
        "INSTALL_STAGING_INVALID",
        "Install staging paths do not match their operation ID",
        { operationId, root: staging.root },
      );
    }
    await assertNoSymlinkPath(this.stagingRoot, root, false);
    const rootStat = await safeLstat(root, "INSTALL_STAGING_INVALID");
    const installStat = await safeLstat(installPath, "INSTALL_STAGING_INVALID");
    if (
      !rootStat.isDirectory || rootStat.isSymlink || !installStat.isDirectory ||
      installStat.isSymlink
    ) {
      throw new InstallStoreError(
        "INSTALL_STAGING_INVALID",
        `Install staging contains a non-directory or symlink: ${root}`,
        { root },
      );
    }
    return { operationId, component, installationId, root, installPath, manifestPath };
  }

  async #assertManifestMatchesStaging(
    manifest: InstallManifestV3,
    staging: InstallStaging,
  ): Promise<void> {
    if (
      manifest.component !== staging.component ||
      manifest.installationId !== staging.installationId
    ) {
      throw new InstallStoreError(
        "INSTALL_STAGING_INVALID",
        "Install manifest does not match its staging allocation",
        {
          stagedComponent: staging.component,
          stagedInstallationId: staging.installationId,
          manifestComponent: manifest.component,
          manifestInstallationId: manifest.installationId,
        },
      );
    }
    const computedId = await computeInstallationId(manifest.identity);
    if (computedId !== manifest.installationId) {
      throw new InstallStoreError(
        "INSTALL_INVALID",
        "Install manifest ID does not match its canonical identity",
        { expected: manifest.installationId, actual: computedId },
      );
    }
  }

  async #verifyArtifacts(
    root: string,
    manifest: InstallManifestV3,
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal, "verify install artifacts", root);
    assertPathContained(root, join(root, "install"));
    const executablePath = artifactAt(root, manifest.paths.executable);
    await assertNoSymlinkPath(root, executablePath, false);
    const executableStat = await safeLstat(executablePath, "INSTALL_INVALID");
    if (!executableStat.isFile || executableStat.isSymlink) {
      throw new InstallStoreError(
        "INSTALL_INVALID",
        `Manifest executable is not a regular file: ${executablePath}`,
        { executablePath },
      );
    }
    if (
      Deno.build.os !== "windows" && executableStat.mode !== null &&
      (executableStat.mode & 0o111) === 0
    ) {
      throw new InstallStoreError(
        "INSTALL_INVALID",
        `Manifest executable is not executable: ${executablePath}`,
        { executablePath },
      );
    }
    const metadata = await fileMetadata(executablePath, signal);
    if (
      metadata.size !== manifest.executable.size ||
      metadata.sha256 !== manifest.executable.sha256
    ) {
      throw new InstallStoreError(
        "INSTALL_INVALID",
        `Manifest executable metadata does not match: ${executablePath}`,
        {
          executablePath,
          expectedSize: manifest.executable.size,
          actualSize: metadata.size,
          expectedSha256: manifest.executable.sha256,
          actualSha256: metadata.sha256,
        },
      );
    }
    let format: Elf64X86_64Info;
    try {
      format = await inspectElf64X86_64(executablePath);
    } catch (cause) {
      throw new InstallStoreError(
        "INSTALL_CORRUPT",
        `Manifest ${manifest.component} executable is not ELF64 little-endian x86_64: ${executablePath}`,
        { executablePath },
        { cause },
      );
    }
    if (canonicalJson(format) !== canonicalJson(manifest.executable.format)) {
      throw new InstallStoreError(
        "INSTALL_CORRUPT",
        `Manifest executable format metadata does not match: ${executablePath}`,
        { executablePath },
      );
    }
    if (manifest.runtime.linkage === "dynamic") {
      const interpreter = format.interpreter;
      if (interpreter === null) {
        throw new InstallStoreError(
          "INSTALL_CORRUPT",
          `Dynamic executable does not record an ELF interpreter: ${executablePath}`,
          { executablePath },
        );
      }
      const candidateInfo = await safeLstat(interpreter, "INSTALL_CORRUPT");
      if (!candidateInfo.isFile || candidateInfo.isSymlink) {
        throw new InstallStoreError(
          "INSTALL_CORRUPT",
          `ELF interpreter is not a physical regular file: ${interpreter}`,
          { interpreter },
        );
      }
      let physicalInterpreter: string;
      try {
        physicalInterpreter = resolve(await Deno.realPath(interpreter));
      } catch (cause) {
        throw new InstallStoreError(
          "INSTALL_CORRUPT",
          `ELF interpreter could not be physically resolved: ${interpreter}`,
          { interpreter },
          { cause },
        );
      }
      if (physicalInterpreter !== manifest.runtime.interpreter.path) {
        throw new InstallStoreError(
          "INSTALL_CORRUPT",
          `Runtime interpreter does not match the ELF interpreter: ${interpreter}`,
          { interpreter, physicalInterpreter, recorded: manifest.runtime.interpreter.path },
        );
      }
    }
    for (const library of manifest.paths.libraries) {
      throwIfAborted(signal, "verify install artifacts", root);
      const libraryPath = artifactAt(root, library);
      await assertNoSymlinkPath(root, libraryPath, false);
      const stat = await safeLstat(libraryPath, "INSTALL_INVALID");
      if (!stat.isDirectory || stat.isSymlink) {
        throw new InstallStoreError(
          "INSTALL_INVALID",
          `Manifest library path is not a real directory: ${libraryPath}`,
          { libraryPath },
        );
      }
    }
    const runtimeFiles = manifest.runtime.linkage === "static"
      ? []
      : [manifest.runtime.interpreter, ...manifest.runtime.dependencies];
    const finalRoot = this.installationPath(manifest.component, manifest.installationId);
    for (const dependency of runtimeFiles) {
      throwIfAborted(signal, "verify install artifacts", root);
      const inspectedPath = root !== finalRoot && isPathContained(finalRoot, dependency.path)
        ? join(root, relative(finalRoot, dependency.path))
        : dependency.path;
      await assertNoSymlinkPath(resolve("/"), inspectedPath, false);
      const info = await safeLstat(inspectedPath, "INSTALL_CORRUPT");
      if (!info.isFile || info.isSymlink) {
        throw new InstallStoreError(
          "INSTALL_CORRUPT",
          `Runtime dependency is not a physical regular file: ${inspectedPath}`,
          { path: inspectedPath },
        );
      }
      const actual = await fileMetadata(inspectedPath, signal);
      if (actual.size !== dependency.size || actual.sha256 !== dependency.sha256) {
        throw new InstallStoreError(
          "INSTALL_CORRUPT",
          `Runtime dependency fingerprint changed: ${dependency.path}`,
          { path: dependency.path },
        );
      }
    }
  }

  async #verifyDependencies(manifest: InstallManifestV3, signal?: AbortSignal): Promise<void> {
    for (const dependency of manifest.dependencies) {
      throwIfAborted(signal, "verify install dependencies", manifest.installationId);
      await this.get(dependency.component, dependency.installationId);
    }
  }

  async #reuseExisting(
    destination: string,
    staging: InstallStaging,
    incoming: InstallManifestV3,
    signal?: AbortSignal,
  ): Promise<InstallPublishResult> {
    let existing: InstalledObject;
    try {
      existing = await this.get(incoming.component, incoming.installationId);
    } catch (cause) {
      throw new InstallStoreError(
        "INSTALL_CONFLICT",
        `An existing object blocks immutable installation promotion: ${destination}`,
        { destination },
        { cause },
      );
    }
    if (
      canonicalJson(stableManifestProjection(existing.manifest)) !==
        canonicalJson(stableManifestProjection(incoming))
    ) {
      throw new InstallStoreError(
        "INSTALL_CONFLICT",
        `Existing immutable installation has conflicting stable content: ${destination}`,
        { destination },
      );
    }
    throwIfAborted(signal, "discard duplicate install staging", staging.root);
    await removeIfPresent(staging.root, true);
    if (this.#catalog !== undefined) await this.#catalog.updateInstallation(existing.manifest);
    return { ...existing, reused: true };
  }
}

function stableManifestProjection(manifestValue: InstallManifestV3): unknown {
  const manifest = validateInstallManifest(manifestValue);
  return {
    schemaVersion: manifest.schemaVersion,
    installationId: manifest.installationId,
    component: manifest.component,
    identity: manifest.identity,
    source: {
      component: manifest.source.component,
      repository: manifest.source.repository,
      commit: manifest.source.commit,
      version: manifest.source.version,
      versionMetadata: manifest.source.versionMetadata,
    },
    paths: manifest.paths,
    executable: manifest.executable,
    runtime: manifest.runtime,
    commands: manifest.commands,
    dependencies: manifest.dependencies,
    verifierContractVersion: manifest.verifierContractVersion,
  };
}

function sourceMatchesIdentity(source: ResolvedSource, identity: InstallIdentityV1): boolean {
  if (isZlsBuildRecipe(identity)) {
    return source.component === "zls" &&
      canonicalJson(source) === canonicalJson(identity.source.resolved);
  }
  return canonicalJson(source.repository) === canonicalJson(identity.source.repository) &&
    source.component === identity.component && source.commit === identity.source.commit &&
    canonicalJson(source.versionMetadata) === canonicalJson(identity.source.version) &&
    source.version === identity.source.version.text;
}

function sourceRepository(value: unknown, path: string): SourceRepositoryIdentity {
  const root = strictObject(value, path, ["identity", "url"]);
  const identity = text(root.identity, `${path}.identity`);
  if (
    !/^[a-z0-9](?:[a-z0-9._/-]{0,126}[a-z0-9])?$/.test(identity) ||
    identity.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new TypeError(`${path}.identity must be a normalized repository identity`);
  }
  const urlText = text(root.url, `${path}.url`);
  let url: URL;
  try {
    url = new URL(urlText);
  } catch (cause) {
    throw new TypeError(`${path}.url must be an absolute URL`, { cause });
  }
  if (url.username !== "" || url.password !== "") {
    throw new TypeError(`${path}.url must not contain credentials`);
  }
  if (url.protocol !== "https:") throw new TypeError(`${path}.url must use HTTPS`);
  if (url.search !== "" || url.hash !== "" || url.href !== urlText) {
    throw new TypeError(
      `${path}.url must be a normalized repository URL without query or fragment`,
    );
  }
  return { identity, url: urlText };
}

function dependencyList(
  value: unknown,
  path: string,
  component: InstallComponent,
): readonly InstallDependency[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  const dependencies = value.map((item, index) => {
    const dependency = strictObject(item, `${path}[${index}]`, ["component", "installationId"]);
    equal(dependency.component, "zig", `${path}[${index}].component`);
    return {
      component: "zig" as const,
      installationId: validateInstallationId(
        dependency.installationId,
        `${path}[${index}].installationId`,
      ),
    };
  });
  if (component === "zig" && dependencies.length !== 0) {
    throw new TypeError(`${path} must be empty for Zig installations`);
  }
  if (component === "zls" && dependencies.length !== 1) {
    throw new TypeError(`${path} must contain exactly one Zig installation for ZLS`);
  }
  return dependencies;
}

function runtimeDependency(value: unknown, path: string): RuntimeDependencyRecord {
  const root = strictObject(value, path, ["name", "path", "size", "sha256"]);
  const dependencyPath = text(root.path, `${path}.path`);
  if (!isAbsolute(dependencyPath) || resolve(dependencyPath) !== dependencyPath) {
    throw new TypeError(`${path}.path must be an absolute normalized path`);
  }
  return {
    name: text(root.name, `${path}.name`),
    path: dependencyPath,
    size: positiveSafeInteger(root.size, `${path}.size`),
    sha256: digest(root.sha256, `${path}.sha256`),
  };
}

function runtimeLinkage(value: unknown, path: string): RuntimeLinkageRecord {
  const root = looseObject(value, path);
  if (root.linkage === "static") {
    strictObject(value, path, ["linkage"]);
    return { linkage: "static" };
  }
  if (root.linkage !== "dynamic") {
    throw new TypeError(`${path}.linkage must be static or dynamic`);
  }
  const dynamic = strictObject(value, path, ["linkage", "interpreter", "dependencies"]);
  if (!Array.isArray(dynamic.dependencies)) {
    throw new TypeError(`${path}.dependencies must be an array`);
  }
  const interpreter = runtimeDependency(dynamic.interpreter, `${path}.interpreter`);
  const dependencies = dynamic.dependencies.map((item, index) =>
    runtimeDependency(item, `${path}.dependencies[${index}]`)
  );
  const names = [interpreter, ...dependencies].map((item) => item.name);
  const paths = [interpreter, ...dependencies].map((item) => item.path);
  if (new Set(names).size !== names.length || new Set(paths).size !== paths.length) {
    throw new TypeError(`${path} contains duplicate dependency names or paths`);
  }
  const sorted = [...dependencies].sort((left, right) =>
    compareText(left.name, right.name) || compareText(left.path, right.path)
  );
  if (canonicalJson(sorted) !== canonicalJson(dependencies)) {
    throw new TypeError(`${path}.dependencies must be canonically sorted`);
  }
  return { linkage: "dynamic", interpreter, dependencies };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function elfFormat(value: unknown, path: string): Elf64X86_64Info {
  const root = strictObject(value, path, [
    "format",
    "class",
    "endianness",
    "machine",
    "type",
    "dynamicallyLinked",
    "interpreter",
  ]);
  equal(root.format, "elf", `${path}.format`);
  equal(root.class, 64, `${path}.class`);
  equal(root.endianness, "little", `${path}.endianness`);
  equal(root.machine, "x86_64", `${path}.machine`);
  if (root.type !== "executable" && root.type !== "shared") {
    throw new TypeError(`${path}.type must be executable or shared`);
  }
  if (typeof root.dynamicallyLinked !== "boolean") {
    throw new TypeError(`${path}.dynamicallyLinked must be boolean`);
  }
  const interpreter = root.interpreter === null
    ? null
    : text(root.interpreter, `${path}.interpreter`);
  if (interpreter !== null && (!isAbsolute(interpreter) || resolve(interpreter) !== interpreter)) {
    throw new TypeError(`${path}.interpreter must be null or an absolute normalized path`);
  }
  if (!root.dynamicallyLinked && interpreter !== null) {
    throw new TypeError(`${path}.interpreter requires dynamic linkage`);
  }
  return {
    format: "elf",
    class: 64,
    endianness: "little",
    machine: "x86_64",
    type: root.type,
    dynamicallyLinked: root.dynamicallyLinked,
    interpreter,
  };
}

function command(value: unknown, path: string): InstallCommandRecord {
  const root = strictObject(value, path, ["executable", "args", "cwd", "env", "clearEnv"]);
  equal(root.clearEnv, true, `${path}.clearEnv`);
  const args = stringArray(root.args, `${path}.args`);
  const envObject = looseObject(root.env, `${path}.env`);
  const env: Record<string, string> = {};
  for (const key of Object.keys(envObject).sort()) {
    rejectControls(key, `${path}.env key`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new TypeError(`${path}.env contains invalid variable '${key}'`);
    }
    env[key] = text(envObject[key], `${path}.env.${key}`, true);
  }
  return {
    executable: text(root.executable, `${path}.executable`),
    args: args.map((item, index) => text(item, `${path}.args[${index}]`, true)),
    cwd: text(root.cwd, `${path}.cwd`),
    env,
    clearEnv: true,
  };
}

function safeInstallPath(value: unknown, path: string): string {
  const result = text(value, path);
  if (result.includes("\\") || result.startsWith("/") || /^[A-Za-z]:/.test(result)) {
    throw new TypeError(`${path} must be a canonical relative install path`);
  }
  const segments = result.split("/");
  if (
    segments.length < 2 || segments[0] !== "install" ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new TypeError(`${path} must be below the install directory without path traversal`);
  }
  return result;
}

function artifactAt(root: string, path: string): string {
  const result = join(root, ...safeInstallPath(path, "artifactPath").split("/"));
  assertPathContained(join(root, "install"), result);
  return result;
}

function operationSegment(value: unknown): string {
  const result = text(value, "operationId");
  if (!OPERATION_ID.test(result)) {
    throw new InstallStoreError(
      "INSTALL_STAGING_INVALID",
      "operationId is not safe for an install staging path",
      { operationId: result },
    );
  }
  return result;
}

function objectId(value: unknown, path: string): string {
  const result = text(value, path);
  if (!COMMIT.test(result)) throw new TypeError(`${path} must be a lowercase object ID`);
  return result;
}

function digest(value: unknown, path: string): string {
  const result = text(value, path);
  if (!HASH.test(result)) throw new TypeError(`${path} must be a lowercase SHA-256 digest`);
  return result;
}

function text(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${path} must be ${allowEmpty ? "a string" : "a nonempty string"}`);
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

function positiveSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${path} must be a positive safe integer`);
  }
  return value as number;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new TypeError(`${path} must be an array of strings`);
  }
  return [...value];
}

function strictObject(
  value: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> {
  const result = looseObject(value, path);
  const unknown = Object.keys(result).filter((key) => !keys.includes(key)).sort();
  if (unknown.length > 0) throw new TypeError(`${path} contains unknown key '${unknown[0]}'`);
  for (const key of keys) if (!(key in result)) throw new TypeError(`${path}.${key} is required`);
  return result;
}

function looseObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function jsonRecord(value: unknown, path: string): Readonly<Record<string, CanonicalJsonValue>> {
  const source = looseObject(value, path);
  const result: Record<string, CanonicalJsonValue> = {};
  for (const key of Object.keys(source).sort()) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new TypeError(`${path} contains unsafe key '${key}'`);
    }
    rejectControls(key, `${path} key`);
    result[key] = jsonValue(source[key], `${path}.${key}`);
  }
  return result;
}

function jsonValue(value: unknown, path: string): CanonicalJsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return text(value, path, true);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must be finite`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${path}[${index}]`));
  return jsonRecord(value, path);
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
  const stat = await safeLstat(path, "INSTALL_PATH_INVALID");
  if (!stat.isDirectory || stat.isSymlink) {
    throw new InstallStoreError(
      "INSTALL_PATH_INVALID",
      `Managed store path is not a real directory: ${path}`,
      { path },
    );
  }
}

async function assertNoSymlinkPath(
  root: string,
  candidate: string,
  allowMissingTail: boolean,
): Promise<void> {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = assertPathContained(normalizedRoot, candidate);
  const rel = relative(normalizedRoot, normalizedCandidate);
  let current = normalizedRoot;
  const segments = rel === "" ? [] : rel.split(/[\\/]/);
  for (const segment of ["", ...segments]) {
    if (segment !== "") current = join(current, segment);
    try {
      const stat = await Deno.lstat(current);
      if (stat.isSymlink) {
        throw new InstallStoreError(
          "INSTALL_PATH_INVALID",
          `Managed path contains a symlink: ${current}`,
          { root: normalizedRoot, candidate: normalizedCandidate, symlink: current },
        );
      }
    } catch (cause) {
      if (cause instanceof Deno.errors.NotFound && allowMissingTail) return;
      if (cause instanceof InstallStoreError) throw cause;
      throw new InstallStoreError(
        "INSTALL_PATH_INVALID",
        `Unable to inspect managed path: ${current}`,
        { current },
        { cause },
      );
    }
  }
}

async function assertTreeHasNoSymlinks(root: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal, "inspect managed tree", root);
  const rootStat = await safeLstat(root, "INSTALL_PATH_INVALID");
  if (!rootStat.isDirectory || rootStat.isSymlink) {
    throw new InstallStoreError(
      "INSTALL_PATH_INVALID",
      `Managed object root is not a real directory: ${root}`,
      { root },
    );
  }
  const pending = [root];
  while (pending.length > 0) {
    throwIfAborted(signal, "inspect managed tree", root);
    const directory = pending.pop()!;
    for await (const entry of Deno.readDir(directory)) {
      throwIfAborted(signal, "inspect managed tree", root);
      const path = join(directory, entry.name);
      const stat = await safeLstat(path, "INSTALL_PATH_INVALID");
      if (stat.isSymlink) {
        throw new InstallStoreError(
          "INSTALL_PATH_INVALID",
          `Managed object contains a symlink: ${path}`,
          { root, path },
        );
      }
      if (stat.isDirectory) pending.push(path);
      else if (!stat.isFile) {
        throw new InstallStoreError(
          "INSTALL_PATH_INVALID",
          `Managed object contains a special filesystem entry: ${path}`,
          { root, path },
        );
      }
    }
  }
}

async function assertPhysicalStoreDirectory(
  root: string,
  path: string,
  stat: Deno.FileInfo,
  label: string,
): Promise<void> {
  if (!stat.isDirectory || stat.isSymlink) {
    throw new InstallStoreError(
      "INSTALL_PATH_INVALID",
      `Managed ${label} is not a real directory: ${path}`,
      { path },
    );
  }
  await assertNoSymlinkPath(root, path, false);
}

async function lstatIfPresent(
  path: string,
  code: InstallStoreErrorCode,
): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.lstat(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return null;
    throw new InstallStoreError(code, `Unable to inspect managed path: ${path}`, { path }, {
      cause,
    });
  }
}

async function safeLstat(path: string, code: InstallStoreErrorCode): Promise<Deno.FileInfo> {
  try {
    return await Deno.lstat(path);
  } catch (cause) {
    throw new InstallStoreError(code, `Unable to inspect managed path: ${path}`, { path }, {
      cause,
    });
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
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
