import type {
  CheckoutResult,
  DescribeRevisionOptions,
  DoctorResult as SourceRefDoctorResult,
  EnsureRequest,
  GitRef,
  ListRemoteRefsRequest,
  PathOptions,
  RemoteHead,
  RemoteRef,
  RepositorySelector,
  RepositoryStatus,
  ResolveRemoteHeadRequest,
  RevisionDescription,
  StatusOptions,
  SyncOptions,
  UpdateOptions,
} from "@zignado/source-ref";
import type { ZigBuildRecipeV1 } from "./build_recipe.ts";

export type ZigBuildStrategy = "cmake";
export type ZigBuildProfile = "debug" | "release" | "relwithdebinfo" | "minsizerel";

export interface ZigManagerToolConfig {
  readonly cmake: string | null;
  readonly cCompiler: string | null;
  readonly cxxCompiler: string | null;
  readonly llvmConfig: string | null;
  readonly clang: string | null;
  readonly lld: string | null;
  readonly generatorTool: string | null;
}

export interface ZigManagerBuildConfig {
  readonly strategy: ZigBuildStrategy;
  readonly profile: ZigBuildProfile;
  readonly generator: string;
  readonly cmakePrefixPath: string | null;
  readonly jobs: number | null;
  /** Legacy project documents omit this and resolve to baseline. */
  readonly cpu?: "baseline" | "native";
}

export interface ZigManagerDocsConfig {
  readonly mega: boolean;
}

/** Strict persisted shape of the root zig-manager.json file. */
export interface ZigManagerConfig {
  readonly $schema?: string;
  readonly sourceRoot: string;
  readonly repository: string;
  readonly provider: string;
  readonly name: string;
  readonly selector: string;
  readonly build: ZigManagerBuildConfig;
  readonly docs: ZigManagerDocsConfig;
  readonly tools?: Partial<ZigManagerToolConfig>;
}

/** Fully validated and path-normalized configuration used by the manager. */
export interface ResolvedZigManagerConfig {
  readonly configPath: string;
  readonly projectRoot: string;
  readonly sourceRoot: string;
  readonly repository: string;
  readonly provider: string;
  readonly name: string;
  readonly selector: string;
  readonly build: ZigManagerBuildConfig;
  readonly docs: ZigManagerDocsConfig;
  readonly tools: ZigManagerToolConfig;
  readonly warnings: ZigManagerWarningConfig;
}

export interface ZigManagerWarningConfig {
  readonly cacheBytes: number | null;
  readonly movingSelectorMaxAgeHours: number;
}

export interface ZigSemanticVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly text: string;
}

export type ZigSelector =
  | { readonly kind: "exact"; readonly value: string; readonly version: ZigSemanticVersion }
  | {
    readonly kind: "minor";
    readonly value: string;
    readonly major: number;
    readonly minor: number;
  }
  | { readonly kind: "tag"; readonly value: string }
  | { readonly kind: "branch"; readonly value: string }
  | { readonly kind: "commit"; readonly value: string };

export interface ResolvedZigSelection {
  readonly selector: string;
  readonly ref: GitRef;
  readonly remoteCommit: string;
}

export interface ZigSourceVersion {
  readonly kind: "release" | "development";
  readonly base: string;
  readonly text: string;
  readonly taggedAncestor: string;
  readonly commitsAfterTag: number;
  readonly commitAbbreviation: string;
}

export interface SourceSelectionState {
  readonly selector: string;
  readonly version: ZigSourceVersion;
  readonly ref: GitRef;
  readonly commit: string;
  readonly repositoryHome: string;
  readonly checkoutPath: string;
}

export interface ActiveBuildState {
  readonly commit: string;
  readonly identity: string;
  readonly manifestPath: string;
  readonly executablePath: string;
}

export interface ActiveDocsState {
  readonly commit: string;
  readonly manifestPath: string;
  readonly directory: string;
  readonly megaPath: string | null;
}

export interface ZigManagerState {
  readonly schemaVersion: 2;
  readonly source: SourceSelectionState | null;
  readonly activeBuild: ActiveBuildState | null;
  readonly docs: ActiveDocsState | null;
}

export interface ProcessRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly clearEnv?: boolean;
  readonly stdin?: "inherit" | "null";
  readonly signal?: AbortSignal;
  readonly maxDiagnosticBytes?: number;
  readonly onStdout?: (chunk: Uint8Array) => void | Promise<void>;
  readonly onStderr?: (chunk: Uint8Array) => void | Promise<void>;
}

