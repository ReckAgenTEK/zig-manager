import { dirname, isAbsolute, join, relative, resolve } from "@std/path";
import { ArchPackageVerifier, archPackageVersionAtLeast } from "./arch_packages.ts";
import { buildManagedZig, buildStagingRoot, type ManagedBuildContext } from "./build.ts";
import { isZlsBuildRecipe } from "./build_recipe.ts";
import {
  addVerifiedPackageHints,
  applyDiagnosticPolicy,
  createDiagnosticFinding,
  inspectBuildPrerequisites,
  inspectHostDiagnostics,
  inspectSessionDiagnostics,
  resourceDiagnosticFindings,
  sourceDiagnosticWarnings,
  sourceRefDiagnosticFindings,
} from "./doctor.ts";
import {
  BuildPrerequisiteError,
  ZigDependencyInUseError,
  ZigFallbackNotFoundError,
  ZigHostUnsupportedError,
  ZigInstallCorruptError,
  ZigInstallInUseError,
  ZigInstallNotFoundError,
  ZigInvalidArgumentError,
  ZigOperationAbortedError,
  ZigProfileInvalidError,
  ZigProfileNotFoundError,
  ZigPurgeConfirmationError,
  ZigScopeNotPinnedError,
  ZigShellUnsupportedError,
  ZlsCompatibilityNotFoundError,
} from "./errors.ts";
import { GlobalCatalog } from "./global_catalog.ts";
import { DEFAULT_GLOBAL_CONFIG, type GlobalConfig, GlobalConfigStore } from "./global_config.ts";
import { GlobalProfileStore } from "./global_profile.ts";
import {
  computeScopeOperationLockKey,
  GlobalOperationLockManager,
  type GlobalOperationLockOwnerEnumeration,
  type GlobalOperationLockTarget,
} from "./global_operation_lock.ts";
import {
  createBuiltZigInstallIdentity,
  installBuiltZig,
  type InstallBuiltZigInput,
  reuseInstalledZig,
} from "./install_pipeline.ts";
import {
  computeInstallationId,
  type InstalledObject,
  InstallStore,
  type ResolvedSource,
  type RuntimeDependencyInspector,
  type StoredInstallMetadata,
  validateInstallationId,
} from "./install_store.ts";
import { type PlatformPathPlatform, PlatformPaths } from "./platform_paths.ts";
import {
  type CreateToolchainProfileInput,
  isPairedToolchainProfile,
  type ProfileCreateResult,
  type StoredToolchainProfile,
  type StoredToolchainProfileMetadata,
  ToolchainProfileStore,
  type ToolchainProfileV1,
} from "./profile_store.ts";
import { DenoProcessRunner } from "./process_runner.ts";
import {
  type PreparedZigBuildRecipe,
  prepareZigBuildRecipe,
  type PrepareZigBuildRecipeInput,
} from "./recipe_preparation.ts";
import {
  DenoDiagnosticProbe,
  type DiagnosticProbe,
  inspectDiagnosticResources,
} from "./resource_diagnostics.ts";
import { ScopePinStore, type ScopePinWriteResult } from "./scope_pin.ts";
import {
  type ResolvedScopePin,
  resolvePhysicalScopeDirectory,
  ScopeResolver,
} from "./scope_resolver.ts";
import { type ScopeRegistryInspection, ScopeRegistryStore } from "./scope_registry.ts";
import { SessionShimManager } from "./session_shim.ts";
import { type PreparedSource, SourceWorkspace } from "./source_workspace.ts";
import { LinuxRuntimeDependencyInspector } from "./runtime_dependencies.ts";
import { canonicalJson } from "./filesystem.ts";
import {
  buildManagedZls,
  type PreparedZlsBuildRecipe,
  prepareZlsBuildRecipe,
} from "./zls_build.ts";
import {
  DenoZlsLspProtocolVerifier,
  installBuiltZls,
  reuseInstalledZls,
  type ZlsLspProtocolVerifier,
} from "./zls_install_pipeline.ts";
import {
  type PreparedZlsSource,
  type ResolvedZlsSource,
  validateResolvedZlsSource,
  ZlsSourceVersionNotFoundError,
  ZlsSourceWorkspace,
} from "./zls_source_workspace.ts";
import { zlsZigCompatibilityReason } from "./zls_source_version.ts";
import type {
  BuildOptions,
  BuildToolchain,
  CurrentOptions,
  DiagnosticFinding,
  DiagnosticResourceResult,
  DiagnosticSourceResult,
  DiagnosticVerificationResult,
  DoctorOptions,
  GcOptions,
  InstallOptions,
  ProcessResult,
  ProcessRunner,
  PurgeOptions,
  RedactedEffectiveGlobalConfig,
  RepairOptions,
  ResolvedZigManagerConfig,
  RunOptions,
  ScopeOperationOptions,
  SourceRefApi,
  SourceRefDoctorResult,
  SourceSelectionState,
  UninstallOptions,
  UseOptions,
  ZigDanglingScopePin,
  ZigDoctorResult,
  ZigGcResult,
  ZigInstallResult,
  ZigListResult,
  ZigManagedComponentResult,
  ZigManagerDoctorResult,
  ZigManagerHost,
  ZigManagerStatus,
  ZigManagerToolStatus,
  ZigPurgeResult,
  ZigRepairRegistryStatus,
  ZigRepairResult,
  ZigScopeRegistryStatus,
  ZigSemanticVersion,
  ZigShellStatus,
  ZigSyncResult,
  ZigUninstallResult,
  ZigUnuseResult,
  ZigUpdateResult,
  ZigUseResult,
} from "./types.ts";

type ConfigStoreService = Pick<GlobalConfigStore, "load">;
type LockManagerService = Pick<
  GlobalOperationLockManager,
  | "acquireCatalog"
  | "acquireInstall"
  | "acquireGlobal"
  | "acquireScope"
  | "acquireSource"
  | "unlock"
  | "enumerateOwners"
>;
type SourceWorkspaceService = Pick<
  SourceWorkspace,
  "resolve" | "versions" | "doctor" | "prepare" | "prepareExact"
>;
type InstallStoreService = Pick<
  InstallStore,
  | "dataRoot"
  | "stagingRoot"
  | "installationPath"
  | "get"
  | "tryGet"
  | "list"
  | "listMetadata"
  | "createStaging"
  | "publish"
  | "inspect"
  | "quarantine"
  | "remove"
>;
type ProfileStoreService = Pick<
  ToolchainProfileStore,
  | "stagingRoot"
  | "create"
  | "get"
  | "tryGet"
  | "read"
  | "list"
  | "listMetadata"
  | "remove"
>;
type CatalogService = Pick<GlobalCatalog, "read" | "rebuild">;
type ScopeResolverService = Pick<ScopeResolver, "resolve">;
type ScopePinService = Pick<ScopePinStore, "write" | "remove">;
type ScopeRegistryService = Pick<ScopeRegistryStore, "inspect" | "record" | "remove">;
type ShimService = Pick<
  SessionShimManager,
  "install" | "installPersistent" | "removePersistent" | "bashActivation" | "bashDeactivation"
>;
type GlobalProfileService = Pick<GlobalProfileStore, "read" | "write" | "remove">;
type ZlsSourceWorkspaceService = Pick<
  ZlsSourceWorkspace,
  "prepare" | "prepareStable" | "prepareExact"
>;

const OPERATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ZigManagerProgress = (message: string) => void | Promise<void>;
export type ZigManagerHostSupport = (
  host: ZigManagerHost,
) => void | Promise<void>;

export interface ZigManagerServices {
  readonly configStore?: ConfigStoreService;
  readonly locks?: LockManagerService;
  readonly sourceWorkspace?: SourceWorkspaceService;
  readonly installs?: InstallStoreService;
  readonly profiles?: ProfileStoreService;
  readonly catalog?: CatalogService;
  readonly scopeResolver?: ScopeResolverService;
  readonly pins?: ScopePinService;
  readonly scopeRegistry?: ScopeRegistryService;
  readonly shims?: ShimService;
  readonly globalProfile?: GlobalProfileService;
  readonly zlsSourceWorkspace?: ZlsSourceWorkspaceService;
  readonly hostSupport?: ZigManagerHostSupport;
  readonly build?: (context: ManagedBuildContext) => ReturnType<typeof buildManagedZig>;
  readonly installBuilt?: (
    input: InstallBuiltZigInput,
  ) => ReturnType<typeof installBuiltZig>;
  readonly prepareRecipe?: (
    input: PrepareZigBuildRecipeInput,
  ) => Promise<PreparedZigBuildRecipe>;
  readonly runtimeDependencyInspector?: RuntimeDependencyInspector;
  readonly prepareZlsRecipe?: typeof prepareZlsBuildRecipe;
  readonly buildZls?: typeof buildManagedZls;
  readonly installBuiltZls?: typeof installBuiltZls;
  readonly reuseInstalledZls?: typeof reuseInstalledZls;
  readonly zlsProtocolVerifier?: ZlsLspProtocolVerifier;
}

export interface ZigManagerOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
  readonly platform?: PlatformPathPlatform;
  readonly architecture?: string;
  readonly hostTarget?: string;
  readonly cwd?: string;
  readonly sourceRef?: SourceRefApi;
  readonly runner?: ProcessRunner;
  readonly diagnosticProbe?: DiagnosticProbe;
  readonly progress?: ZigManagerProgress;
  readonly services?: ZigManagerServices;
}

interface InstalledZigSelection {
  readonly installed: InstalledObject;
  readonly source: ResolvedSource;
  readonly reused: boolean;
  readonly operationId: string;
}

interface InstalledZlsSelection {
  readonly installed: InstalledObject;
  readonly source: ResolvedZlsSource;
  readonly reused: boolean;
}

interface InstalledSelection {
  readonly zig: InstalledZigSelection;
  readonly zls: InstalledZlsSelection;
  readonly operationId: string;
}

interface InstallPreparedPolicy {
  readonly expectedInstallationId?: string;
  readonly quarantineCorrupt?: boolean;
}

interface ProfileReference {
  readonly selection: "local" | "global";
  readonly lookupPath: string;
  readonly scopeRoot: string | null;
  readonly pinPath: string;
  readonly profileId: string;
}

/** Public facade for immutable paired toolchains selected locally or by a manager-wide default. */
export class ZigManager {
  readonly paths: PlatformPaths;
  readonly host: ZigManagerHost;

  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #cwd: string;
  readonly #platform: "linux" | "darwin";
  readonly #sourceRef: SourceRefApi | undefined;
  readonly #runner: ProcessRunner;
  readonly #diagnosticProbe: DiagnosticProbe;
  readonly #progress: ZigManagerProgress;
  readonly #configStore: ConfigStoreService;
  readonly #locks: LockManagerService;
  readonly #sourceOverride: SourceWorkspaceService | undefined;
  readonly #zlsSourceOverride: ZlsSourceWorkspaceService | undefined;
  readonly #installs: InstallStoreService;
  readonly #profiles: ProfileStoreService;
  readonly #catalog: CatalogService;
  readonly #scopeResolver: ScopeResolverService;
  readonly #pins: ScopePinService;
  readonly #scopeRegistry: ScopeRegistryService;
  readonly #shims: ShimService;
  readonly #globalProfile: GlobalProfileService;
  readonly #hostSupport: ZigManagerHostSupport;
  readonly #build: NonNullable<ZigManagerServices["build"]>;
  readonly #installBuilt: NonNullable<ZigManagerServices["installBuilt"]>;
  readonly #prepareRecipe: NonNullable<ZigManagerServices["prepareRecipe"]>;
  readonly #runtimeDependencyInspector: RuntimeDependencyInspector;
  readonly #prepareZlsRecipe: NonNullable<ZigManagerServices["prepareZlsRecipe"]>;
  readonly #buildZls: NonNullable<ZigManagerServices["buildZls"]>;
  readonly #installBuiltZls: NonNullable<ZigManagerServices["installBuiltZls"]>;
  readonly #reuseInstalledZls: NonNullable<ZigManagerServices["reuseInstalledZls"]>;
  readonly #zlsProtocolVerifier: ZlsLspProtocolVerifier;

  #configPromise: Promise<GlobalConfig> | null = null;
  #sourcePromise: Promise<SourceWorkspaceService> | null = null;
  #zlsSourcePromise: Promise<ZlsSourceWorkspaceService> | null = null;
  #hostPromise: Promise<void> | null = null;

