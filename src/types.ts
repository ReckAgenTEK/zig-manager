import type {
  CheckoutResult,
  DescribeRevisionOptions,
  DoctorResult as SourceRefDoctorResult,
  EnsureRequest,
  GitRef,
  ListRemoteRefsRequest,
  PathOptions,
  RemoteRef,
  RepositorySelector,
  RepositoryStatus,
  RevisionDescription,
  StatusOptions,
  SyncOptions,
  UpdateOptions,
} from "@source-ref/source-ref";

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

export interface FilesystemProbeResult {
  readonly path: string;
  readonly writable: boolean;
  readonly freeBytes: number | null;
  readonly minimumFreeBytes: number;
  readonly sufficientDisk: boolean | null;
  readonly message: string | null;
}

export interface PrerequisiteIssue {
  readonly code: "MISSING" | "VERSION" | "FILESYSTEM" | "GENERATOR" | "DEVELOPMENT_FILES";
  readonly component: string;
  readonly message: string;
}

export interface ZigDoctorResult {
  readonly schemaVersion: 1;
  readonly ok: boolean;
  readonly adapter: string;
  readonly sourceRef: SourceRefDoctorResult;
  readonly toolchain: BuildToolchain;
  readonly filesystem: FilesystemProbeResult;
  readonly issues: readonly PrerequisiteIssue[];
}

export interface NormalizedBuildOptions {
  readonly strategy: "cmake";
  readonly profile: ZigBuildProfile;
  readonly cmakeBuildType: "Debug" | "Release" | "RelWithDebInfo" | "MinSizeRel";
  readonly generator: string;
  readonly jobs: number | null;
  readonly cmakePrefixPath: string;
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
  readonly schemaVersion: 2;
  readonly source: SourceSelectionState | null;
  readonly repository: RepositoryStatus | null;
  readonly build: ArtifactStatus;
  readonly docs: ArtifactStatus;
}

export interface ZigManagerOptions {
  readonly projectRoot?: string;
  readonly config?: ZigManagerConfig;
  readonly sourceRef?: SourceRefApi;
  readonly runner?: ProcessRunner;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly hostTarget?: string;
  readonly platform?: "linux" | "darwin" | "windows";
  readonly progress?: (message: string) => void | Promise<void>;
}

export interface OperationOptions {
  readonly signal?: AbortSignal;
}

export interface BuildOptions extends OperationOptions {
  readonly profile?: ZigBuildProfile;
  readonly jobs?: number;
}

export interface DocsOptions extends OperationOptions {
  readonly mega?: boolean;
}

export interface RunOptions extends OperationOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly stdin?: "inherit" | "null";
  readonly onStdout?: (chunk: Uint8Array) => void | Promise<void>;
  readonly onStderr?: (chunk: Uint8Array) => void | Promise<void>;
}

export interface SetupResult {
  readonly source: SourceSelectionState;
  readonly doctor: ZigDoctorResult;
  readonly build: BuildResult;
  readonly docs: DocsResult;
}

export type {
  CheckoutResult,
  GitRef,
  RemoteRef,
  RepositoryStatus,
  RevisionDescription,
  SourceRefDoctorResult,
};