export interface ProcessStatus {
  readonly success: boolean;
  readonly code: number;
  readonly signal: Deno.Signal | null;
}

export interface ProcessResult extends ProcessStatus {
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>;
}

/** Structural source-ref boundary used for dependency injection and offline tests. */
export interface SourceRefApi {
  resolveRemoteHead(request: ResolveRemoteHeadRequest): Promise<RemoteHead>;
  listRemoteRefs(request: ListRemoteRefsRequest): Promise<RemoteRef[]>;
  describeRevision(
    selector: RepositorySelector,
    options?: DescribeRevisionOptions,
  ): Promise<RevisionDescription>;
  ensure(request: EnsureRequest): Promise<CheckoutResult>;
  sync(selector?: RepositorySelector, options?: SyncOptions): Promise<CheckoutResult[]>;
  update(selector: RepositorySelector, options?: UpdateOptions): Promise<CheckoutResult>;
  doctor(signal?: AbortSignal): Promise<SourceRefDoctorResult>;
  status(selector?: RepositorySelector, options?: StatusOptions): Promise<RepositoryStatus[]>;
  path(selector: RepositorySelector, options?: PathOptions): string;
}

export interface ToolProbeResult {
  readonly name: string;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly checkedCandidates: readonly string[];
  readonly explicit: boolean;
  readonly available: boolean;
  readonly version: string | null;
  readonly supported: boolean;
  readonly required: string;
  readonly message: string | null;
}

export interface BuildToolchain {
  readonly cmake: ToolProbeResult;
  readonly cCompiler: ToolProbeResult;
  readonly cxxCompiler: ToolProbeResult;
  readonly llvmConfig: ToolProbeResult;
  readonly clang: ToolProbeResult;
  readonly lld: ToolProbeResult;
  readonly generatorTool: ToolProbeResult | null;
  readonly cmakePrefixPath: string;
  readonly llvmIncludeDir: string | null;
  readonly llvmLibDir: string | null;
}

export type DiagnosticSeverity = "error" | "warning" | "info";

export type DiagnosticCode =
  | "ZIG_HOST_UNSUPPORTED"
  | "ZIG_ARCH_ID_UNSUPPORTED"
  | "ZIG_CONFIG_INVALID"
  | "ZIG_SOURCE_REF_UNAVAILABLE"
  | "ZIG_GIT_UNAVAILABLE"
  | "ZIG_GIT_INCOMPATIBLE"
  | "ZIG_REMOTE_HEAD_UNAVAILABLE"
  | "ZIG_SOURCE_RESOLUTION_FAILED"
  | "ZIG_SOURCE_NOT_READY"
  | "ZIG_RELEASE_UNSUPPORTED"
  | "ZIG_TOOL_MISSING"
  | "ZIG_TOOL_VERSION_INCOMPATIBLE"
  | "ZIG_GENERATOR_UNAVAILABLE"
  | "ZIG_GENERATOR_UNSUPPORTED"
  | "ZIG_DEVELOPMENT_FILES_MISSING"
  | "ZIG_LLVM_TARGETS_MISSING"
  | "ZIG_PATH_UNWRITABLE"
  | "ZIG_DISK_INSUFFICIENT"
  | "ZIG_DISK_LOW"
  | "ZIG_DISK_UNKNOWN"
  | "ZIG_MEMORY_LOW"
  | "ZIG_MEMORY_UNKNOWN"
  | "ZIG_SESSION_INACTIVE"
  | "ZIG_SESSION_INCOHERENT"
  | "ZIG_FALLBACK_NOT_FOUND"
  | "ZIG_FALLBACK_UNUSABLE"
  | "ZIG_SHELL_PRECEDENCE"
  | "ZIG_TOOL_OVERRIDE"
  | "ZIG_DEVELOPMENT_SOURCE"
  | "ZIG_CACHE_LARGE"
  | "ZIG_CACHE_SIZE_UNKNOWN"
  | "ZIG_MOVING_SELECTOR_STALE"
  | "ZIG_MOVING_SELECTOR_AGE_UNKNOWN"
  | "ZIG_SCOPE_INVALID"
  | "ZIG_PROFILE_NOT_FOUND"
  | "ZIG_PROFILE_INVALID"
  | "ZIG_INSTALL_NOT_FOUND"
  | "ZIG_INSTALL_CORRUPT"
  | "ZIG_BINARY_VERIFICATION_FAILED";