  constructor(options: ZigManagerOptions = {}) {
    this.#env = Object.freeze({ ...(options.env ?? readManagerEnvironment()) });
    this.#cwd = normalizeAbsolute(options.cwd ?? Deno.cwd(), "working directory");
    const platform = options.platform ?? runtimePlatform();
    if (platform === "windows") {
      throw new ZigHostUnsupportedError("Windows runtime support is deferred", { platform });
    }
    this.#platform = platform;
    const home = options.home ?? this.#env.HOME;
    if (home === undefined || home.length === 0) {
      throw new ZigInvalidArgumentError("A home directory is required to resolve manager data");
    }
    this.paths = new PlatformPaths({ env: this.#env, home, platform });
    this.host = Object.freeze({
      os: platform,
      architecture: options.architecture ?? Deno.build.arch,
      abi: inferAbi(options.hostTarget ?? Deno.build.target),
      denoTarget: options.hostTarget ?? Deno.build.target,
    });

    const services = options.services ?? {};
    this.#runner = options.runner ?? new DenoProcessRunner();
    this.#diagnosticProbe = options.diagnosticProbe ?? new DenoDiagnosticProbe();
    this.#progress = options.progress ?? (() => {});
    this.#sourceRef = options.sourceRef;
    this.#configStore = services.configStore ?? new GlobalConfigStore({
      configPath: this.paths.configFile,
      env: this.#env,
    });
    this.#locks = services.locks ?? new GlobalOperationLockManager({
      stateRoot: this.paths.stateDir,
    });
    this.#sourceOverride = services.sourceWorkspace;
    this.#zlsSourceOverride = services.zlsSourceWorkspace;
    this.#installs = services.installs ?? new InstallStore({ dataRoot: this.paths.dataDir });
    this.#profiles = services.profiles ?? new ToolchainProfileStore({
      dataRoot: this.paths.dataDir,
      installs: this.#installs,
    });
    this.#catalog = services.catalog ?? new GlobalCatalog({
      dataRoot: this.paths.dataDir,
      stateRoot: this.paths.stateDir,
      installs: this.#installs,
      profiles: this.#profiles,
    });
    this.#scopeResolver = services.scopeResolver ?? new ScopeResolver();
    this.#pins = services.pins ?? new ScopePinStore();
    this.#scopeRegistry = services.scopeRegistry ?? new ScopeRegistryStore(this.paths.scopesFile);
    this.#shims = services.shims ?? new SessionShimManager({
      dataDir: this.paths.dataDir,
      globalBinDir: this.paths.globalBinDir,
      globalProfileFile: this.paths.globalProfileFile,
    });
    this.#globalProfile = services.globalProfile ?? new GlobalProfileStore(
      this.paths.globalProfileFile,
    );
    this.#hostSupport = services.hostSupport ?? assertArchLinuxX86_64;
    this.#build = services.build ?? buildManagedZig;
    this.#installBuilt = services.installBuilt ?? installBuiltZig;
    this.#prepareRecipe = services.prepareRecipe ?? prepareZigBuildRecipe;
    this.#runtimeDependencyInspector = services.runtimeDependencyInspector ??
      new LinuxRuntimeDependencyInspector({ runner: this.#runner });
    this.#prepareZlsRecipe = services.prepareZlsRecipe ?? prepareZlsBuildRecipe;
    this.#buildZls = services.buildZls ?? buildManagedZls;
    this.#installBuiltZls = services.installBuiltZls ?? installBuiltZls;
    this.#reuseInstalledZls = services.reuseInstalledZls ?? reuseInstalledZls;
    this.#zlsProtocolVerifier = services.zlsProtocolVerifier ??
      (isZlsProtocolVerifier(this.#runner) ? this.#runner : new DenoZlsLspProtocolVerifier());
  }

  async versions(options: { readonly signal?: AbortSignal } = {}): Promise<ZigSemanticVersion[]> {
    throwIfAborted(options.signal, "list remote Zig versions");
    await this.#assertHost();
    const versions = [...await (await this.#source()).versions(options.signal)];
    throwIfAborted(options.signal, "list remote Zig versions");
    return versions;
  }

  async list(
    options: { readonly remote?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<ZigListResult> {
    throwIfAborted(options.signal, "list managed Zig objects");
    await this.#assertHost();
    const [installed, profiles, remote] = await Promise.all([
      this.#installs.list(),
      this.#profiles.list(),
      options.remote ? this.versions({ signal: options.signal }) : Promise.resolve(null),
    ]);
    throwIfAborted(options.signal, "list managed Zig objects");
    const byInstallationId = new Map(
      installed.map((item) => [item.manifest.installationId, item] as const),
    );
    return {
      schemaVersion: 2,
      installations: installed.map((item) => ({
        component: item.manifest.component,
        installationId: item.manifest.installationId,
        version: item.manifest.source.version,
        commit: item.manifest.source.commit,
        executable: item.executablePath,
        createdAt: item.manifest.createdAt,
      })),
      profiles: profiles.map((item) => {
        const zig = byInstallationId.get(item.profile.components.zig)!;
        const zls = item.profile.components.zls === null
          ? null
          : byInstallationId.get(item.profile.components.zls)!;
        return {
          profileId: item.profile.profileId,
          profileSchemaVersion: item.profile.schemaVersion,
          selector: item.profile.source.requestedSelector,
          installationId: item.profile.components.zig,
          version: item.profile.source.version,
          commit: item.profile.source.commit,
          createdAt: item.profile.createdAt,
          zig: componentResult(zig, item.profile.source, true),
          zls: zls === null ? null : componentResult(zls, zls.manifest.source, true),
        };
      }),
      remote,
    };
  }

  async install(selector: string, options: InstallOptions = {}): Promise<ZigInstallResult> {
    throwIfAborted(options.signal, `install Zig ${selector}`);
    await this.#assertHost();
    const selection = await this.#installSelector(selector, options);
    throwIfAborted(options.signal, `install Zig ${selector}`);
    const profile = await this.#publishPairProfile(
      selection,
      `install ${selector}`,
      selection.operationId,
      options.signal,
    );
    return installResult(selection, profile.profile.profileId);
  }

  async uninstall(
    installationIdValue: string,
    options: UninstallOptions = {},
  ): Promise<ZigUninstallResult> {
    throwIfAborted(options.signal, `uninstall ${installationIdValue}`);
    await this.#assertHost();
    const installationId = validateInstallationId(installationIdValue);
    if (await this.#findInstallMetadata(installationId) === null) {
      throw new ZigInstallNotFoundError(installationId);
    }

    const installLease = await this.#locks.acquireInstall(installationId, {
      operation: `uninstall ${installationId}`,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      wait: {},
    });
    try {
      const operationId = installLease.owner.operationId;
      const catalogLease = await this.#locks.acquireCatalog({
        operation: `uninstall ${installationId}`,
        operationId,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        wait: {},
      });
      try {
        throwIfAborted(options.signal, `uninstall ${installationId}`);
        const target = await this.#findInstallMetadata(installationId);
        if (target === null) throw new ZigInstallNotFoundError(installationId);

        const profiles = await this.#profiles.listMetadata();
        const profileIds = profiles
          .filter(({ profile }) =>
            profile.components.zig === installationId || profile.components.zls === installationId
          )
          .map(({ profile }) => profile.profileId)
          .sort();
        if (profileIds.length > 0) {
          throw new ZigInstallInUseError(
            target.manifest.component,
            installationId,
            profileIds,
          );
        }

        if (target.manifest.component === "zig") {
          const dependents = (await this.#installs.listMetadata())
            .filter(({ manifest }) =>
              manifest.component === "zls" &&
              manifest.dependencies.some((dependency) =>
                dependency.installationId === installationId
              )
            )
            .map(({ manifest }) => manifest.installationId)
            .sort();
          if (dependents.length > 0) {
            throw new ZigDependencyInUseError(installationId, dependents);
          }
        }

        throwIfAborted(options.signal, `uninstall ${installationId}`);
        const removed = await this.#installs.remove(
          target.manifest.component,
          installationId,
          options.signal,
        );
        await this.#catalog.rebuild({ operationId, signal: options.signal });
        return {
          schemaVersion: 1,
          component: removed.manifest.component,
          installationId,
          version: removed.manifest.source.version,
          root: removed.root,
          removed: true,
        };
      } finally {
        await catalogLease.release();
      }
    } finally {
      await installLease.release();
    }
  }

  async use(selector: string, options: UseOptions = {}): Promise<ZigUseResult> {
    throwIfAborted(options.signal, `use Zig ${selector}`);
    await this.#assertHost();
    this.#assertScopeOptions(options);
    if (options.global === true) {
      const lease = await this.#acquireGlobal(`use ${selector}`, selector, options.signal);
      try {
        const operationId = lease.owner.operationId;
        const selection = await this.#installSelector(
          selector,
          options,
          this.paths.stateDir,
          operationId,
        );
        throwIfAborted(options.signal, `use Zig ${selector} globally`);
        const { profile, pointerPath } = await this.#publishGlobalSelection(
          selection,
          `use ${selector}`,
          operationId,
          options.signal,
        );
        return useResult(
          selection,
          profile,
          { scopeRoot: null, pinPath: pointerPath },
          this.#activationRequired(),
          "global",
        );
      } finally {
        await lease.release();
      }
    }
    const scopeRoot = await this.#scopeRoot(options.path);
    const lease = await this.#acquireScope(scopeRoot, `use ${selector}`, selector, options.signal);
    try {
      const operationId = lease.owner.operationId;
      const selection = await this.#installSelector(
        selector,
        options,
        scopeRoot,
        operationId,
      );
      throwIfAborted(options.signal, `use Zig ${selector}`);
      const { profile, pin } = await this.#publishScopeSelection(
        scopeRoot,
        selection,
        `use ${selector}`,
        operationId,
        options.signal,
      );
      return useResult(
        selection,
        profile,
        pin,
        this.#activationRequired(),
        "local",
      );
    } finally {
      await lease.release();
    }
  }

  async useInstalled(
    installationIdValue: string,
    options: ScopeOperationOptions = {},
  ): Promise<ZigUseResult> {
    throwIfAborted(options.signal, `use installed Zig ${installationIdValue}`);
    await this.#assertHost();
    this.#assertScopeOptions(options);
    const installationId = validateInstallationId(installationIdValue);
    const global = options.global === true;
    const scopeRoot = global ? null : await this.#scopeRoot(options.path);
    const lease = global
      ? await this.#acquireGlobal(
        `use installed ${installationId}`,
        installationId,
        options.signal,
      )
      : await this.#acquireScope(
        scopeRoot!,
        `use installed ${installationId}`,
        installationId,
        options.signal,
      );
    try {
      const operationId = lease.owner.operationId;
      const paired = await this.#findPairedProfile(installationId);
      if (paired !== null) {
        await this.#fullyVerifyProfile(paired, options.signal, operationId);
        const published = global
          ? await this.#publishExistingGlobalProfile(
            paired.profile.profileId,
            `use installed ${installationId}`,
            operationId,
            options.signal,
          )
          : await this.#publishExistingScopePin(
            scopeRoot!,
            paired.profile.profileId,
            `use installed ${installationId}`,
            operationId,
            options.signal,
          );
        return useResultFromStored(
          paired,
          {
            scopeRoot,
            pinPath: published.pinPath,
          },
          this.#activationRequired(),
          global ? "global" : "local",
        );
      }

      const installed = await this.#getInstall(installationId);
      this.#assertInstallHost(installed);
      await this.#fullyVerifyInstall(
        installed,
        installed.manifest.source,
        options.signal,
        operationId,
      );
      const selection: InstalledZigSelection = {
        installed,
        source: installed.manifest.source,
        reused: true,
        operationId,
      };
      const { profile, pinPath } = global
        ? await this.#publishLegacyGlobalSelection(
          selection,
          `use installed ${installationId}`,
          operationId,
          options.signal,
        )
        : await this.#publishLegacyScopeSelection(
          scopeRoot!,
          selection,
          `use installed ${installationId}`,
          operationId,
          options.signal,
        );
      return useResultFromStored(
        profile,
        { scopeRoot, pinPath },
        this.#activationRequired(),
        global ? "global" : "local",
      );
    } finally {
      await lease.release();
    }
  }

  async unuse(options: ScopeOperationOptions = {}): Promise<ZigUnuseResult> {
    throwIfAborted(options.signal, "remove exact scope pin");
    await this.#assertHost();
    this.#assertScopeOptions(options);
    if (options.global === true) {
      const lease = await this.#acquireGlobal(
        "remove global profile pointer",
        undefined,
        options.signal,
      );
      try {
        const pointer = await this.#globalProfile.read();
        if (pointer === null) throw new ZigScopeNotPinnedError(this.paths.globalProfileFile);
        throwIfAborted(options.signal, "remove global profile pointer");
        if (!await this.#globalProfile.remove()) {
          throw new ZigScopeNotPinnedError(this.paths.globalProfileFile);
        }
        return {
          schemaVersion: 2,
          selection: "global",
          scopeRoot: null,
          pinPath: this.paths.globalProfileFile,
          removed: true,
        };
      } finally {
        await lease.release();
      }
    }
    const scopeRoot = await this.#scopeRoot(options.path);
    const lease = await this.#acquireScope(
      scopeRoot,
      "remove exact scope pin",
      undefined,
      options.signal,
    );
    try {
      const operationId = lease.owner.operationId;
      const catalogLease = await this.#locks.acquireCatalog({
        operation: "remove exact scope pin",
        operationId,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        wait: {},
      });
      try {
        const effective = await this.#scopeResolver.resolve(scopeRoot);
        if (effective === null || effective.scopeRoot !== scopeRoot) {
          throw new ZigScopeNotPinnedError(scopeRoot, effective?.scopeRoot ?? null);
        }
        throwIfAborted(options.signal, "remove exact scope pin");
        if (!await this.#pins.remove(scopeRoot, { operationId, signal: options.signal })) {
          throw new ZigScopeNotPinnedError(scopeRoot);
        }
        await this.#removeScopeRegistryAdvisory(scopeRoot);
        return {
          schemaVersion: 2,
          selection: "local",
          scopeRoot,
          pinPath: effective.pinPath,
          removed: true,
        };
      } finally {
        await catalogLease.release();
      }
    } finally {
      await lease.release();
    }
  }

  async sync(options: UseOptions = {}): Promise<ZigSyncResult> {
    throwIfAborted(options.signal, "sync exact scope profile");
    await this.#assertHost();
    this.#assertScopeOptions(options);
    const lookupPath = await this.#scopeRoot(options.path);
    const global = options.global === true;
    const initial = global ? null : referenceFromPin(await this.#requirePin(lookupPath));
    const lease = global
      ? await this.#acquireGlobal("sync exact global profile", undefined, options.signal)
      : await this.#acquireScope(
        initial!.scopeRoot!,
        "sync exact scope profile",
        initial!.profileId,
        options.signal,
      );
    try {
      const operationId = lease.owner.operationId;
      const reference = global
        ? await this.#requireGlobalReference(lookupPath)
        : await this.#requireSameReference(initial!);
      const profile = await this.#readProfile(
        reference.profileId,
        reference.scopeRoot ?? reference.pinPath,
      );
      const profileSnapshot = canonicalJson(profile);
      if (!isPairedToolchainProfile(profile) && profile.components.zls !== null) {
        throw new ZlsCompatibilityNotFoundError(profile.profileId);
      }
      const zig = await this.#syncExactZig(
        profile.source,
        profile.components.zig,
        options,
        profileOperationScope(reference),
        operationId,
      );
      let zls: { readonly selection: InstalledZlsSelection; readonly rebuilt: boolean } | null =
        null;
      if (isPairedToolchainProfile(profile)) {
        zls = await this.#syncExactZls(
          profile.zlsSource,
          profile.components.zls,
          zig.selection.installed,
          options,
          profileOperationScope(reference),
          operationId,
        );
      }

      await this.#requireSameReference(reference);
      const unchanged = await this.#readProfile(
        profile.profileId,
        reference.scopeRoot ?? reference.pinPath,
      );
      if (canonicalJson(unchanged) !== profileSnapshot) {
        throw new ZigProfileInvalidError(
          profile.profileId,
          "the immutable profile changed while sync verified its exact installations",
        );
      }
      const stored = await this.#getProfile(
        profile.profileId,
        reference.scopeRoot ?? reference.pinPath,
      );
      throwIfAborted(options.signal, "sync exact scope profile");
      await this.#rebuildCatalog(
        `sync profile ${profile.profileId}`,
        operationId,
        options.signal,
      );
      return syncResult(
        stored,
        reference,
        zig.rebuilt || zls?.rebuilt === true,
        zig.rebuilt,
        zls?.rebuilt ?? false,
      );
    } finally {
      await lease.release();
    }
  }

  async update(options: UseOptions = {}): Promise<ZigUpdateResult> {
    throwIfAborted(options.signal, "update moving scope selector");
    await this.#assertHost();
    this.#assertScopeOptions(options);
    const lookupPath = await this.#scopeRoot(options.path);
    const global = options.global === true;
    const initial = global ? null : referenceFromPin(await this.#requirePin(lookupPath));
    const lease = global
      ? await this.#acquireGlobal("update moving global selector", undefined, options.signal)
      : await this.#acquireScope(
        initial!.scopeRoot!,
        "update moving scope selector",
        initial!.profileId,
        options.signal,
      );
    try {
      const operationId = lease.owner.operationId;
      const reference = global
        ? await this.#requireGlobalReference(lookupPath)
        : await this.#requireSameReference(initial!);
      const currentProfile = await this.#readProfile(
        reference.profileId,
        reference.scopeRoot ?? reference.pinPath,
      );
      const selector = currentProfile.source.requestedSelector;
      if (!isMovingSelector(selector)) {
        const current = await this.#getProfile(
          reference.profileId,
          reference.scopeRoot ?? reference.pinPath,
        );
        await this.#fullyVerifyProfile(current, options.signal, operationId);
        const published = global
          ? await this.#publishExistingGlobalProfile(
            current.profile.profileId,
            `update ${selector}`,
            operationId,
            options.signal,
          )
          : await this.#publishExistingScopePin(
            reference.scopeRoot!,
            current.profile.profileId,
            `update ${selector}`,
            operationId,
            options.signal,
          );
        return {
          ...useResultFromStored(
            current,
            { scopeRoot: reference.scopeRoot, pinPath: published.pinPath },
            this.#activationRequired(),
            reference.selection,
          ),
          previousProfileId: current.profile.profileId,
          changed: false,
          immutable: true,
        };
      }

      const selection = await this.#installSelector(
        selector,
        options,
        profileOperationScope(reference),
        operationId,
      );
      const published = global
        ? await this.#publishGlobalSelection(
          selection,
          `update ${selector}`,
          operationId,
          options.signal,
        )
        : await this.#publishScopeSelection(
          reference.scopeRoot!,
          selection,
          `update ${selector}`,
          operationId,
          options.signal,
        );
      const pinPath = "pointerPath" in published ? published.pointerPath : published.pin.pinPath;
      const changed = published.profile.profile.profileId !== currentProfile.profileId;
      return {
        ...useResult(
          selection,
          published.profile,
          { scopeRoot: reference.scopeRoot, pinPath },
          this.#activationRequired(),
          reference.selection,
        ),
        previousProfileId: currentProfile.profileId,
        changed,
        immutable: false,
      };
    } finally {
      await lease.release();
    }
  }

  async current(options: CurrentOptions = {}): Promise<ZigManagerStatus> {
    throwIfAborted(options.signal, "resolve current Zig");
    await this.#assertHost();
    this.#assertScopeOptions(options);
    const lookupPath = await this.#scopeRoot(options.path);
    const reference = await this.#resolveReference(lookupPath, options.global === true);
    if (reference === null) {
      const [zigExecutable, zlsExecutable] = await Promise.all([
        this.#fallbackExecutable("zig"),
        this.#fallbackExecutable("zls"),
      ]);
      return {
        schemaVersion: 2,
        lookupPath,
        mode: "fallback",
        selection: "fallback",
        scopeRoot: null,
        pinPath: null,
        profileId: null,
        installationId: null,
        selector: null,
        version: null,
        commit: null,
        executable: zigExecutable,
        zig: fallbackToolStatus("zig", zigExecutable),
        zls: fallbackToolStatus("zls", zlsExecutable),
        update: { checked: false, moving: false, available: null, resolvedCommit: null },
      };
    }
    const stored = await this.#getProfile(
      reference.profileId,
      reference.scopeRoot ?? reference.pinPath,
    );
    const moving = isMovingSelector(stored.profile.source.requestedSelector);
    let resolvedCommit: string | null = null;
    if (options.check && moving) {
      resolvedCommit = (await (await this.#source()).resolve(
        stored.profile.source.requestedSelector,
        { signal: options.signal },
      )).commit;
      throwIfAborted(options.signal, "check current Zig update");
    }
    return {
      schemaVersion: 2,
      lookupPath,
      mode: "managed",
      selection: reference.selection,
      scopeRoot: reference.scopeRoot,
      pinPath: reference.pinPath,
      profileId: stored.profile.profileId,
      installationId: stored.profile.components.zig,
      selector: stored.profile.source.requestedSelector,
      version: stored.profile.source.version,
      commit: stored.profile.source.commit,
      executable: stored.zigPath,
      zig: toolStatus(
        "zig",
        stored.profile.components.zig,
        stored.profile.source,
        stored.zigPath,
      ),
      zls: await this.#profileZlsStatus(stored),
      update: {
        checked: options.check === true,
        moving,
        available: options.check ? moving && resolvedCommit !== stored.profile.source.commit : null,
        resolvedCommit,
      },
    };
  }

  status(options: CurrentOptions = {}): Promise<ZigManagerStatus> {
    return this.current(options);
  }

  async which(
    tool: "zig" | "zls" = "zig",
    options: ScopeOperationOptions = {},
  ): Promise<string> {
    throwIfAborted(options.signal, `resolve ${tool}`);
    await this.#assertHost();
    if (tool !== "zig" && tool !== "zls") {
      throw new ZigInvalidArgumentError(`Unknown managed tool '${tool}'`);
    }
    this.#assertScopeOptions(options);
    const lookupPath = await this.#scopeRoot(options.path);
    const reference = await this.#resolveReference(lookupPath, options.global === true);
    if (reference === null) {
      const fallback = await this.#fallbackExecutable(tool);
      if (fallback === null) throw new ZigFallbackNotFoundError(tool);
      return fallback;
    }
    const stored = await this.#getProfile(
      reference.profileId,
      reference.scopeRoot ?? reference.pinPath,
    );
    if (tool === "zig") return stored.zigPath;
    if (stored.zlsPath === null) throw new ZlsCompatibilityNotFoundError(stored.profile.profileId);
    return stored.zlsPath;
  }

  async run(args: readonly string[], options: RunOptions = {}): Promise<ProcessResult> {
    throwIfAborted(options.signal, "run managed Zig");
    await this.#assertHost();
    this.#assertScopeOptions(options);
    if (options.selector !== undefined && (options.path !== undefined || options.global === true)) {
      throw new ZigInvalidArgumentError(
        "run cannot combine an explicit selector or installation ID with --path or --global",
      );
    }
    let installed: InstalledObject;
    if (options.selector === undefined) {
      const lookupPath = await this.#scopeRoot(options.path ?? options.cwd);
      const reference = await this.#resolveReference(lookupPath, options.global === true);
      if (reference === null) {
        const fallback = await this.#fallbackExecutable("zig");
        if (fallback === null) throw new ZigFallbackNotFoundError("zig");
        return await this.#runner.run({
          executable: fallback,
          args,
          cwd: options.cwd ?? this.#cwd,
          env: options.env,
          stdin: options.stdin ?? "inherit",
          signal: options.signal,
          onStdout: options.onStdout,
          onStderr: options.onStderr,
        });
      }
      installed = (await this.#getInstallFromProfile(reference, options.signal)).installed;
    } else if (/^[0-9a-f]{64}$/.test(options.selector)) {
      installed = await this.#getInstall(options.selector);
      this.#assertInstallHost(installed);
      await this.#fullyVerifyInstall(installed, installed.manifest.source, options.signal);
    } else {
      const selection = await this.#installSelector(options.selector, options);
      throwIfAborted(options.signal, "run managed Zig");
      await this.#rebuildCatalog(
        `run ${options.selector}`,
        selection.operationId,
        options.signal,
      );
      installed = selection.zig.installed;
    }
    return await this.#runner.run({
      executable: installed.executablePath,
      args,
      cwd: options.cwd ?? this.#cwd,
      env: options.env,
      stdin: options.stdin ?? "inherit",
      signal: options.signal,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
    });
  }

  async doctor(
    selector?: string,
    options: DoctorOptions = {},
  ): Promise<ZigManagerDoctorResult> {
    throwIfAborted(options.signal, "inspect Zig manager health");
    this.#assertScopeOptions(options);
    if (selector !== undefined && options.host) {
      throw new ZigInvalidArgumentError("doctor does not accept a selector with --host");
    }
    if (options.host && options.verify) {
      throw new ZigInvalidArgumentError("doctor does not accept --host with --verify");
    }
    if (selector !== undefined && options.verify) {
      throw new ZigInvalidArgumentError("doctor does not accept a selector with --verify");
    }
    if ((selector !== undefined || options.host) && options.global) {
      throw new ZigInvalidArgumentError("doctor accepts --global only when inspecting a profile");
    }

    const strict = options.strict === true;
    const hostInspection = await inspectHostDiagnostics(this.host, this.#diagnosticProbe);
    throwIfAborted(options.signal, "inspect Zig manager health");
    const baseFindings: DiagnosticFinding[] = [...hostInspection.findings];

    let lookupPath: string | null = null;
    let reference: ProfileReference | null = null;
    try {
      lookupPath = await this.#scopeRoot(options.path);
      if (selector === undefined && !options.host) {
        reference = await this.#resolveReference(lookupPath, options.global === true);
      }
    } catch (cause) {
      throwIfAborted(options.signal, "inspect Zig manager health");
      rethrowAbort(cause);
      baseFindings.push(createDiagnosticFinding({
        severity: "error",
        code: "ZIG_SCOPE_INVALID",
        component: "directory scope",
        summary: errorMessage(cause),
        required: "a physical, readable directory scope",
        found: options.path ?? this.#cwd,
        checkedPaths: [options.path ?? this.#cwd],
        remediation: "Repair the selected scope path or its nearest pin before retrying doctor.",
        details: { code: errorCode(cause) },
      }));
    }
    if (options.verify && reference === null) {
      throw new ZigInvalidArgumentError("doctor --verify requires an effective managed profile");
    }

    let config: GlobalConfig | null = null;
    try {
      config = await this.#config();
    } catch (cause) {
      throwIfAborted(options.signal, "inspect Zig manager health");
      rethrowAbort(cause);
      baseFindings.push(createDiagnosticFinding({
        severity: "error",
        code: "ZIG_CONFIG_INVALID",
        component: "global configuration",
        summary: errorMessage(cause),
        required: "a valid optional global configuration",
        found: null,
        checkedPaths: [this.paths.configFile],
        remediation: "Repair or remove the invalid global configuration file.",
        details: { code: errorCode(cause) },
      }));
    }

    const scopePath = reference?.scopeRoot ??
      (selector === undefined ? undefined : lookupPath ?? undefined);
    const resources = await inspectDiagnosticResources(
      this.#diagnosticProbe,
      {
        cacheBuild: this.paths.buildsDir,
        dataStaging: this.#installs.stagingRoot,
        ...(scopePath === undefined ? {} : { scope: scopePath }),
        cacheRoot: this.paths.cacheDir,
      },
      config?.warnings.cacheBytes ?? DEFAULT_GLOBAL_CONFIG.warnings.cacheBytes,
    );
    throwIfAborted(options.signal, "inspect Zig manager health");

    let fallbackPath: string | null = null;
    try {
      fallbackPath = await this.#fallbackExecutable("zig");
    } catch (cause) {
      throwIfAborted(options.signal, "inspect Zig manager health");
      rethrowAbort(cause);
    }
    const sessionInspection = await inspectSessionDiagnostics({
      env: this.#env,
      expectedShimDirectory: this.paths.shimsDir,
      persistentShimDirectory: this.paths.globalBinDir,
      fallbackPath,
      pinRelevant: selector !== undefined || reference !== null,
      runner: this.#runner,
      signal: options.signal,
    });
    throwIfAborted(options.signal, "inspect Zig manager health");
    baseFindings.push(...sessionInspection.findings);

    let sourceService: SourceWorkspaceService | null = null;
    let sourceRef: SourceRefDoctorResult | null = null;
    let sourceRefFailure: unknown;
    if (config !== null) {
      try {
        sourceService = await this.#source();
        sourceRef = await sourceService.doctor(options.signal);
      } catch (cause) {
        throwIfAborted(options.signal, "inspect Zig manager health");
        rethrowAbort(cause);
        sourceRefFailure = cause;
      }
    }

    const generalFindings = [...resourceDiagnosticFindings(resources)];
    if (config !== null) {
      const sourceFindings = sourceRefDiagnosticFindings(sourceRef, sourceRefFailure);
      if (hostInspection.host.supported && sourceFindings.length > 0) {
        const verifier = new ArchPackageVerifier(this.#runner, options.signal);
        for (const finding of sourceFindings) {
          generalFindings.push(
            finding.code === "ZIG_GIT_UNAVAILABLE" ||
              finding.code === "ZIG_GIT_INCOMPATIBLE"
              ? await addVerifiedPackageHints(
                finding,
                ["git"],
                verifier,
                (name, version) =>
                  name === "git" && sourceRef !== null &&
                  archPackageVersionAtLeast(version, sourceRef.git.minimumVersion),
              )
              : finding,
          );
        }
      } else {
        generalFindings.push(...sourceFindings);
      }
    }

    const effectiveConfig = config === null ? null : redactedEffectiveConfig(config);
    const mode = options.host || selector === undefined && reference === null
      ? "host"
      : selector === undefined
      ? "pin"
      : "source";
    const finish = (input: {
      readonly selected: string | null;
      readonly source: DiagnosticSourceResult | null;
      readonly adapter: string | null;
      readonly toolchain: BuildToolchain | null;
      readonly verification: DiagnosticVerificationResult | null;
      readonly findings: readonly DiagnosticFinding[];
    }): ZigManagerDoctorResult => {
      throwIfAborted(options.signal, "inspect Zig manager health");
      const findings = [...input.findings];
      return {
        schemaVersion: 2,
        mode,
        strict,
        ...applyDiagnosticPolicy(findings, strict),
        host: hostInspection.host,
        selector: input.selected,
        source: input.source,
        adapter: input.adapter,
        toolchain: input.toolchain,
        resources,
        session: sessionInspection.session,
        sourceRef,
        effectiveConfig,
        verification: input.verification,
        findings,
      };
    };

    if (mode === "host" || config === null || !hostInspection.host.supported) {
      return finish({
        selected: mode === "source" ? selector ?? null : null,
        source: null,
        adapter: null,
        toolchain: null,
        verification: null,
        findings: [...baseFindings, ...generalFindings],
      });
    }

    let exact: ResolvedSource | null = null;
    let selected = selector ?? null;
    if (reference !== null) {
      try {
        const profile = await this.#readProfile(
          reference.profileId,
          reference.scopeRoot ?? reference.pinPath,
        );
        exact = profile.source;
        selected = profile.source.requestedSelector;
      } catch (cause) {
        rethrowAbort(cause);
        const unavailableVerification: DiagnosticVerificationResult | null = options.verify
          ? {
            requested: true,
            level: "full-install",
            ok: false,
            compilesAndRuns: false,
            summary:
              "Full install verification could not start because the pinned profile is unavailable.",
            details: { cause: errorMessage(cause) },
          }
          : null;
        return finish({
          selected,
          source: null,
          adapter: null,
          toolchain: null,
          verification: unavailableVerification,
          findings: [
            ...baseFindings,
            ...generalFindings,
            doctorFailureFinding(cause, selected),
          ],
        });
      }
    }

    let verification: DiagnosticVerificationResult | null = null;
    const verificationFindings: DiagnosticFinding[] = [];
    if (options.verify && reference !== null && exact !== null) {
      try {
        const stored = await this.#getProfile(
          reference.profileId,
          reference.scopeRoot ?? reference.pinPath,
        );
        await this.#fullyVerifyProfile(stored, options.signal);
        verification = {
          requested: true,
          level: "full-install",
          ok: true,
          compilesAndRuns: true,
          summary:
            "Full paired-profile verification passed, including Zig compile/run and the ZLS LSP protocol.",
          details: {
            profileId: stored.profile.profileId,
            zigInstallationId: stored.profile.components.zig,
            zlsInstallationId: stored.profile.components.zls,
          },
        };
      } catch (cause) {
        rethrowAbort(cause);
        verification = {
          requested: true,
          level: "full-install",
          ok: false,
          compilesAndRuns: false,
          summary: "Full paired-profile verification failed.",
          details: { cause: errorMessage(cause) },
        };
        verificationFindings.push(createDiagnosticFinding({
          severity: "error",
          code: "ZIG_BINARY_VERIFICATION_FAILED",
          component: "managed Zig/ZLS profile",
          summary: errorMessage(cause),
          required: "full Zig compile/run and ZLS protocol verification",
          found: "failed",
          checkedPaths: [],
          remediation: "Repair or rebuild the immutable paired profile.",
          details: { code: errorCode(cause) },
        }));
      }
    }

    if (selected === null || sourceService === null) {
      return finish({
        selected,
        source: null,
        adapter: null,
        toolchain: null,
        verification,
        findings: [...baseFindings, ...generalFindings, ...verificationFindings],
      });
    }

    const inspect = async (prepared: PreparedSource): Promise<ZigManagerDoctorResult> => {
      const prerequisite = await this.#inspectPrepared(
        prepared,
        options.signal,
        this.#effectiveConfig(config, selected!),
        scopePath,
        strict,
        sourceRef,
        sourceRefFailure,
        resources,
      );
      return finish({
        selected,
        source: {
          selector: prepared.source.requestedSelector,
          version: prepared.source.version,
          commit: prepared.source.commit,
          kind: prepared.version.kind,
          resolvedAt: prepared.source.resolvedAt,
        },
        adapter: prerequisite.adapter,
        toolchain: prerequisite.toolchain,
        verification,
        findings: [...baseFindings, ...verificationFindings, ...prerequisite.findings],
      });
    };

    try {
      return exact === null
        ? await sourceService.prepare(selected, inspect, {
          operation: `doctor ${selected}`,
          signal: options.signal,
        })
        : await sourceService.prepareExact(exact, inspect, {
          operation: `doctor exact ${selected}`,
          signal: options.signal,
        });
    } catch (cause) {
      rethrowAbort(cause);
      const storedSourceWarnings = exact === null ? [] : sourceDiagnosticWarnings(
        exact,
        undefined,
        config.warnings.movingSelectorMaxAgeHours,
        this.#diagnosticProbe.now(),
      );
      return finish({
        selected,
        source: exact === null ? null : {
          selector: exact.requestedSelector,
          version: exact.version,
          commit: exact.commit,
          kind: exact.version.includes("-dev.") ? "development" : "release",
          resolvedAt: exact.resolvedAt,
        },
        adapter: null,
        toolchain: null,
        verification,
        findings: [
          ...baseFindings,
          ...generalFindings,
          ...storedSourceWarnings,
          ...verificationFindings,
          doctorFailureFinding(cause, selected),
        ],
      });
    }
  }

  async shellActivate(shell: string): Promise<string> {
    await this.#assertHost();
    assertBash(shell);
    const lease = await this.#locks.acquireCatalog({
      operation: "install shell resolver shims",
      wait: {},
    });
    try {
      await this.#shims.install();
      return this.#shims.bashActivation();
    } finally {
      await lease.release();
    }
  }

  async shellDeactivate(shell: string): Promise<string> {
    await this.#assertHost();
    assertBash(shell);
    return this.#shims.bashDeactivation();
  }

  async shellStatus(options: ScopeOperationOptions = {}): Promise<ZigShellStatus> {
    throwIfAborted(options.signal, "inspect Zig manager shell status");
    await this.#assertHost();
    const fallbackZig = await this.#fallbackExecutable("zig");
    const inspected = await inspectSessionDiagnostics({
      env: this.#env,
      expectedShimDirectory: this.paths.shimsDir,
      persistentShimDirectory: this.paths.globalBinDir,
      fallbackPath: fallbackZig,
      pinRelevant: false,
      runner: this.#runner,
      signal: options.signal,
    });
    return {
      schemaVersion: 2,
      active: this.#env.ZM_SESSION_ACTIVE === "1",
      shimDirectory: this.paths.shimsDir,
      basePath: this.#env.ZM_BASE_PATH ?? null,
      fallbackZig,
      fallbackVersion: inspected.session.fallback.version,
      fallbackUsable: inspected.session.fallback.usable,
      current: await this.current(options),
    };
  }

  async gc(options: GcOptions = {}): Promise<ZigGcResult> {
    throwIfAborted(options.signal, "garbage collect manager staging and caches");
    await this.#assertHost();
    const dryRun = options.dryRun === true;
    const removed: string[] = [];
    const retained: string[] = [];
    let registry: ZigScopeRegistryStatus | null = null;

    const collect = async (operationId?: string) => {
      throwIfAborted(options.signal, "garbage collect manager staging and caches");
      const lockOwners = await this.#locks.enumerateOwners();
      const buildStaging = buildStagingRoot(this.paths.buildsDir);
      const staging = await collectAbandonedStaging(
        [buildStaging, this.#installs.stagingRoot, this.#profiles.stagingRoot],
        lockOwners,
        dryRun,
        options.signal,
      );
      removed.push(...staging.removed);
      retained.push(...staging.retained);

      const cachePaths = [
        ...(options.sources ? [this.paths.sourcesDir] : []),
        ...(options.buildCache ? [this.paths.buildsDir, this.paths.logsDir] : []),
      ];
      for (const path of cachePaths) {
        if (path === this.paths.buildsDir && staging.retainedRoots.has(buildStaging)) {
          retained.push(`${path}: retained because build staging could not be proven abandoned`);
          continue;
        }
        if (await removePhysicalTree(path, dryRun, options.signal)) removed.push(path);
      }

      if (options.profiles) {
        const inspected = await this.#inspectScopeRegistry();
        registry = inspected.status;
        if (inspected.inspection === null || !inspected.inspection.profilePruningSafe) {
          retained.push(`profiles: ${inspected.status.reason ?? "scope references are uncertain"}`);
          return;
        }

        let profiles: readonly StoredToolchainProfileMetadata[];
        try {
          profiles = await this.#profiles.listMetadata();
        } catch (cause) {
          retained.push(
            `profiles: the profile store could not be enumerated safely, so all profiles were retained: ${
              errorMessage(cause)
            }`,
          );
          return;
        }
        let globalProfileId: string | null;
        try {
          globalProfileId = (await this.#globalProfile.read())?.profileId ?? null;
        } catch (cause) {
          retained.push(
            `profiles: the global profile pointer cannot be inspected safely, so all profiles were retained: ${
              errorMessage(cause)
            }`,
          );
          return;
        }
        if (
          globalProfileId !== null &&
          !profiles.some(({ profile }) => profile.profileId === globalProfileId)
        ) {
          retained.push(
            `profiles: global profile ${globalProfileId} is missing, so all profiles were retained`,
          );
          return;
        }
        const referenced = new Set(inspected.inspection.referencedProfileIds);
        if (globalProfileId !== null) referenced.add(globalProfileId);
        let changed = false;
        for (const stored of profiles) {
          if (referenced.has(stored.profile.profileId)) {
            retained.push(
              `${stored.root}: ${
                stored.profile.profileId === globalProfileId
                  ? "referenced by the global profile pointer"
                  : "referenced by a known scope"
              }`,
            );
            continue;
          }
          throwIfAborted(options.signal, "garbage collect unreferenced profiles");
          if (!dryRun) {
            await this.#profiles.remove(stored.profile.profileId, options.signal);
            changed = true;
          }
          removed.push(stored.root);
        }
        if (changed) {
          await this.#catalog.rebuild({ operationId, signal: options.signal });
        }
      }
    };

    if (dryRun) {
      await collect();
    } else {
      const globalLease = options.profiles
        ? await this.#acquireGlobal(
          "garbage collect unreferenced profiles",
          undefined,
          options.signal,
        )
        : null;
      try {
        const sourceLease = await this.#locks.acquireSource({
          operation: "garbage collect manager staging and caches",
          ...(globalLease === null ? {} : { operationId: globalLease.owner.operationId }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          wait: {},
        });
        try {
          const operationId = sourceLease.owner.operationId;
          if (options.profiles) {
            const catalogLease = await this.#locks.acquireCatalog({
              operation: "garbage collect unreferenced profiles",
              operationId,
              ...(options.signal === undefined ? {} : { signal: options.signal }),
              wait: {},
            });
            try {
              await collect(operationId);
            } finally {
              await catalogLease.release();
            }
          } else {
            await collect(operationId);
          }
        } finally {
          await sourceLease.release();
        }
      } finally {
        await globalLease?.release();
      }
    }
    retained.push("final installations are never removed by gc");
    return { schemaVersion: 1, dryRun, removed, retained, registry };
  }

  async repair(options: RepairOptions = {}): Promise<ZigRepairResult> {
    throwIfAborted(options.signal, "repair manager metadata");
    await this.#assertHost();
    let unlocked: string | null = null;
    if (options.unlock !== undefined) {
      const target = await this.#unlockTarget(options.unlock, options.path);
      throwIfAborted(options.signal, "unlock stale manager operation");
      if (await this.#locks.unlock(target)) unlocked = options.unlock;
    }
    const lookup = await this.#scopeRoot(options.path);
    const globalLease = await this.#acquireGlobal(
      "repair global profile and manager metadata",
      undefined,
      options.signal,
    );
    try {
      const scopeLease = await this.#acquireScope(
        lookup,
        "repair exact scope and manager metadata",
        undefined,
        options.signal,
        globalLease.owner.operationId,
      );
      try {
        const operationId = scopeLease.owner.operationId;
        const catalogLease = await this.#locks.acquireCatalog({
          operation: "repair catalog and scope registry",
          operationId,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          wait: {},
        });
        try {
          throwIfAborted(options.signal, "repair manager metadata");
          await this.#shims.install();
          await this.#shims.installPersistent();
          throwIfAborted(options.signal, "repair manager metadata");
          let globalProfileId: string | null = null;
          let globalValid: boolean | null = null;
          let globalRemoved = false;
          try {
            const pointer = await this.#globalProfile.read();
            globalProfileId = pointer?.profileId ?? null;
            if (pointer !== null) {
              try {
                await this.#getProfile(pointer.profileId, this.paths.globalProfileFile);
                globalValid = true;
              } catch (cause) {
                const code = errorCode(cause);
                if (
                  code !== "ZIG_PROFILE_NOT_FOUND" && code !== "ZIG_PROFILE_INVALID" &&
                  code !== "ZIG_INSTALL_NOT_FOUND" && code !== "ZIG_INSTALL_CORRUPT"
                ) throw cause;
                globalValid = false;
                globalRemoved = await this.#globalProfile.remove();
              }
            }
          } catch (cause) {
            if (errorCode(cause) !== "ZIG_GLOBAL_PROFILE_INVALID") throw cause;
            globalValid = false;
            globalRemoved = await this.#globalProfile.remove();
          }
          await this.#catalog.rebuild({ operationId, signal: options.signal });
          const pin = await this.#scopeResolver.resolve(lookup);
          let scopeValid: boolean | null = null;
          let registryInspection = await this.#inspectScopeRegistry();
          let reconciled: ZigRepairRegistryStatus["reconciled"] = null;

          if (pin !== null && pin.scopeRoot === lookup) {
            await this.#getProfile(pin.profileId, pin.scopeRoot);
            scopeValid = true;
            if (registryInspection.status.state !== "invalid") {
              try {
                await this.#scopeRegistry.record(
                  pin.scopeRoot,
                  pin.profileId,
                  "repair exact scope pin",
                );
                reconciled = {
                  scopeRoot: pin.scopeRoot,
                  pinPath: pin.pinPath,
                  profileId: pin.profileId,
                };
                registryInspection = await this.#inspectScopeRegistry();
              } catch (cause) {
                registryInspection = {
                  inspection: null,
                  status: invalidRegistryStatus(this.paths.scopesFile, cause),
                };
              }
            }
          }

          return {
            schemaVersion: 2,
            catalogRebuilt: true,
            shimsReinstalled: true,
            scopeValid,
            unlocked,
            registry: { ...registryInspection.status, reconciled },
            global: {
              pointerPath: this.paths.globalProfileFile,
              profileId: globalProfileId,
              valid: globalValid,
              removed: globalRemoved,
            },
          };
        } finally {
          await catalogLease.release();
        }
      } finally {
        await scopeLease.release();
      }
    } finally {
      await globalLease.release();
    }
  }

  async purge(options: PurgeOptions = {}): Promise<ZigPurgeResult> {
    throwIfAborted(options.signal, "purge manager-owned roots");
    await this.#assertHost();
    const dryRun = options.dryRun === true;
    if (!dryRun && options.confirm !== true) throw new ZigPurgeConfirmationError();
    const managerRoots = [
      ...new Set([
        this.paths.configDir,
        this.paths.stateDir,
        this.paths.dataDir,
        this.paths.cacheDir,
      ]),
    ];
    let registry: ZigScopeRegistryStatus;
    let danglingPins: ZigDanglingScopePin[];
    let globalProfileId: string | null = null;
    let persistentResolvers = { zig: false, zls: false };
    const roots: string[] = [];

    const inspect = async () => {
      try {
        globalProfileId = (await this.#globalProfile.read())?.profileId ?? null;
      } catch (cause) {
        if (errorCode(cause) !== "ZIG_GLOBAL_PROFILE_INVALID") throw cause;
        globalProfileId = null;
      }
      const result = await this.#inspectScopeRegistry();
      registry = result.status;
      danglingPins = (result.inspection?.knownPins ?? [])
        .filter((pin) => managerRoots.every((root) => !pathIsWithin(root, pin.pinPath)))
        .map((pin) => ({ ...pin }));
    };

    if (dryRun) {
      await inspect();
      persistentResolvers = await this.#shims.removePersistent(true);
      for (const root of managerRoots) {
        if (await removePhysicalTree(root, true, options.signal)) roots.push(root);
      }
    } else {
      const globalLease = await this.#acquireGlobal(
        "purge manager-owned roots",
        undefined,
        options.signal,
      );
      try {
        const sourceLease = await this.#locks.acquireSource({
          operation: "purge manager-owned roots",
          operationId: globalLease.owner.operationId,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          wait: {},
        });
        try {
          const operationId = sourceLease.owner.operationId;
          const catalogLease = await this.#locks.acquireCatalog({
            operation: "purge manager-owned roots",
            operationId,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            wait: {},
          });
          try {
            await inspect();
            await assertOnlyPurgeLocks(
              this.paths.locksDir,
              sourceLease.path,
              catalogLease.path,
              globalLease.path,
            );
            persistentResolvers = await this.#shims.removePersistent();
            for (const root of managerRoots) {
              if (root === this.paths.stateDir) continue;
              if (await removePhysicalTree(root, false, options.signal)) roots.push(root);
            }
            await removeStateContentsExceptLocks(
              this.paths.stateDir,
              this.paths.locksDir,
              options.signal,
            );
          } finally {
            await catalogLease.release();
          }
        } finally {
          await sourceLease.release();
        }
      } finally {
        await globalLease.release();
      }
      throwIfAborted(options.signal, "remove empty manager state root");
      if (await removeEmptyStateRoot(this.paths.stateDir, this.paths.locksDir)) {
        roots.push(this.paths.stateDir);
      }
    }

    return {
      schemaVersion: 2,
      dryRun,
      roots,
      registry: registry!,
      danglingPins: danglingPins!,
      globalProfileId,
      persistentResolvers,
    };
  }

  async #installSelector(
    selector: string,
    options: BuildOptions,
    scope?: string,
    operationId?: string,
  ): Promise<InstalledSelection> {
    const zig = await this.#installZigSelector(selector, options, scope, operationId);
    const zls = await this.#installZlsForZig(zig, options, scope);
    return { zig, zls, operationId: zig.operationId };
  }

  async #installZigSelector(
    selector: string,
    options: BuildOptions,
    scope?: string,
    operationId?: string,
  ): Promise<InstalledZigSelection> {
    const source = await this.#source();
    return await source.prepare(
      selector,
      (prepared) => this.#installPrepared(prepared, options, scope),
      {
        operation: `install Zig ${selector}`,
        operationId,
        scope,
        signal: options.signal,
      },
    );
  }

  async #installExact(
    sourceValue: ResolvedSource,
    options: BuildOptions,
    scope?: string,
    operationId?: string,
    policy: InstallPreparedPolicy = {},
  ): Promise<InstalledZigSelection> {
    return await (await this.#source()).prepareExact(
      sourceValue,
      (prepared) => this.#installPrepared(prepared, options, scope, policy),
      {
        operation: `sync Zig ${sourceValue.commit}`,
        operationId,
        scope,
        signal: options.signal,
      },
    );
  }

  async #installPrepared(
    prepared: PreparedSource,
    options: BuildOptions,
    scope?: string,
    policy: InstallPreparedPolicy = {},
  ): Promise<InstalledZigSelection> {
    throwIfAborted(options.signal, "prepare managed Zig installation");
    const operationId = prepared.operationId;
    const config = await this.#config();
    const effectiveConfig = this.#effectiveConfig(config, prepared.source.requestedSelector);
    const doctor = await this.#inspectPrepared(
      prepared,
      options.signal,
      effectiveConfig,
      scope,
    );
    if (!doctor.buildReady) throw new BuildPrerequisiteError(doctor.findings);
    throwIfAborted(options.signal, "prepare managed Zig installation");
    const preparedRecipe = await this.#prepareRecipe({
      source: prepared.source,
      sourceVersion: prepared.version,
      adapter: prepared.adapter,
      host: this.host,
      config: effectiveConfig,
      toolchain: doctor.toolchain,
      runner: this.#runner,
      env: this.#env,
      cwd: this.#cwd,
      profile: options.profile,
      jobs: options.jobs,
      signal: options.signal,
    });
    throwIfAborted(options.signal, "prepare managed Zig installation");
    const installationId = preparedRecipe.installationId;
    if (
      policy.expectedInstallationId !== undefined &&
      installationId !== policy.expectedInstallationId
    ) {
      throw new ZigInstallCorruptError(
        policy.expectedInstallationId,
        `the exact stored source now produces canonical recipe ${installationId}`,
      );
    }
    const lease = await this.#locks.acquireInstall(installationId, {
      operation: policy.quarantineCorrupt
        ? `sync exact Zig ${installationId}`
        : `install Zig ${installationId}`,
      operationId,
      selector: prepared.source.requestedSelector,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      wait: {},
    });
    try {
      throwIfAborted(options.signal, "install managed Zig");
      let corruptCause: unknown = null;
      const inspection = await this.#installs.inspect("zig", installationId);
      if (inspection.state === "healthy") {
        try {
          const reused = await reuseInstalledZig({
            recipe: preparedRecipe.recipe,
            source: prepared.source,
            store: this.#installs,
            runner: this.#runner,
            runtimeDependencyInspector: this.#runtimeDependencyInspector,
            cacheRoot: this.paths.cacheDir,
            platform: this.#platform,
            operationId,
            signal: options.signal,
          });
          if (reused === null) throw new Error("installation disappeared during locked reuse");
          return {
            installed: reused,
            source: prepared.source,
            reused: true,
            operationId,
          };
        } catch (cause) {
          if (options.signal?.aborted || cause instanceof ZigOperationAbortedError) throw cause;
          corruptCause = cause;
        }
      } else if (inspection.state === "corrupt") {
        corruptCause = inspection.error;
      }
      if (corruptCause !== null) {
        if (!policy.quarantineCorrupt) {
          throw new ZigInstallCorruptError(installationId, errorMessage(corruptCause), {
            cause: corruptCause,
          });
        }
        throwIfAborted(options.signal, "quarantine corrupt Zig installation");
        await this.#installs.quarantine(
          "zig",
          installationId,
          operationId,
          "corrupt",
          options.signal,
        );
      }

      const sourceState = sourceStateFromPrepared(prepared);
      const build = await this.#build({
        repositoryHome: prepared.repositoryHome,
        buildRoot: this.paths.buildsDir,
        logRoot: this.paths.logsDir,
        operationId,
        recipe: preparedRecipe.recipe,
        installationId,
        source: sourceState,
        doctor,
        adapter: prepared.adapter,
        runner: this.#runner,
        hostTarget: this.host.denoTarget,
        platform: this.#platform,
        config: effectiveConfig,
        options,
        progress: this.#progress,
      });
      throwIfAborted(options.signal, "install managed Zig");
      const identity = await createBuiltZigInstallIdentity({
        buildManifest: build.manifest,
        source: prepared.source,
        adapter: prepared.adapter,
        host: this.host,
        expectedHostTarget: this.host.denoTarget,
      });
      if (await computeInstallationId(identity) !== installationId) {
        throw new ZigInstallCorruptError(
          installationId,
          "build output manifest changed the precomputed canonical recipe",
        );
      }
      const installed = await this.#installBuilt({
        buildManifest: build.manifest,
        source: prepared.source,
        adapter: prepared.adapter,
        host: this.host,
        expectedHostTarget: this.host.denoTarget,
        store: this.#installs,
        runner: this.#runner,
        platform: this.#platform,
        runtimeDependencyInspector: this.#runtimeDependencyInspector,
        cacheRoot: this.paths.cacheDir,
        operationId,
        signal: options.signal,
      });
      throwIfAborted(options.signal, "install managed Zig");
      return {
        installed,
        source: prepared.source,
        reused: installed.reused,
        operationId,
      };
    } finally {
      await lease.release();
    }
  }

  async #installZlsForZig(
    zig: InstalledZigSelection,
    options: BuildOptions,
    scope?: string,
  ): Promise<InstalledZlsSelection> {
    const workspace = await this.#zlsSource();
    const prepareOptions = {
      operation: `install ZLS for Zig ${zig.source.requestedSelector}`,
      operationId: zig.operationId,
      scope,
      signal: options.signal,
    };
    const install = (prepared: PreparedZlsSource) => {
      if (zig.source.versionMetadata.kind !== "release") {
        const zigCycle = sourceCycle(zig.source.versionMetadata.base, "Zig");
        const zlsCycle = sourceCycle(prepared.version.base, "ZLS");
        if (zigCycle.major !== zlsCycle.major || zigCycle.minor !== zlsCycle.minor) {
          throw new ZlsCompatibilityNotFoundError(zig.source.version, {
            reason:
              `ZLS remote HEAD declares development cycle ${zlsCycle.major}.${zlsCycle.minor}, not ${zigCycle.major}.${zigCycle.minor}`,
            zigSelector: zig.source.requestedSelector,
            zigVersion: zig.source.version,
            zlsVersion: prepared.source.version,
          });
        }
      }
      const compatibilityReason = zlsZigCompatibilityReason(
        zig.source.version,
        prepared.version,
        prepared.zigCompatibility,
      );
      if (compatibilityReason !== null) {
        throw new ZlsCompatibilityNotFoundError(zig.source.version, {
          reason: compatibilityReason,
          zigSelector: zig.source.requestedSelector,
          zigVersion: zig.source.version,
          zlsVersion: prepared.source.version,
          minimumZigVersion: prepared.zigCompatibility.minimumBuildVersion,
          maximumZigVersionExclusive: prepared.zigCompatibility.maximumBuildVersionExclusive,
        });
      }
      return this.#installPreparedZls(prepared, zig.installed, options);
    };

    if (zig.source.requestedSelector === "latest") {
      return await workspace.prepare("latest", install, prepareOptions);
    }
    if (zig.source.versionMetadata.kind === "release") {
      const cycle = sourceCycle(zig.source.versionMetadata.base, "Zig");
      try {
        return await workspace.prepareStable(cycle.major, cycle.minor, install, prepareOptions);
      } catch (cause) {
        if (
          cause instanceof ZlsSourceVersionNotFoundError ||
          errorCode(cause) === "ZLS_SOURCE_VERSION_NOT_FOUND"
        ) {
          throw new ZlsCompatibilityNotFoundError(zig.source.version, {
            reason: `no strict ZLS tag exists in release cycle ${cycle.major}.${cycle.minor}`,
            zigSelector: zig.source.requestedSelector,
            zigVersion: zig.source.version,
          });
        }
        throw cause;
      }
    }
    return await workspace.prepare("latest", install, prepareOptions);
  }

  async #installPreparedZls(
    prepared: PreparedZlsSource,
    zig: InstalledObject,
    options: BuildOptions,
    policy: InstallPreparedPolicy = {},
  ): Promise<InstalledZlsSelection> {
    throwIfAborted(options.signal, "prepare managed ZLS installation");
    const operationId = prepared.operationId;
    const reusable = policy.expectedInstallationId === undefined
      ? await this.#prepareEquivalentZlsRecipe(prepared.source, zig, options)
      : null;
    const recipeSource = reusable?.source ?? prepared.source;
    const preparedRecipe: PreparedZlsBuildRecipe = reusable?.recipe ??
      await this.#prepareZlsRecipe({
        source: recipeSource,
        host: this.host,
        zig,
        jobs: options.jobs ?? null,
        signal: options.signal,
      });
    const installationId = preparedRecipe.installationId;
    if (
      policy.expectedInstallationId !== undefined &&
      installationId !== policy.expectedInstallationId
    ) {
      throw new ZigInstallCorruptError(
        policy.expectedInstallationId,
        `the exact stored ZLS source now produces canonical recipe ${installationId}`,
      );
    }
    const lease = await this.#locks.acquireInstall(installationId, {
      operation: policy.quarantineCorrupt
        ? `sync exact ZLS ${installationId}`
        : `install ZLS ${installationId}`,
      operationId,
      selector: prepared.source.requestedSelector,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      wait: {},
    });
    try {
      let corruptCause: unknown = null;
      const inspection = await this.#installs.inspect("zls", installationId);
      if (inspection.state === "healthy") {
        try {
          const reused = await this.#reuseInstalledZls({
            recipe: preparedRecipe.recipe,
            source: recipeSource,
            zig,
            store: this.#installs,
            runner: this.#runner,
            runtimeDependencyInspector: this.#runtimeDependencyInspector,
            protocolVerifier: this.#zlsProtocolVerifier,
            cacheRoot: this.paths.cacheDir,
            platform: this.#platform,
            operationId,
            signal: options.signal,
          });
          if (reused === null) throw new Error("ZLS installation disappeared during locked reuse");
          return { installed: reused, source: recipeSource, reused: true };
        } catch (cause) {
          if (options.signal?.aborted || cause instanceof ZigOperationAbortedError) throw cause;
          corruptCause = cause;
        }
      } else if (inspection.state === "corrupt") {
        corruptCause = inspection.error;
      }
      if (corruptCause !== null) {
        if (!policy.quarantineCorrupt) {
          throw new ZigInstallCorruptError(installationId, errorMessage(corruptCause), {
            cause: corruptCause,
          });
        }
        await this.#installs.quarantine(
          "zls",
          installationId,
          operationId,
          "corrupt",
          options.signal,
        );
      }

      const build = await this.#buildZls({
        recipe: preparedRecipe.recipe,
        installationId,
        sourcePath: prepared.checkoutPath,
        zig,
        runner: this.#runner,
        buildRoot: this.paths.buildsDir,
        // Zig already owns logs/<operationId>; keep ZLS's deterministic tree disjoint.
        logRoot: join(this.paths.logsDir, "zls"),
        operationId,
        progress: this.#progress,
        signal: options.signal,
      });
      throwIfAborted(options.signal, "install managed ZLS");
      const installed = await this.#installBuiltZls({
        buildManifest: build.manifest,
        source: recipeSource,
        zig,
        store: this.#installs,
        runner: this.#runner,
        runtimeDependencyInspector: this.#runtimeDependencyInspector,
        protocolVerifier: this.#zlsProtocolVerifier,
        cacheRoot: this.paths.cacheDir,
        platform: this.#platform,
        operationId,
        signal: options.signal,
      });
      return {
        installed,
        source: recipeSource,
        reused: installed.reused,
      };
    } finally {
      await lease.release();
    }
  }

  async #prepareEquivalentZlsRecipe(
    source: ResolvedZlsSource,
    zig: InstalledObject,
    options: BuildOptions,
  ): Promise<
    { readonly source: ResolvedZlsSource; readonly recipe: PreparedZlsBuildRecipe } | null
  > {
    const candidates = (await this.#installs.listMetadata())
      .filter(({ manifest }) =>
        manifest.component === "zls" && manifest.dependencies.length === 1 &&
        manifest.dependencies[0].component === "zig" &&
        manifest.dependencies[0].installationId === zig.manifest.installationId &&
        sameSourceObservation(manifest.source, source)
      )
      .sort((left, right) =>
        left.manifest.installationId.localeCompare(right.manifest.installationId)
      );
    for (const candidate of candidates) {
      if (candidate.manifest.source.component !== "zls") continue;
      let candidateSource: ResolvedZlsSource;
      try {
        candidateSource = validateResolvedZlsSource(candidate.manifest.source);
      } catch {
        continue;
      }
      const recipe = await this.#prepareZlsRecipe({
        source: candidateSource,
        host: this.host,
        zig,
        jobs: options.jobs ?? null,
        signal: options.signal,
      });
      if (recipe.installationId === candidate.manifest.installationId) {
        return { source: candidateSource, recipe };
      }
    }
    return null;
  }

  async #inspectPrepared(
    prepared: PreparedSource,
    signal?: AbortSignal,
    effectiveConfig?: ResolvedZigManagerConfig,
    scopePath?: string,
    strict = false,
    knownSourceRefDoctor?: SourceRefDoctorResult | null,
    knownSourceRefFailure?: unknown,
    knownResources?: DiagnosticResourceResult,
  ): Promise<ZigDoctorResult> {
    throwIfAborted(signal, "inspect prepared Zig source");
    let sourceRefDoctor = knownSourceRefDoctor ?? null;
    let sourceRefFailure = knownSourceRefFailure;
    if (knownSourceRefDoctor === undefined) {
      try {
        sourceRefDoctor = await (await this.#source()).doctor(signal);
      } catch (cause) {
        if (signal?.aborted) throwIfAborted(signal, "inspect prepared Zig source");
        rethrowAbort(cause);
        sourceRefFailure = cause;
      }
    }
    const config = effectiveConfig ?? this.#effectiveConfig(
      await this.#config(),
      prepared.source.requestedSelector,
    );
    const result = await inspectBuildPrerequisites({
      config,
      adapter: prepared.adapter,
      sourceRefDoctor,
      sourceRefFailure,
      runner: this.#runner,
      env: this.#env,
      platform: this.#platform,
      resourcePaths: {
        cacheBuild: this.paths.buildsDir,
        dataStaging: this.#installs.stagingRoot,
        ...(scopePath === undefined ? {} : { scope: scopePath }),
        cacheRoot: this.paths.cacheDir,
      },
      resources: knownResources,
      diagnosticProbe: this.#diagnosticProbe,
      source: prepared.source,
      sourceVersion: prepared.version,
      strict,
      signal,
    });
    throwIfAborted(signal, "inspect prepared Zig source");
    return result;
  }

  async #publishScopeSelection(
    scopeRoot: string,
    selection: InstalledSelection,
    operation: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<{ readonly profile: ProfileCreateResult; readonly pin: ScopePinWriteResult }> {
    const lease = await this.#locks.acquireCatalog({
      operation: `publish scope metadata for ${operation}`,
      operationId,
      ...(signal === undefined ? {} : { signal }),
      wait: {},
    });
    try {
      await this.#installPersistentResolvers(signal);
      const profile = await this.#createProfile(selection, operationId, signal);
      await this.#catalog.rebuild({ operationId, signal });
      throwIfAborted(signal, `publish scope pin for ${operation}`);
      const pin = await this.#pins.write(scopeRoot, profile.profile.profileId, {
        operationId,
        signal,
      });
      await this.#recordScopeRegistryAdvisory(scopeRoot, profile.profile.profileId, operation);
      return { profile, pin };
    } finally {
      await lease.release();
    }
  }

  async #publishPairProfile(
    selection: InstalledSelection,
    operation: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<ProfileCreateResult> {
    const lease = await this.#locks.acquireCatalog({
      operation: `publish paired profile for ${operation}`,
      operationId,
      ...(signal === undefined ? {} : { signal }),
      wait: {},
    });
    try {
      const profile = await this.#createProfile(selection, operationId, signal);
      await this.#catalog.rebuild({ operationId, signal });
      return profile;
    } finally {
      await lease.release();
    }
  }

  async #publishGlobalSelection(
    selection: InstalledSelection,
    operation: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<{ readonly profile: ProfileCreateResult; readonly pointerPath: string }> {
    const lease = await this.#locks.acquireCatalog({
      operation: `publish global metadata for ${operation}`,
      operationId,
      ...(signal === undefined ? {} : { signal }),
      wait: {},
    });
    try {
      await this.#installPersistentResolvers(signal);
      const profile = await this.#createProfile(selection, operationId, signal);
      await this.#catalog.rebuild({ operationId, signal });
      throwIfAborted(signal, `publish global profile pointer for ${operation}`);
      const pointer = await this.#globalProfile.write(profile.profile.profileId);
      return { profile, pointerPath: pointer.pointerPath };
    } finally {
      await lease.release();
    }
  }

  async #publishLegacyScopeSelection(
    scopeRoot: string,
    selection: InstalledZigSelection,
    operation: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<{ readonly profile: ProfileCreateResult; readonly pinPath: string }> {
    const lease = await this.#locks.acquireCatalog({
      operation: `publish legacy scope metadata for ${operation}`,
      operationId,
      ...(signal === undefined ? {} : { signal }),
      wait: {},
    });
    try {
      await this.#installPersistentResolvers(signal);
      const profile = await this.#createLegacyProfile(selection, operationId, signal);
      await this.#catalog.rebuild({ operationId, signal });
      throwIfAborted(signal, `publish scope pin for ${operation}`);
      const pin = await this.#pins.write(scopeRoot, profile.profile.profileId, {
        operationId,
        signal,
      });
      await this.#recordScopeRegistryAdvisory(scopeRoot, profile.profile.profileId, operation);
      return { profile, pinPath: pin.pinPath };
    } finally {
      await lease.release();
    }
  }

  async #publishLegacyGlobalSelection(
    selection: InstalledZigSelection,
    operation: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<{ readonly profile: ProfileCreateResult; readonly pinPath: string }> {
    const lease = await this.#locks.acquireCatalog({
      operation: `publish legacy global metadata for ${operation}`,
      operationId,
      ...(signal === undefined ? {} : { signal }),
      wait: {},
    });
    try {
      await this.#installPersistentResolvers(signal);
      const profile = await this.#createLegacyProfile(selection, operationId, signal);
      await this.#catalog.rebuild({ operationId, signal });
      throwIfAborted(signal, `publish global profile pointer for ${operation}`);
      const pointer = await this.#globalProfile.write(profile.profile.profileId);
      return { profile, pinPath: pointer.pointerPath };
    } finally {
      await lease.release();
    }
  }

  async #publishExistingScopePin(
    scopeRoot: string,
    profileId: string,
    operation: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<ScopePinWriteResult> {
    const lease = await this.#locks.acquireCatalog({
      operation: `publish scope metadata for ${operation}`,
      operationId,
      ...(signal === undefined ? {} : { signal }),
      wait: {},
    });
    try {
      await this.#installPersistentResolvers(signal);
      throwIfAborted(signal, `publish scope pin for ${operation}`);
      const pin = await this.#pins.write(scopeRoot, profileId, { operationId, signal });
      await this.#recordScopeRegistryAdvisory(scopeRoot, profileId, operation);
      return pin;
    } finally {
      await lease.release();
    }
  }

  async #publishExistingGlobalProfile(
    profileId: string,
    operation: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<{ readonly pinPath: string }> {
    const lease = await this.#locks.acquireCatalog({
      operation: `publish global metadata for ${operation}`,
      operationId,
      ...(signal === undefined ? {} : { signal }),
      wait: {},
    });
    try {
      await this.#installPersistentResolvers(signal);
      await this.#getProfile(profileId, this.paths.globalProfileFile);
      await this.#catalog.rebuild({ operationId, signal });
      throwIfAborted(signal, `publish global profile pointer for ${operation}`);
      const pointer = await this.#globalProfile.write(profileId);
      return { pinPath: pointer.pointerPath };
    } finally {
      await lease.release();
    }
  }

  async #recordScopeRegistryAdvisory(
    scopeRoot: string,
    profileId: string,
    operation: string,
  ): Promise<void> {
    try {
      await this.#scopeRegistry.record(scopeRoot, profileId, operation);
    } catch (cause) {
      await this.#warnRegistryFailure(scopeRoot, "record", cause);
    }
  }

  async #removeScopeRegistryAdvisory(scopeRoot: string): Promise<void> {
    try {
      await this.#scopeRegistry.remove(scopeRoot);
    } catch (cause) {
      await this.#warnRegistryFailure(scopeRoot, "remove", cause);
    }
  }

  async #warnRegistryFailure(
    scopeRoot: string,
    action: "record" | "remove",
    cause: unknown,
  ): Promise<void> {
    try {
      await this.#progress(
        `Warning: the scope pin operation succeeded, but zig-manager could not ${action} its advisory registry entry: ${
          errorMessage(cause)
        }\n` +
          `Repair it with: zm repair --path ${shellQuote(scopeRoot)}\n`,
      );
    } catch {
      // A diagnostic callback must not turn a committed pin operation into a reported failure.
    }
  }

  async #inspectScopeRegistry(): Promise<{
    readonly inspection: ScopeRegistryInspection | null;
    readonly status: ZigScopeRegistryStatus;
  }> {
    try {
      const inspection = await this.#scopeRegistry.inspect();
      return {
        inspection,
        status: scopeRegistryStatus(this.paths.scopesFile, inspection),
      };
    } catch (cause) {
      return {
        inspection: null,
        status: invalidRegistryStatus(this.paths.scopesFile, cause),
      };
    }
  }

  async #findInstallMetadata(installationId: string): Promise<StoredInstallMetadata | null> {
    const installations = await this.#installs.listMetadata();
    for (const component of ["zig", "zls"] as const) {
      const found = installations.find(({ manifest }) =>
        manifest.component === component && manifest.installationId === installationId
      );
      if (found !== undefined) return found;
    }
    return null;
  }

  async #createProfile(
    selection: InstalledSelection,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<ProfileCreateResult> {
    const input: CreateToolchainProfileInput = {
      schemaVersion: 2,
      zigInstallationId: selection.zig.installed.manifest.installationId,
      zlsInstallationId: selection.zls.installed.manifest.installationId,
      source: selection.zig.source,
      zlsSource: selection.zls.source,
      host: this.host,
    };
    return await this.#profiles.create(input, { operationId, signal });
  }

  async #createLegacyProfile(
    selection: InstalledZigSelection,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<ProfileCreateResult> {
    return await this.#profiles.create({
      schemaVersion: 1,
      zigInstallationId: selection.installed.manifest.installationId,
      source: selection.source,
      host: this.host,
    }, { operationId, signal });
  }

  async #getInstall(installationId: string): Promise<InstalledObject> {
    return await this.#getComponentInstall("zig", installationId);
  }

  async #getZlsInstall(installationId: string): Promise<InstalledObject> {
    return await this.#getComponentInstall("zls", installationId);
  }

  async #getComponentInstall(
    component: "zig" | "zls",
    installationId: string,
  ): Promise<InstalledObject> {
    try {
      return await this.#installs.get(component, installationId);
    } catch (cause) {
      if (errorCode(cause) === "INSTALL_NOT_FOUND") {
        throw new ZigInstallNotFoundError(installationId, { cause });
      }
      if (errorCode(cause)?.startsWith("INSTALL_") === true) {
        throw new ZigInstallCorruptError(installationId, errorMessage(cause), { cause });
      }
      throw cause;
    }
  }

  async #getProfile(profileId: string, scopeRoot: string): Promise<StoredToolchainProfile> {
    try {
      return await this.#profiles.get(profileId);
    } catch (cause) {
      if (errorCode(cause) === "PROFILE_NOT_FOUND") {
        throw new ZigProfileNotFoundError(profileId, scopeRoot, { cause });
      }
      if (errorCode(cause)?.startsWith("PROFILE_") === true) {
        throw new ZigProfileInvalidError(profileId, errorMessage(cause), { cause });
      }
      if (errorCode(cause) === "INSTALL_NOT_FOUND") {
        const installationId = errorDetail(cause, "installationId") ?? "unknown";
        throw new ZigInstallNotFoundError(installationId, { cause });
      }
      if (errorCode(cause)?.startsWith("INSTALL_") === true) {
        const installationId = errorDetail(cause, "installationId") ?? "unknown";
        throw new ZigInstallCorruptError(installationId, errorMessage(cause), { cause });
      }
      throw cause;
    }
  }

  async #readProfile(profileId: string, scopeRoot: string): Promise<ToolchainProfileV1> {
    try {
      return await this.#profiles.read(profileId);
    } catch (cause) {
      if (errorCode(cause) === "PROFILE_NOT_FOUND") {
        throw new ZigProfileNotFoundError(profileId, scopeRoot, { cause });
      }
      if (errorCode(cause)?.startsWith("PROFILE_") === true) {
        throw new ZigProfileInvalidError(profileId, errorMessage(cause), { cause });
      }
      throw cause;
    }
  }

  async #getInstallFromProfile(
    reference: ProfileReference,
    signal?: AbortSignal,
  ): Promise<{ readonly stored: StoredToolchainProfile; readonly installed: InstalledObject }> {
    const stored = await this.#getProfile(
      reference.profileId,
      reference.scopeRoot ?? reference.pinPath,
    );
    await this.#fullyVerifyProfile(stored, signal);
    const installed = await this.#getInstall(stored.profile.components.zig);
    return { stored, installed };
  }

  async #findPairedProfile(value: string): Promise<StoredToolchainProfile | null> {
    const direct = await this.#profiles.tryGet(value);
    if (direct !== null && isPairedToolchainProfile(direct.profile)) return direct;
    const candidates = (await this.#profiles.listMetadata()).filter(({ profile }) =>
      isPairedToolchainProfile(profile) && profile.components.zig === value
    );
    if (candidates.length === 0) return null;
    if (candidates.length > 1) {
      throw new ZigInvalidArgumentError(
        `Installed Zig '${value}' belongs to multiple paired profiles; select an exact profile ID`,
        { value, profileIds: candidates.map(({ profile }) => profile.profileId).sort() },
      );
    }
    return await this.#getProfile(candidates[0].profile.profileId, candidates[0].root);
  }

  async #syncExactZig(
    source: ResolvedSource,
    installationId: string,
    options: BuildOptions,
    scope: string,
    operationId: string,
  ): Promise<{ readonly selection: InstalledZigSelection; readonly rebuilt: boolean }> {
    const inspection = await this.#installs.inspect("zig", installationId);
    if (inspection.state === "healthy") {
      try {
        const installed = await reuseInstalledZig({
          recipe: inspection.installed.manifest.identity,
          source,
          store: this.#installs,
          runner: this.#runner,
          runtimeDependencyInspector: this.#runtimeDependencyInspector,
          cacheRoot: this.paths.cacheDir,
          platform: this.#platform,
          operationId,
          signal: options.signal,
        });
        if (installed !== null && installed.manifest.installationId === installationId) {
          return {
            selection: { installed, source, reused: true, operationId },
            rebuilt: false,
          };
        }
      } catch (cause) {
        rethrowAbort(cause);
        // Exact sync is authorized to quarantine and rebuild this immutable ID.
      }
    }
    const selection = await this.#installExact(source, options, scope, operationId, {
      expectedInstallationId: installationId,
      quarantineCorrupt: true,
    });
    if (selection.installed.manifest.installationId !== installationId) {
      throw new ZigInstallCorruptError(
        installationId,
        "the stored immutable Zig recipe cannot be reproduced",
      );
    }
    return { selection, rebuilt: true };
  }

  async #syncExactZls(
    source: ResolvedZlsSource,
    installationId: string,
    zig: InstalledObject,
    options: BuildOptions,
    scope: string,
    operationId: string,
  ): Promise<{ readonly selection: InstalledZlsSelection; readonly rebuilt: boolean }> {
    const inspection = await this.#installs.inspect("zls", installationId);
    if (inspection.state === "healthy") {
      try {
        if (!isZlsBuildRecipe(inspection.installed.manifest.identity)) {
          throw new Error("stored ZLS identity is not a source-build recipe");
        }
        const installed = await this.#reuseInstalledZls({
          recipe: inspection.installed.manifest.identity,
          source,
          zig,
          store: this.#installs,
          runner: this.#runner,
          runtimeDependencyInspector: this.#runtimeDependencyInspector,
          protocolVerifier: this.#zlsProtocolVerifier,
          cacheRoot: this.paths.cacheDir,
          platform: this.#platform,
          operationId,
          signal: options.signal,
        });
        if (installed !== null && installed.manifest.installationId === installationId) {
          return { selection: { installed, source, reused: true }, rebuilt: false };
        }
      } catch (cause) {
        rethrowAbort(cause);
        // Exact sync is authorized to quarantine and rebuild this immutable ID.
      }
    }
    const selection = await (await this.#zlsSource()).prepareExact(
      source,
      (prepared) =>
        this.#installPreparedZls(prepared, zig, options, {
          expectedInstallationId: installationId,
          quarantineCorrupt: true,
        }),
      {
        operation: `sync exact ZLS ${source.commit}`,
        operationId,
        scope,
        signal: options.signal,
      },
    );
    if (selection.installed.manifest.installationId !== installationId) {
      throw new ZigInstallCorruptError(
        installationId,
        "the stored immutable ZLS recipe cannot be reproduced",
      );
    }
    return { selection, rebuilt: true };
  }

  async #fullyVerifyProfile(
    stored: StoredToolchainProfile,
    signal?: AbortSignal,
    operationId?: string,
  ): Promise<void> {
    const zig = await this.#getInstall(stored.profile.components.zig);
    this.#assertInstallHost(zig);
    await this.#fullyVerifyInstall(zig, stored.profile.source, signal, operationId);
    if (!isPairedToolchainProfile(stored.profile)) return;
    const zls = await this.#getZlsInstall(stored.profile.components.zls);
    this.#assertInstallHost(zls);
    await this.#fullyVerifyZls(
      zls,
      stored.profile.zlsSource,
      zig,
      signal,
      operationId,
    );
  }

  async #fullyVerifyZls(
    installed: InstalledObject,
    source: ResolvedZlsSource,
    zig: InstalledObject,
    signal?: AbortSignal,
    operationId?: string,
  ): Promise<void> {
    try {
      if (!isZlsBuildRecipe(installed.manifest.identity)) {
        throw new Error("ZLS installation does not contain a source-build recipe");
      }
      const verified = await this.#reuseInstalledZls({
        recipe: installed.manifest.identity,
        source,
        zig,
        store: this.#installs,
        runner: this.#runner,
        runtimeDependencyInspector: this.#runtimeDependencyInspector,
        protocolVerifier: this.#zlsProtocolVerifier,
        cacheRoot: this.paths.cacheDir,
        platform: this.#platform,
        operationId,
        signal,
      });
      if (verified === null) throw new ZigInstallNotFoundError(installed.manifest.installationId);
    } catch (cause) {
      if (signal?.aborted) throwIfAborted(signal, "verify immutable ZLS installation");
      if (cause instanceof ZigOperationAbortedError) throw cause;
      if (cause instanceof ZigInstallNotFoundError) throw cause;
      throw new ZigInstallCorruptError(
        installed.manifest.installationId,
        errorMessage(cause),
        { cause },
      );
    }
  }

  async #profileZlsStatus(
    stored: StoredToolchainProfile,
  ): Promise<ZigManagerToolStatus | null> {
    if (stored.profile.components.zls === null || stored.zlsPath === null) return null;
    const installed = await this.#getZlsInstall(stored.profile.components.zls);
    const source = isPairedToolchainProfile(stored.profile)
      ? stored.profile.zlsSource
      : installed.manifest.source;
    return toolStatus("zls", installed.manifest.installationId, source, stored.zlsPath);
  }

  async #fullyVerifyInstall(
    installed: InstalledObject,
    source: ResolvedSource,
    signal?: AbortSignal,
    operationId?: string,
  ): Promise<void> {
    try {
      const verified = await reuseInstalledZig({
        recipe: installed.manifest.identity,
        source,
        store: this.#installs,
        runner: this.#runner,
        runtimeDependencyInspector: this.#runtimeDependencyInspector,
        cacheRoot: this.paths.cacheDir,
        platform: this.#platform,
        operationId,
        signal,
      });
      if (verified === null) throw new ZigInstallNotFoundError(installed.manifest.installationId);
    } catch (cause) {
      if (signal?.aborted) throwIfAborted(signal, "verify immutable Zig installation");
      if (cause instanceof ZigOperationAbortedError) throw cause;
      if (cause instanceof ZigInstallNotFoundError) throw cause;
      throw new ZigInstallCorruptError(
        installed.manifest.installationId,
        errorMessage(cause),
        { cause },
      );
    }
  }

  #assertInstallHost(installed: InstalledObject): void {
    if (installed.manifest.executable.hostTarget !== this.host.denoTarget) {
      throw new ZigInstallCorruptError(
        installed.manifest.installationId,
        `host target ${installed.manifest.executable.hostTarget} does not match ${this.host.denoTarget}`,
      );
    }
  }

  async #rebuildCatalog(
    operation: string,
    operationId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const lease = await this.#locks.acquireCatalog({
      operation,
      operationId,
      ...(signal === undefined ? {} : { signal }),
      wait: {},
    });
    try {
      await this.#catalog.rebuild({ operationId, signal });
    } finally {
      await lease.release();
    }
  }

  async #requirePin(path: string): Promise<ResolvedScopePin> {
    const pin = await this.#scopeResolver.resolve(path);
    if (pin === null) throw new ZigScopeNotPinnedError(path);
    return pin;
  }

  async #resolveReference(
    lookupPath: string,
    globalOnly: boolean,
  ): Promise<ProfileReference | null> {
    if (!globalOnly) {
      const pin = await this.#scopeResolver.resolve(lookupPath);
      if (pin !== null) return referenceFromPin(pin);
    }
    const pointer = await this.#globalProfile.read();
    if (pointer === null) return null;
    return {
      selection: "global",
      lookupPath,
      scopeRoot: null,
      pinPath: pointer.pointerPath,
      profileId: pointer.profileId,
    };
  }

  async #requireGlobalReference(lookupPath: string): Promise<ProfileReference> {
    const reference = await this.#resolveReference(lookupPath, true);
    if (reference === null) throw new ZigScopeNotPinnedError(this.paths.globalProfileFile);
    return reference;
  }

  async #requireSameReference(expected: ProfileReference): Promise<ProfileReference> {
    const actual = expected.selection === "global"
      ? await this.#requireGlobalReference(expected.lookupPath)
      : referenceFromPin(await this.#requirePin(expected.lookupPath));
    if (
      actual.selection !== expected.selection || actual.scopeRoot !== expected.scopeRoot ||
      actual.profileId !== expected.profileId || actual.pinPath !== expected.pinPath
    ) {
      throw new ZigProfileInvalidError(
        expected.profileId,
        `the effective ${expected.selection} profile pointer changed during the operation`,
      );
    }
    return actual;
  }

  #assertScopeOptions(options: { readonly path?: string; readonly global?: boolean }): void {
    if (options.global === true && options.path !== undefined) {
      throw new ZigInvalidArgumentError("global selection cannot be combined with a scope path");
    }
  }

  #activationRequired(): boolean {
    if (this.#env.ZM_SESSION_ACTIVE === "1") return false;
    return !pathContainsDirectory(this.#env.PATH, this.paths.globalBinDir, this.#cwd);
  }

  async #installPersistentResolvers(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal, "install persistent Zig and ZLS resolvers");
    await this.#shims.install();
    await this.#shims.installPersistent();
    throwIfAborted(signal, "install persistent Zig and ZLS resolvers");
  }

  async #scopeRoot(path?: string): Promise<string> {
    return await resolvePhysicalScopeDirectory(path ?? this.#cwd);
  }

  async #acquireScope(
    scopeRoot: string,
    operation: string,
    selector?: string,
    signal?: AbortSignal,
    operationId?: string,
  ) {
    return await this.#locks.acquireScope(await computeScopeOperationLockKey(scopeRoot), {
      operation,
      ...(operationId === undefined ? {} : { operationId }),
      scope: scopeRoot,
      ...(selector === undefined ? {} : { selector }),
      ...(signal === undefined ? {} : { signal }),
      wait: {},
    });
  }

  async #acquireGlobal(
    operation: string,
    selector?: string,
    signal?: AbortSignal,
  ) {
    return await this.#locks.acquireGlobal({
      operation,
      scope: this.paths.globalProfileFile,
      ...(selector === undefined ? {} : { selector }),
      ...(signal === undefined ? {} : { signal }),
      wait: {},
    });
  }

  async #fallbackExecutable(tool: "zig" | "zls"): Promise<string | null> {
    const pathValue = this.#env.ZM_SESSION_ACTIVE === "1" ? this.#env.ZM_BASE_PATH : this.#env.PATH;
    if (pathValue === undefined) return null;
    const shimExecutable = resolve(this.paths.shimsDir, tool);
    const persistentShimExecutable = resolve(this.paths.globalBinDir, tool);
    let physicalShim: string | null = null;
    let physicalPersistentShim: string | null = null;
    try {
      physicalShim = resolve(await Deno.realPath(shimExecutable));
    } catch (cause) {
      if (
        !(cause instanceof Deno.errors.NotFound) && !(cause instanceof Deno.errors.NotADirectory)
      ) {
        throw cause;
      }
    }
    try {
      physicalPersistentShim = resolve(await Deno.realPath(persistentShimExecutable));
    } catch (cause) {
      if (
        !(cause instanceof Deno.errors.NotFound) && !(cause instanceof Deno.errors.NotADirectory)
      ) {
        throw cause;
      }
    }
    for (const entry of pathValue.split(":")) {
      const base = entry.length === 0
        ? this.#cwd
        : isAbsolute(entry)
        ? entry
        : resolve(this.#cwd, entry);
      const candidate = resolve(base, tool);
      if (candidate === shimExecutable || candidate === persistentShimExecutable) continue;
      try {
        const physicalCandidate = resolve(await Deno.realPath(candidate));
        if (
          physicalCandidate === shimExecutable || physicalCandidate === physicalShim ||
          physicalCandidate === persistentShimExecutable ||
          physicalCandidate === physicalPersistentShim
        ) continue;
        const info = await Deno.stat(physicalCandidate);
        if (info.isFile && (info.mode === null || (info.mode & 0o111) !== 0)) return candidate;
      } catch (cause) {
        if (
          !(cause instanceof Deno.errors.NotFound) && !(cause instanceof Deno.errors.NotADirectory)
        ) {
          throw cause;
        }
      }
    }
    return null;
  }

  async #unlockTarget(value: string, path?: string): Promise<GlobalOperationLockTarget> {
    if (value === "source" || value === "catalog" || value === "global") {
      return { kind: value };
    }
    if (value === "scope") {
      const scopeRoot = await this.#scopeRoot(path);
      return { kind: "scope", scopeKey: await computeScopeOperationLockKey(scopeRoot) };
    }
    if (value.startsWith("install:")) {
      return {
        kind: "install",
        installationId: validateInstallationId(value.slice("install:".length)),
      };
    }
    throw new ZigInvalidArgumentError(
      "--unlock must be source, catalog, global, scope, or install:<installation-id>",
    );
  }

  async #assertHost(): Promise<void> {
    this.#hostPromise ??= Promise.resolve(this.#hostSupport(this.host));
    await this.#hostPromise;
  }

  async #config(): Promise<GlobalConfig> {
    this.#configPromise ??= this.#configStore.load();
    return await this.#configPromise;
  }

  async #source(): Promise<SourceWorkspaceService> {
    if (this.#sourceOverride !== undefined) return this.#sourceOverride;
    this.#sourcePromise ??= (async () => {
      return new SourceWorkspace({
        config: await this.#config(),
        cacheRoot: this.paths.cacheDir,
        stateRoot: this.paths.stateDir,
        sourceRoot: this.paths.sourcesDir,
        sourceRef: this.#sourceRef,
        lockManager: this.#locks,
        progress: this.#progress,
      });
    })();
    return await this.#sourcePromise;
  }

  async #zlsSource(): Promise<ZlsSourceWorkspaceService> {
    if (this.#zlsSourceOverride !== undefined) return this.#zlsSourceOverride;
    this.#zlsSourcePromise ??= Promise.resolve(
      new ZlsSourceWorkspace({
        cacheRoot: this.paths.cacheDir,
        stateRoot: this.paths.stateDir,
        sourceRoot: this.paths.sourcesDir,
        ...(this.#sourceRef === undefined ? {} : { sourceRef: this.#sourceRef }),
        lockManager: this.#locks,
        progress: this.#progress,
      }),
    );
    return await this.#zlsSourcePromise;
  }

  #effectiveConfig(config: GlobalConfig, selector: string): ResolvedZigManagerConfig {
    return {
      configPath: this.paths.configFile,
      projectRoot: this.paths.cacheDir,
      sourceRoot: this.paths.sourcesDir,
      repository: config.zigRepository,
      provider: "codeberg",
      name: "zig",
      selector,
      build: {
        strategy: "cmake",
        profile: config.build.profile,
        generator: config.build.generator,
        cmakePrefixPath: config.build.cmakePrefixPath,
        jobs: config.build.jobs,
        cpu: config.build.cpu,
      },
      docs: { mega: false },
      tools: config.tools,
      warnings: config.warnings,
    };
  }
}

function scopeRegistryStatus(
  path: string,
  inspection: ScopeRegistryInspection,
): ZigScopeRegistryStatus {
  if (!inspection.registryPresent) {
    return {
      path,
      state: "missing",
      entryCount: null,
      profilePruningSafe: false,
      reason: "the scope registry is missing, so the complete set of scope references is unknown",
    };
  }
  if (!inspection.profilePruningSafe) {
    const uncertain = inspection.entries
      .filter((entry) => entry.classification !== "live" || entry.profileMatches !== true)
      .map((entry) => entry.entry.scopeRoot);
    return {
      path,
      state: "uncertain",
      entryCount: inspection.entries.length,
      profilePruningSafe: false,
      reason: uncertain.length === 0
        ? "scope references could not be proven complete"
        : `scope references are uncertain for: ${uncertain.join(", ")}`,
    };
  }
  return {
    path,
    state: "healthy",
    entryCount: inspection.entries.length,
    profilePruningSafe: true,
    reason: null,
  };
}

function invalidRegistryStatus(path: string, cause: unknown): ZigScopeRegistryStatus {
  return {
    path,
    state: "invalid",
    entryCount: null,
    profilePruningSafe: false,
    reason: `the scope registry cannot be inspected safely: ${errorMessage(cause)}`,
  };
}