export interface DiagnosticCommandData {
  readonly displayOnly: true;
  readonly executable: string;
  readonly args: readonly string[];
  readonly warning: string;
}

export interface VerifiedArchPackageHint {
  readonly manager: "pacman";
  readonly name: string;
  readonly repository: string;
  readonly version: string;
  readonly installedVersion: string | null;
  readonly verified: true;
}

export interface DiagnosticFinding {
  readonly severity: DiagnosticSeverity;
  readonly code: DiagnosticCode;
  readonly component: string;
  readonly summary: string;
  readonly required: unknown;
  readonly found: unknown;
  readonly checkedPaths: readonly string[];
  readonly remediation: string;
  readonly command?: DiagnosticCommandData;
  readonly packageHints: readonly VerifiedArchPackageHint[];
  readonly details: Readonly<Record<string, unknown>>;
}

export interface DiagnosticCounts {
  readonly errors: number;
  readonly warnings: number;
  readonly info: number;
}

export type DiagnosticFilesystemKind = "cache-build" | "data-staging" | "scope";

export interface DiagnosticFilesystemResult {
  readonly kind: DiagnosticFilesystemKind;
  readonly path: string;
  readonly checkedPath: string;
  readonly writable: boolean;
  readonly availableBytes: number | null;
  readonly minimumBytes: number;
  readonly recommendedBytes: number;
  readonly message: string | null;
}

export interface DiagnosticMemoryResult {
  readonly totalBytes: number | null;
  readonly availableBytes: number | null;
  readonly recommendedBytes: number;
  readonly message: string | null;
}

export interface DiagnosticCacheResult {
  readonly path: string;
  readonly thresholdBytes: number | null;
  readonly measuredBytes: number | null;
  readonly complete: boolean | null;
  readonly message: string | null;
}

export interface DiagnosticResourceResult {
  readonly filesystems: readonly DiagnosticFilesystemResult[];
  readonly memory: DiagnosticMemoryResult;
  readonly cache: DiagnosticCacheResult;
}

export interface DiagnosticFallbackResult {
  readonly path: string | null;
  readonly version: string | null;
  readonly usable: boolean;
  readonly arguments: readonly ["version"];
  readonly message: string | null;
}

export interface DiagnosticSessionResult {
  readonly active: boolean;
  readonly pinRelevant: boolean;
  readonly expectedShimDirectory: string;
  readonly configuredShimDirectory: string | null;
  readonly basePath: string | null;
  readonly pathStartsWithShim: boolean;
  readonly coherent: boolean;
  readonly fallback: DiagnosticFallbackResult;
  readonly precedence: "path" | "function" | "unknown";
}

export interface ZigManagerHostDiagnostic extends ZigManagerHost {
  readonly supported: boolean;
  readonly distributionId: string | null;
  readonly required: {
    readonly os: "linux";
    readonly architecture: "x86_64";
    readonly abi: "gnu";
    readonly denoTarget: "x86_64-unknown-linux-gnu";
    readonly distributionId: "arch";
  };
  readonly checkedPaths: readonly ["/etc/os-release"];
}

export interface RedactedEffectiveGlobalConfig {
  readonly zigRepository: string;
  readonly build: {
    readonly profile: ZigBuildProfile;
    readonly generator: string;
    readonly jobs: number | null;
    readonly cpu: "baseline" | "native";
    readonly cmakePrefixPath: string | null;
  };
  readonly tools: ZigManagerToolConfig;
  readonly warnings: ZigManagerWarningConfig;
}

export interface DiagnosticSourceResult {
  readonly selector: string;
  readonly version: string;
  readonly commit: string;
  readonly kind: "release" | "development";
  readonly resolvedAt: string;
}