interface StagingCollection {
  readonly removed: readonly string[];
  readonly retained: readonly string[];
  readonly retainedRoots: ReadonlySet<string>;
}

async function collectAbandonedStaging(
  roots: readonly string[],
  locks: GlobalOperationLockOwnerEnumeration,
  dryRun: boolean,
  signal?: AbortSignal,
): Promise<StagingCollection> {
  const removed: string[] = [];
  const retained: string[] = [];
  const retainedRoots = new Set<string>();
  const active = new Set(locks.owners.map((entry) => entry.owner.operationId));
  const lockUncertainty = locks.uncertain.length === 0
    ? null
    : `lock ownership is unverifiable at: ${locks.uncertain.join(", ")}`;

  for (const root of roots) {
    throwIfAborted(signal, "inspect manager staging");
    let info: Deno.FileInfo | null;
    try {
      info = await Deno.lstat(root);
    } catch (cause) {
      if (cause instanceof Deno.errors.NotFound) continue;
      retained.push(`${root}: staging root could not be inspected safely`);
      retainedRoots.add(root);
      continue;
    }
    if (!info.isDirectory || info.isSymlink) {
      retained.push(`${root}: staging root is not a physical directory`);
      retainedRoots.add(root);
      continue;
    }
    try {
      if (resolve(await Deno.realPath(root)) !== resolve(root)) {
        retained.push(`${root}: staging root traverses a symbolic link`);
        retainedRoots.add(root);
        continue;
      }
      const entries: Deno.DirEntry[] = [];
      for await (const entry of Deno.readDir(root)) entries.push(entry);
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        throwIfAborted(signal, "inspect manager staging");
        const path = join(root, entry.name);
        if (!OPERATION_UUID.test(entry.name)) {
          retained.push(`${path}: staging operation ID is not a canonical UUID`);
          retainedRoots.add(root);
          continue;
        }
        if (!entry.isDirectory || entry.isSymlink) {
          retained.push(`${path}: staging entry is not a physical directory`);
          retainedRoots.add(root);
          continue;
        }
        if (lockUncertainty !== null) {
          retained.push(`${path}: ${lockUncertainty}`);
          retainedRoots.add(root);
          continue;
        }
        if (active.has(entry.name)) {
          retained.push(`${path}: operation ${entry.name} has a retained lock owner`);
          retainedRoots.add(root);
          continue;
        }
        if (!await stagingTreeIsPhysical(path, signal)) {
          retained.push(`${path}: staging contents could not be verified without symlinks`);
          retainedRoots.add(root);
          continue;
        }
        if (!dryRun) {
          throwIfAborted(signal, "remove abandoned manager staging");
          const current = await Deno.lstat(path);
          if (
            !current.isDirectory || current.isSymlink ||
            resolve(await Deno.realPath(path)) !== resolve(path)
          ) {
            retained.push(`${path}: staging entry changed before removal`);
            retainedRoots.add(root);
            continue;
          }
          await Deno.remove(path, { recursive: true });
        }
        removed.push(path);
      }
    } catch (cause) {
      if (cause instanceof ZigOperationAbortedError) throw cause;
      retained.push(`${root}: staging entries could not be enumerated safely`);
      retainedRoots.add(root);
    }
  }
  return {
    removed: [...new Set(removed)].sort(),
    retained: [...new Set(retained)].sort(),
    retainedRoots,
  };
}

async function stagingTreeIsPhysical(path: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const root = resolve(path);
    const info = await Deno.lstat(root);
    if (!info.isDirectory || info.isSymlink || resolve(await Deno.realPath(root)) !== root) {
      return false;
    }
    const pending = [root];
    while (pending.length > 0) {
      throwIfAborted(signal, "inspect manager staging");
      const directory = pending.pop()!;
      for await (const entry of Deno.readDir(directory)) {
        throwIfAborted(signal, "inspect manager staging");
        const child = join(directory, entry.name);
        const childInfo = await Deno.lstat(child);
        if (childInfo.isSymlink) return false;
        if (childInfo.isDirectory) pending.push(child);
        else if (!childInfo.isFile) return false;
      }
    }
    return true;
  } catch (cause) {
    if (cause instanceof ZigOperationAbortedError) throw cause;
    return false;
  }
}

async function removePhysicalTree(
  path: string,
  dryRun: boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  throwIfAborted(signal, "remove manager-owned tree");
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return false;
    throw cause;
  }
  if (!info.isDirectory || info.isSymlink) {
    throw new ZigInvalidArgumentError(
      `Refusing to remove a manager root that is not a physical directory: ${path}`,
      { path },
    );
  }
  if (resolve(await Deno.realPath(path)) !== resolve(path)) {
    throw new ZigInvalidArgumentError(
      `Refusing to remove a manager root that traverses a symbolic link: ${path}`,
      { path },
    );
  }
  if (dryRun) return true;
  try {
    throwIfAborted(signal, "remove manager-owned tree");
    await Deno.remove(path, { recursive: true });
    return true;
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return false;
    throw cause;
  }
}