export interface DiagnosticVerificationResult {
  readonly requested: true;
  readonly level: "full-install";
  readonly ok: boolean;
  readonly compilesAndRuns: boolean;
  readonly summary: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface ZigDoctorResult {
  readonly schemaVersion: 2;
  readonly strict: boolean;
  readonly ok: boolean;
  readonly buildReady: boolean;
  readonly counts: DiagnosticCounts;
  readonly errors: number;
  readonly warnings: number;
  readonly info: number;
  readonly adapter: string;
  readonly sourceRef: SourceRefDoctorResult | null;
  readonly toolchain: BuildToolchain;
  readonly resources: DiagnosticResourceResult;
  readonly findings: readonly DiagnosticFinding[];
}

export interface NormalizedBuildOptions {
  readonly strategy: "cmake";
  readonly profile: ZigBuildProfile;
  readonly cmakeBuildType: "Debug" | "Release" | "RelWithDebInfo" | "MinSizeRel";
  readonly generator: string;
  readonly jobs: number | null;
  readonly cmakePrefixPath: string;
  readonly cpu: "baseline" | "native";
}

export interface BuildIdentityInput {
  readonly sourceCommit: string;
  readonly hostTarget: string;
  readonly options: NormalizedBuildOptions;
  readonly tools: {
    readonly cmake: { readonly path: string; readonly version: string };
    readonly cCompiler: { readonly path: string; readonly version: string };
    readonly cxxCompiler: { readonly path: string; readonly version: string };
    readonly llvmConfig: { readonly path: string; readonly version: string };
    readonly clang: { readonly path: string; readonly version: string };
    readonly lld: { readonly path: string; readonly version: string };
    readonly generatorTool: { readonly path: string; readonly version: string } | null;
  };
}

export interface CommandRecord {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly clearEnv: true;
}

export interface BuildArtifactPaths {
  readonly root: string;
  readonly cmakeBuild: string;
  readonly install: string;
  readonly cache: string;
  readonly logs: string;
  readonly executable: string;
  readonly lib: string;
}

export interface BuildManifest {
  readonly schemaVersion: 2;
  readonly identity: string;
  readonly recipe: ZigBuildRecipeV1;
  readonly source: {
    readonly selector: string;
    readonly version: ZigSourceVersion;
    readonly commit: string;
  };
  readonly hostTarget: string;
  readonly configuration: BuildIdentityInput;
  readonly paths: BuildArtifactPaths;
  readonly commands: readonly CommandRecord[];
  readonly compiler: {
    readonly version: string;
    readonly sha256: string;
    readonly size: number;
  };
  readonly verified: true;
}

export interface BuildResult {
  readonly manifest: BuildManifest;
  readonly reused: boolean;
}

export interface DocsArtifact {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface MegaDocsRecord {
  readonly formatVersion: 1;
  readonly assetContract: string;
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface DocsManifest {
  readonly schemaVersion: 2;
  readonly source: {
    readonly selector: string;
    readonly version: ZigSourceVersion;
    readonly commit: string;
    readonly checkoutPath: string;
  };
  readonly compiler: {
    readonly path: string;
    readonly version: string;
    readonly sha256: string;
  };
  readonly buildIdentity: string;
  readonly outputPath: string;
  readonly command: CommandRecord;
  readonly artifacts: readonly DocsArtifact[];
  readonly mega: MegaDocsRecord | null;
}

export interface DocsResult {
  readonly manifest: DocsManifest;
}

export interface ManagedZigEnvironment {
  readonly executable: string;
  readonly binDirectory: string;
  readonly pathPrepend: readonly string[];
  readonly variables: Readonly<Record<string, string>>;
}

export interface ArtifactStatus {
  readonly selected: boolean;
  readonly commit: string | null;
  readonly stale: boolean;
  readonly valid: boolean;
  readonly path: string | null;
  readonly message: string | null;
}

export interface ZigManagerStatus {
  readonly schemaVersion: 1 | 2;
  readonly lookupPath: string;
  readonly mode: "managed" | "fallback";
  /** Present in schema v2 and identifies the winning selection layer. */
  readonly selection?: "local" | "global" | "fallback";
  readonly scopeRoot: string | null;
  readonly pinPath: string | null;
  readonly profileId: string | null;
  readonly installationId: string | null;
  readonly selector: string | null;
  readonly version: string | null;
  readonly commit: string | null;
  readonly executable: string | null;
  /** Present in schema v2. The top-level component fields remain Zig aliases. */
  readonly zig?: ZigManagerToolStatus;
  /** Present in schema v2. Managed profiles never borrow ZLS from another layer. */
  readonly zls?: ZigManagerToolStatus | null;
  readonly update: {
    readonly checked: boolean;
    readonly moving: boolean;
    readonly available: boolean | null;
    readonly resolvedCommit: string | null;
  };
}

export interface OperationOptions {
  readonly signal?: AbortSignal;
}

export interface BuildOptions extends OperationOptions {
  readonly profile?: ZigBuildProfile;
  readonly jobs?: number;
}

export interface InstallOptions extends BuildOptions {}

export interface UninstallOptions extends OperationOptions {}

export interface ScopeOperationOptions extends OperationOptions {
  readonly path?: string;
  readonly global?: boolean;
}

export interface UseOptions extends BuildOptions {
  readonly path?: string;
  readonly global?: boolean;
}

export interface CurrentOptions extends ScopeOperationOptions {
  readonly check?: boolean;
}

export interface DoctorOptions extends OperationOptions {
  readonly host?: boolean;
  readonly verify?: boolean;
  readonly strict?: boolean;
  readonly path?: string;
  readonly global?: boolean;
}

export interface GcOptions extends OperationOptions {
  readonly dryRun?: boolean;
  readonly sources?: boolean;
  readonly buildCache?: boolean;
  readonly profiles?: boolean;
}

export interface RepairOptions extends OperationOptions {
  readonly path?: string;
  readonly unlock?: string;
}

export interface PurgeOptions extends OperationOptions {
  readonly dryRun?: boolean;
  readonly confirm?: boolean;
}

export interface DocsOptions extends OperationOptions {
  readonly mega?: boolean;
}

export interface RunOptions extends OperationOptions {
  readonly selector?: string;
  readonly path?: string;
  readonly global?: boolean;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: "inherit" | "null";
  readonly onStdout?: (chunk: Uint8Array) => void | Promise<void>;
  readonly onStderr?: (chunk: Uint8Array) => void | Promise<void>;
}

export interface ZigManagerHost {
  readonly os: string;
  readonly architecture: string;
  readonly abi: string;
  readonly denoTarget: string;
}

export interface ZigInstallResult {
  readonly schemaVersion: 1 | 2;
  readonly selector: string;
  /** Zig compatibility aliases retained for existing facade consumers. */
  readonly installationId: string;
  readonly version: string;
  readonly commit: string;
  readonly executable: string;
  readonly reused: boolean;
  /** Present in schema v2. */
  readonly profileId?: string;
  /** Present in schema v2. */
  readonly zig?: ZigManagedComponentResult;
  /** Present in schema v2; null is reserved for an explicitly selected legacy profile. */
  readonly zls?: ZigManagedComponentResult | null;
}

export interface ZigUninstallResult {
  readonly schemaVersion: 1;
  readonly component: "zig" | "zls";
  readonly installationId: string;
  readonly version: string;
  readonly root: string;
  readonly removed: true;
}

export interface ZigUseResult extends ZigInstallResult {
  readonly profileId: string;
  readonly scopeRoot: string | null;
  readonly pinPath: string;
  readonly activationRequired: boolean;
  /** Present in schema v2. */
  readonly selection?: "local" | "global";
}

export interface ZigUnuseResult {
  readonly schemaVersion: 1 | 2;
  readonly scopeRoot: string | null;
  readonly pinPath: string;
  readonly removed: true;
  /** Present in schema v2. */
  readonly selection?: "local" | "global";
}

export interface ZigSyncResult {
  readonly schemaVersion: 1 | 2;
  readonly scopeRoot: string | null;
  readonly profileId: string;
  /** Zig compatibility aliases retained for existing facade consumers. */
  readonly installationId: string;
  readonly executable: string;
  readonly rebuilt: boolean;
  /** Present in schema v2. */
  readonly selection?: "local" | "global";
  /** Present in schema v2. */
  readonly zig?: ZigManagedComponentResult;
  /** Present in schema v2; null denotes a strict legacy profile without paired provenance. */
  readonly zls?: ZigManagedComponentResult | null;
}

export interface ZigUpdateResult extends ZigUseResult {
  readonly previousProfileId: string;
  readonly changed: boolean;
  readonly immutable: boolean;
}

export interface ZigListInstallation {
  /** Present in schema v2. */
  readonly component?: "zig" | "zls";
  readonly installationId: string;
  readonly version: string;
  readonly commit: string;
  readonly executable: string;
  readonly createdAt: string;
}

export interface ZigListProfile {
  readonly profileId: string;
  /** Present in schema v2. */
  readonly profileSchemaVersion?: 1 | 2;
  readonly selector: string;
  readonly installationId: string;
  readonly version: string;
  readonly commit: string;
  readonly createdAt: string;
  /** Present in schema v2. */
  readonly zig?: Omit<ZigManagedComponentResult, "reused">;
  /** Present in schema v2. */
  readonly zls?: Omit<ZigManagedComponentResult, "reused"> | null;
}

export interface ZigListResult {
  readonly schemaVersion: 1 | 2;
  readonly installations: readonly ZigListInstallation[];
  readonly profiles: readonly ZigListProfile[];
  readonly remote: readonly ZigSemanticVersion[] | null;
}

export interface ZigShellStatus {
  readonly schemaVersion: 2;
  readonly active: boolean;
  readonly shimDirectory: string;
  readonly basePath: string | null;
  readonly fallbackZig: string | null;
  readonly fallbackVersion: string | null;
  readonly fallbackUsable: boolean;
  readonly current: ZigManagerStatus;
}

export interface ZigManagerDoctorResult {
  readonly schemaVersion: 2;
  readonly mode: "host" | "source" | "pin";
  readonly strict: boolean;
  readonly ok: boolean;
  readonly buildReady: boolean;
  readonly counts: DiagnosticCounts;
  readonly errors: number;
  readonly warnings: number;
  readonly info: number;
  readonly host: ZigManagerHostDiagnostic;
  readonly selector: string | null;
  readonly source: DiagnosticSourceResult | null;
  readonly adapter: string | null;
  readonly toolchain: BuildToolchain | null;
  readonly resources: DiagnosticResourceResult;
  readonly session: DiagnosticSessionResult;
  readonly sourceRef: SourceRefDoctorResult | null;
  readonly effectiveConfig: RedactedEffectiveGlobalConfig | null;
  readonly verification: DiagnosticVerificationResult | null;
  readonly findings: readonly DiagnosticFinding[];
}

export interface ZigGcResult {
  readonly schemaVersion: 1;
  readonly dryRun: boolean;
  readonly removed: readonly string[];
  readonly retained: readonly string[];
  /** Null when profile pruning was not requested and the registry was not inspected. */
  readonly registry: ZigScopeRegistryStatus | null;
}

export type ZigScopeRegistryState = "healthy" | "missing" | "invalid" | "uncertain";

export interface ZigScopeRegistryStatus {
  readonly path: string;
  readonly state: ZigScopeRegistryState;
  readonly entryCount: number | null;
  readonly profilePruningSafe: boolean;
  readonly reason: string | null;
}

export interface ZigRepairRegistryStatus extends ZigScopeRegistryStatus {
  readonly reconciled: {
    readonly scopeRoot: string;
    readonly pinPath: string;
    readonly profileId: string;
  } | null;
}

export interface ZigRepairResult {
  readonly schemaVersion: 1 | 2;
  readonly catalogRebuilt: boolean;
  readonly shimsReinstalled: boolean;
  readonly scopeValid: boolean | null;
  readonly unlocked: string | null;
  readonly registry: ZigRepairRegistryStatus;
  /** Present in schema v2 after strict global-pointer reconciliation. */
  readonly global?: {
    readonly pointerPath: string;
    readonly profileId: string | null;
    readonly valid: boolean | null;
    readonly removed?: boolean;
  };
}

export interface ZigDanglingScopePin {
  readonly registeredScopeRoot: string;
  readonly physicalScopeRoot: string;
  readonly pinPath: string;
  readonly profileId: string | null;
  readonly valid: boolean;
}

export interface ZigPurgeResult {
  readonly schemaVersion: 1 | 2;
  readonly dryRun: boolean;
  readonly roots: readonly string[];
  readonly registry: ZigScopeRegistryStatus;
  readonly danglingPins: readonly ZigDanglingScopePin[];
  /** Present in schema v2 and records the manager-owned pointer observed before purge. */
  readonly globalProfileId?: string | null;
  /** Present in schema v2 and records owned persistent resolver removal. */
  readonly persistentResolvers?: {
    readonly zig: boolean;
    readonly zls: boolean;
  };
}

export interface ZigManagedComponentResult {
  readonly component: "zig" | "zls";
  readonly selector: string;
  readonly installationId: string;
  readonly version: string;
  readonly commit: string;
  readonly executable: string;
  readonly reused: boolean;
}

export interface ZigManagerToolStatus {
  readonly component: "zig" | "zls";
  readonly installationId: string | null;
  readonly selector: string | null;
  readonly version: string | null;
  readonly commit: string | null;
  readonly executable: string | null;
}

export type {
  CheckoutResult,
  GitRef,
  RemoteHead,
  RemoteRef,
  RepositoryStatus,
  RevisionDescription,
  SourceRefDoctorResult,
};