async function assertOnlyPurgeLocks(
  locksRoot: string,
  sourceLock: string,
  catalogLock: string,
  globalLock: string,
): Promise<void> {
  await assertPhysicalRemovalDirectory(locksRoot);
  const allowedLocks = new Set([resolve(sourceLock), resolve(catalogLock), resolve(globalLock)]);
  const entries: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(locksRoot)) entries.push(entry);
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const path = join(locksRoot, entry.name);
    if (allowedLocks.has(resolve(path))) {
      await assertPhysicalRemovalDirectory(path);
      continue;
    }
    if (entry.name === "scopes" || entry.name === "installs") {
      await assertPhysicalRemovalDirectory(path);
      for await (const child of Deno.readDir(path)) {
        throw new ZigInvalidArgumentError(
          `Purge refused because another or uncertain operation lock exists: ${
            join(path, child.name)
          }`,
          { lockPath: join(path, child.name) },
        );
      }
      continue;
    }
    throw new ZigInvalidArgumentError(
      `Purge refused because another or uncertain operation lock exists: ${path}`,
      { lockPath: path },
    );
  }
}

async function removeStateContentsExceptLocks(
  stateRoot: string,
  locksRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  await assertPhysicalRemovalDirectory(stateRoot);
  const entries: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(stateRoot)) entries.push(entry);
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    throwIfAborted(signal, "remove manager state");
    const path = join(stateRoot, entry.name);
    if (resolve(path) === resolve(locksRoot)) continue;
    const info = await Deno.lstat(path);
    throwIfAborted(signal, "remove manager state");
    await Deno.remove(path, { recursive: info.isDirectory && !info.isSymlink });
  }
}

async function removeEmptyStateRoot(stateRoot: string, locksRoot: string): Promise<boolean> {
  for (const category of [join(locksRoot, "scopes"), join(locksRoot, "installs")]) {
    await removeEmptyPhysicalDirectoryIfPresent(category);
  }
  await removeEmptyPhysicalDirectoryIfPresent(locksRoot);
  return await removeEmptyPhysicalDirectoryIfPresent(stateRoot);
}

async function removeEmptyPhysicalDirectoryIfPresent(path: string): Promise<boolean> {
  try {
    await assertPhysicalRemovalDirectory(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return false;
    throw cause;
  }
  try {
    await Deno.remove(path);
    return true;
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return false;
    throw cause;
  }
}

async function assertPhysicalRemovalDirectory(path: string): Promise<void> {
  const info = await Deno.lstat(path);
  if (!info.isDirectory || info.isSymlink) {
    throw new ZigInvalidArgumentError(
      `Managed state path is not a physical directory: ${path}`,
      { path },
    );
  }
  if (resolve(await Deno.realPath(path)) !== resolve(path)) {
    throw new ZigInvalidArgumentError(
      `Managed state path traverses a symbolic link: ${path}`,
      { path },
    );
  }
}

function pathIsWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function sourceStateFromPrepared(prepared: PreparedSource): SourceSelectionState {
  return {
    selector: prepared.source.requestedSelector,
    version: prepared.version,
    ref: { ...prepared.checkout.requested },
    commit: prepared.source.commit,
    repositoryHome: prepared.repositoryHome,
    checkoutPath: prepared.checkoutPath,
  };
}

function componentResult(
  installed: InstalledObject,
  source: ResolvedSource,
  reused: boolean,
): ZigManagedComponentResult {
  return {
    component: installed.manifest.component,
    selector: source.requestedSelector,
    installationId: installed.manifest.installationId,
    version: source.version,
    commit: source.commit,
    executable: installed.executablePath,
    reused,
  };
}

function installResult(
  selection: InstalledSelection,
  profileId?: string,
): ZigInstallResult {
  const zig = componentResult(
    selection.zig.installed,
    selection.zig.source,
    selection.zig.reused,
  );
  const zls = componentResult(
    selection.zls.installed,
    selection.zls.source,
    selection.zls.reused,
  );
  return {
    schemaVersion: 2,
    selector: zig.selector,
    installationId: zig.installationId,
    version: zig.version,
    commit: zig.commit,
    executable: zig.executable,
    reused: zig.reused && zls.reused,
    ...(profileId === undefined ? {} : { profileId }),
    zig,
    zls,
  };
}

function useResult(
  selection: InstalledSelection,
  profile: ProfileCreateResult,
  pin: { readonly scopeRoot: string | null; readonly pinPath: string },
  activationRequired: boolean,
  origin: "local" | "global",
): ZigUseResult {
  return {
    ...installResult(selection, profile.profile.profileId),
    profileId: profile.profile.profileId,
    scopeRoot: pin.scopeRoot,
    pinPath: pin.pinPath,
    activationRequired,
    selection: origin,
  };
}

function useResultFromStored(
  stored: StoredToolchainProfile,
  pin: { readonly scopeRoot: string | null; readonly pinPath: string },
  activationRequired: boolean,
  origin: "local" | "global",
): ZigUseResult {
  const zig: ZigManagedComponentResult = {
    component: "zig",
    selector: stored.profile.source.requestedSelector,
    installationId: stored.profile.components.zig,
    version: stored.profile.source.version,
    commit: stored.profile.source.commit,
    executable: stored.zigPath,
    reused: true,
  };
  const zls: ZigManagedComponentResult | null = isPairedToolchainProfile(stored.profile) &&
      stored.zlsPath !== null
    ? {
      component: "zls",
      selector: stored.profile.zlsSource.requestedSelector,
      installationId: stored.profile.components.zls,
      version: stored.profile.zlsSource.version,
      commit: stored.profile.zlsSource.commit,
      executable: stored.zlsPath,
      reused: true,
    }
    : null;
  return {
    schemaVersion: 2,
    selector: zig.selector,
    installationId: zig.installationId,
    version: zig.version,
    commit: zig.commit,
    executable: zig.executable,
    reused: zls === null || zls.reused,
    profileId: stored.profile.profileId,
    zig,
    zls,
    scopeRoot: pin.scopeRoot,
    pinPath: pin.pinPath,
    activationRequired,
    selection: origin,
  };
}

function syncResult(
  stored: StoredToolchainProfile,
  reference: ProfileReference,
  rebuilt: boolean,
  zigRebuilt: boolean,
  zlsRebuilt: boolean,
): ZigSyncResult {
  const zig: ZigManagedComponentResult = {
    component: "zig",
    selector: stored.profile.source.requestedSelector,
    installationId: stored.profile.components.zig,
    version: stored.profile.source.version,
    commit: stored.profile.source.commit,
    executable: stored.zigPath,
    reused: !zigRebuilt,
  };
  const zls: ZigManagedComponentResult | null = isPairedToolchainProfile(stored.profile) &&
      stored.zlsPath !== null
    ? {
      component: "zls",
      selector: stored.profile.zlsSource.requestedSelector,
      installationId: stored.profile.components.zls,
      version: stored.profile.zlsSource.version,
      commit: stored.profile.zlsSource.commit,
      executable: stored.zlsPath,
      reused: !zlsRebuilt,
    }
    : null;
  return {
    schemaVersion: 2,
    selection: reference.selection,
    scopeRoot: reference.scopeRoot,
    profileId: stored.profile.profileId,
    installationId: zig.installationId,
    executable: zig.executable,
    rebuilt,
    zig,
    zls,
  };
}

function toolStatus(
  component: "zig" | "zls",
  installationId: string,
  source: ResolvedSource,
  executable: string,
): ZigManagerToolStatus {
  return {
    component,
    installationId,
    selector: source.requestedSelector,
    version: source.version,
    commit: source.commit,
    executable,
  };
}

function fallbackToolStatus(
  component: "zig" | "zls",
  executable: string | null,
): ZigManagerToolStatus {
  return {
    component,
    installationId: null,
    selector: null,
    version: null,
    commit: null,
    executable,
  };
}

function referenceFromPin(pin: ResolvedScopePin): ProfileReference {
  return {
    selection: "local",
    lookupPath: pin.lookupPath,
    scopeRoot: pin.scopeRoot,
    pinPath: pin.pinPath,
    profileId: pin.profileId,
  };
}

function profileOperationScope(reference: ProfileReference): string {
  return reference.scopeRoot ?? dirname(reference.pinPath);
}

function sourceCycle(
  value: string,
  component: string,
): { readonly major: number; readonly minor: number } {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.exec(value);
  if (match === null) throw new TypeError(`${component} source base is not a strict version`);
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)) {
    throw new TypeError(`${component} source cycle is outside the supported integer range`);
  }
  return { major, minor };
}

function sameSourceObservation(left: ResolvedSource, right: ResolvedZlsSource): boolean {
  if (left.component !== "zls") return false;
  const projection = (source: ResolvedSource) => ({
    component: source.component,
    repository: source.repository,
    requestedSelector: source.requestedSelector,
    resolvedRef: source.resolvedRef,
    commit: source.commit,
    version: source.version,
    versionMetadata: source.versionMetadata,
  });
  return canonicalJson(projection(left)) === canonicalJson(projection(right));
}

function isZlsProtocolVerifier(
  value: ProcessRunner,
): value is ProcessRunner & ZlsLspProtocolVerifier {
  const candidate = value as ProcessRunner & Partial<ZlsLspProtocolVerifier>;
  return Number.isSafeInteger(candidate.contractVersion) && typeof candidate.verify === "function";
}

function isMovingSelector(selector: string): boolean {
  return selector === "latest" || selector === "stable" || selector.startsWith("branch:") ||
    /^[0-9]+\.[0-9]+$/.test(selector);
}

function assertBash(shell: string): void {
  if (shell !== "bash") throw new ZigShellUnsupportedError(shell);
}

async function assertArchLinuxX86_64(host: ZigManagerHost): Promise<void> {
  if (
    host.os !== "linux" || host.architecture !== "x86_64" || host.abi !== "gnu" ||
    host.denoTarget !== "x86_64-unknown-linux-gnu"
  ) {
    throw new ZigHostUnsupportedError(
      "the initial runtime requires the exact x86_64-unknown-linux-gnu Deno target",
      { host },
    );
  }
  let osRelease: string;
  try {
    osRelease = await Deno.readTextFile("/etc/os-release");
  } catch (cause) {
    throw new ZigHostUnsupportedError("/etc/os-release could not be read", { host, cause });
  }
  const id = /^ID=(?:"([^"]+)"|'([^']+)'|([^\s]+))$/m.exec(osRelease);
  if ((id?.[1] ?? id?.[2] ?? id?.[3]) !== "arch") {
    throw new ZigHostUnsupportedError("the initial runtime requires Arch Linux", { host });
  }
}

function inferAbi(target: string): string {
  if (target.includes("-gnu")) return "gnu";
  if (target.includes("-musl")) return "musl";
  return "unknown";
}

function runtimePlatform(): PlatformPathPlatform {
  if (Deno.build.os === "linux" || Deno.build.os === "darwin" || Deno.build.os === "windows") {
    return Deno.build.os;
  }
  throw new ZigHostUnsupportedError(`runtime platform '${Deno.build.os}' is unsupported`);
}

function normalizeAbsolute(path: string, label: string): string {
  if (path.length === 0 || /\p{Cc}/u.test(path)) {
    throw new ZigInvalidArgumentError(`${label} must not be empty or contain controls`);
  }
  const normalized = resolve(path);
  if (!isAbsolute(path)) throw new ZigInvalidArgumentError(`${label} must be absolute`);
  return normalized;
}

function pathContainsDirectory(
  pathValue: string | undefined,
  directory: string,
  cwd: string,
): boolean {
  if (pathValue === undefined) return false;
  return pathValue.split(":").some((entry) => {
    const candidate = entry.length === 0 ? cwd : entry;
    return resolve(candidate) === directory;
  });
}

function redactedEffectiveConfig(config: GlobalConfig): RedactedEffectiveGlobalConfig {
  return {
    zigRepository: redactUrl(config.zigRepository),
    build: {
      profile: config.build.profile,
      generator: config.build.generator,
      jobs: config.build.jobs,
      cpu: config.build.cpu,
      cmakePrefixPath: config.build.cmakePrefixPath,
    },
    tools: { ...config.tools },
    warnings: { ...config.warnings },
  };
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    const authentication = url.username !== "" || url.password !== "" ? "<redacted>@" : "";
    const query = url.search === "" ? "" : "?<redacted>";
    const fragment = url.hash === "" ? "" : "#<redacted>";
    return `${url.protocol}//${authentication}${url.host}${url.pathname}${query}${fragment}`;
  } catch {
    return "<redacted-invalid-url>";
  }
}

function doctorFailureFinding(cause: unknown, selector: string | null): DiagnosticFinding {
  const publicCode = errorCode(cause);
  const publicDetails = errorDetails(cause);
  let code: DiagnosticFinding["code"] = "ZIG_SOURCE_RESOLUTION_FAILED";
  let remediation = "Repair the exact source checkout and rerun doctor.";
  if (publicCode === "ZIG_RELEASE_UNSUPPORTED") {
    code = "ZIG_RELEASE_UNSUPPORTED";
    remediation =
      "Use a source version with a tested adapter or upgrade zig-manager; no nearest adapter is selected.";
  } else if (publicCode === "ZIG_SOURCE_NOT_READY") {
    code = "ZIG_SOURCE_NOT_READY";
  } else if (publicCode === "ZIG_PROFILE_NOT_FOUND") {
    code = "ZIG_PROFILE_NOT_FOUND";
    remediation = "Repair or replace the explicit local or global profile pointer.";
  } else if (publicCode === "ZIG_PROFILE_INVALID") {
    code = "ZIG_PROFILE_INVALID";
    remediation = "Repair or replace the explicit local or global profile pointer.";
  } else if (publicCode === "ZIG_INSTALL_NOT_FOUND") {
    code = "ZIG_INSTALL_NOT_FOUND";
    remediation = "Repair or rebuild the immutable installation referenced by the pin.";
  } else if (publicCode === "ZIG_INSTALL_CORRUPT") {
    code = "ZIG_INSTALL_CORRUPT";
    remediation = "Repair or rebuild the immutable installation referenced by the pin.";
  } else if (selector === "latest") {
    code = "ZIG_REMOTE_HEAD_UNAVAILABLE";
    remediation =
      "Restore access to the canonical repository's symbolic remote HEAD and rerun doctor.";
  }
  return createDiagnosticFinding({
    severity: "error",
    code,
    component: "Zig source",
    summary: errorMessage(cause),
    required: selector === null ? "an exact stored source" : `source selector ${selector}`,
    found: code === "ZIG_RELEASE_UNSUPPORTED"
      ? {
        version: publicDetails.version ?? null,
        commit: publicDetails.commit ?? null,
      }
      : publicCode,
    checkedPaths: [],
    remediation,
    details: { code: publicCode, ...publicDetails },
  });
}

function rethrowAbort(cause: unknown): void {
  if (errorCode(cause) === "ZIG_OPERATION_ABORTED") throw cause;
}

function readManagerEnvironment(): Readonly<Record<string, string | undefined>> {
  const result: Record<string, string | undefined> = {};
  for (
    const name of [
      "HOME",
      "PATH",
      "DENO_INSTALL_ROOT",
      "XDG_CONFIG_HOME",
      "XDG_STATE_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "ZIG_MANAGER_HOME",
      "ZM_SESSION_ACTIVE",
      "ZM_BASE_PATH",
      "ZM_SHIM_DIR",
      "ZIG_MANAGER_ZIG_REPOSITORY",
      "ZIG_MANAGER_BUILD_PROFILE",
      "ZIG_MANAGER_BUILD_GENERATOR",
      "ZIG_MANAGER_BUILD_JOBS",
      "ZIG_MANAGER_BUILD_CPU",
      "ZIG_MANAGER_CMAKE_PREFIX_PATH",
      "ZIG_MANAGER_CMAKE",
      "ZIG_MANAGER_CC",
      "ZIG_MANAGER_CXX",
      "ZIG_MANAGER_LLVM_CONFIG",
      "ZIG_MANAGER_CLANG",
      "ZIG_MANAGER_LLD",
      "ZIG_MANAGER_GENERATOR_TOOL",
      "ZIG_MANAGER_WARNING_CACHE_BYTES",
      "ZIG_MANAGER_MOVING_SELECTOR_MAX_AGE_HOURS",
      "BASH_FUNC_zig%%",
      "CC",
      "CXX",
    ]
  ) {
    try {
      result[name] = Deno.env.get(name);
    } catch {
      result[name] = undefined;
    }
  }
  return result;
}

function errorCode(cause: unknown): string | null {
  if (cause === null || typeof cause !== "object") return null;
  const value = (cause as { readonly code?: unknown }).code;
  return typeof value === "string" ? value : null;
}

function errorDetail(cause: unknown, key: string): string | null {
  if (cause === null || typeof cause !== "object") return null;
  const details = (cause as { readonly details?: unknown }).details;
  if (details === null || typeof details !== "object" || Array.isArray(details)) return null;
  const value = (details as Readonly<Record<string, unknown>>)[key];
  return typeof value === "string" ? value : null;
}

function errorDetails(cause: unknown): Readonly<Record<string, unknown>> {
  if (cause === null || typeof cause !== "object") return {};
  const details = (cause as { readonly details?: unknown }).details;
  return details !== null && typeof details === "object" && !Array.isArray(details)
    ? details as Readonly<Record<string, unknown>>
    : {};
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function throwIfAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted) {
    throw new ZigOperationAbortedError(operation, {}, { cause: signal.reason });
  }
}
