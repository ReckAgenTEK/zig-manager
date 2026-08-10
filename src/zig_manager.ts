import {
  LockedRequestMismatchError,
  RepositoryNotFoundError,
  SourceRefStore,
} from "@source-ref/source-ref";
import { dirname, resolve } from "@std/path";
import { buildManagedZig, verifyBuildManifest } from "./build.ts";
import { loadZigManagerConfig, resolveZigManagerConfig } from "./config.ts";
import { DOCS_MANIFEST_FILE } from "./constants.ts";
import { inspectBuildPrerequisites } from "./doctor.ts";
import { buildManagedDocs, verifyDocsManifestFiles } from "./docs.ts";
import {
  BuildPrerequisiteError,
  DocsBuildRequiredError,
  ZigBinaryNotBuiltError,
  ZigBinaryVerificationError,
  ZigSourceNotReadyError,
  ZigVersionNotFoundError,
} from "./errors.ts";
import { assertPathContained, assertRealPathContained } from "./filesystem.ts";
import { readBuildManifest, readDocsManifest } from "./manifest.ts";
import { DenoProcessRunner } from "./process_runner.ts";
import { releaseAdapterFor } from "./release_adapter.ts";
import { readZigSourceVersion } from "./source_version.ts";
import { readZigManagerState, writeZigManagerState } from "./state.ts";
import { listStableZigVersions, parseZigTag, resolveZigSelector } from "./versions.ts";
import type {
  ActiveBuildState,
  ActiveDocsState,
  ArtifactStatus,
  BuildManifest,
  BuildOptions,
  BuildResult,
  CheckoutResult,
  DocsOptions,
  DocsResult,
  ManagedZigEnvironment,
  OperationOptions,
  ProcessResult,
  ProcessRunner,
  RemoteRef,
  ResolvedZigManagerConfig,
  RunOptions,
  SetupResult,
  SourceRefApi,
  SourceSelectionState,
  ZigDoctorResult,
  ZigManagerConfig,
  ZigManagerOptions,
  ZigManagerState,
  ZigManagerStatus,
  ZigSemanticVersion,
} from "./types.ts";

export class ZigManager {
  readonly #projectRoot: string;
  readonly #providedConfig: ZigManagerConfig | undefined;
  readonly #providedSourceRef: SourceRefApi | undefined;
  readonly #runner: ProcessRunner;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #hostTarget: string;
  readonly #platform: "linux" | "darwin" | "windows";
  readonly #progress: (message: string) => void | Promise<void>;
  #configPromise: Promise<ResolvedZigManagerConfig> | null = null;
  #defaultSourceRef: SourceRefApi | null = null;

  constructor(options: ZigManagerOptions = {}) {
    this.#projectRoot = resolve(options.projectRoot ?? Deno.cwd());
    this.#providedConfig = options.config;
    this.#providedSourceRef = options.sourceRef;
    this.#runner = options.runner ?? new DenoProcessRunner();
    this.#env = options.env ?? readToolEnvironment();
    this.#hostTarget = options.hostTarget ?? Deno.build.target;
    this.#platform = options.platform ?? hostPlatform();
    this.#progress = options.progress ?? (() => {});
  }

  async versions(options: OperationOptions = {}): Promise<ZigSemanticVersion[]> {
    const [config, sourceRef] = await Promise.all([this.#config(), this.#sourceRef()]);
    const refs = await sourceRef.listRemoteRefs({
      url: config.repository,
      kind: "tag",
      signal: options.signal,
    });
    return listStableZigVersions(refs);
  }

  async use(selector: string, options: OperationOptions = {}): Promise<SourceSelectionState> {
    const [config, sourceRef] = await Promise.all([this.#config(), this.#sourceRef()]);
    const refs = await this.#remoteRefs(sourceRef, config, options.signal);
    const selection = resolveZigSelector(selector, refs);
    await this.#progress(`Selecting Zig ${selector}...\n`);
    let checkout: CheckoutResult;
    try {
      checkout = await sourceRef.ensure({
        id: repositoryId(config),
        url: config.repository,
        mode: "pinned",
        ref: selection.ref,
        signal: options.signal,
      });
    } catch (cause) {
      if (
        !(cause instanceof LockedRequestMismatchError) &&
        errorCode(cause) !== "LOCKED_REQUEST_MISMATCH"
      ) {
        throw cause;
      }
      checkout = await sourceRef.update(repositoryId(config), {
        ref: selection.ref,
        signal: options.signal,
      });
    }
    if (checkout.resolvedCommit.toLowerCase() !== selection.remoteCommit) {
      throw new ZigVersionNotFoundError(
        `${selector} (remote changed while the pinned checkout was being resolved)`,
      );
    }
    return await this.#persistSource(config, sourceRef, checkout, selector, options.signal);
  }

  async sync(options: OperationOptions = {}): Promise<SourceSelectionState> {
    const [config, sourceRef] = await Promise.all([this.#config(), this.#sourceRef()]);
    const repositoryHome = this.#repositoryHome(config, sourceRef);
    const prior = await readZigManagerState(repositoryHome);
    if (prior.source === null) return await this.use(config.selector, options);
    await this.#progress(`Synchronizing locked Zig source at ${prior.source.commit}...\n`);
    const results = await sourceRef.sync(repositoryId(config), { signal: options.signal });
    const checkout = results.find((result) => sameId(result.id, repositoryId(config)));
    if (!checkout) {
      throw new ZigSourceNotReadyError("source-ref sync did not return the Zig checkout");
    }
    const unchangedRequest = refsEqual(checkout.requested, prior.source.ref);
    const selector = unchangedRequest ? prior.source.selector : selectorForRef(checkout.requested);
    return await this.#persistSource(config, sourceRef, checkout, selector, options.signal);
  }

  async update(selector?: string, options: OperationOptions = {}): Promise<SourceSelectionState> {
    const [config, sourceRef] = await Promise.all([this.#config(), this.#sourceRef()]);
    const repositoryHome = this.#repositoryHome(config, sourceRef);
    const prior = await readZigManagerState(repositoryHome);
    const desired = selector ?? prior.source?.selector ?? config.selector;
    const refs = await this.#remoteRefs(sourceRef, config, options.signal);
    const selection = resolveZigSelector(desired, refs);
    await this.#progress(`Updating Zig selector ${desired}...\n`);
    let checkout: CheckoutResult;
    try {
      checkout = prior.source === null
        ? await sourceRef.ensure({
          id: repositoryId(config),
          url: config.repository,
          mode: "pinned",
          ref: selection.ref,
          signal: options.signal,
        })
        : await sourceRef.update(repositoryId(config), {
          ref: selection.ref,
          signal: options.signal,
        });
    } catch (cause) {
      if (
        !(cause instanceof RepositoryNotFoundError) && errorCode(cause) !== "REPOSITORY_NOT_FOUND"
      ) throw cause;
      checkout = await sourceRef.ensure({
        id: repositoryId(config),
        url: config.repository,
        mode: "pinned",
        ref: selection.ref,
        signal: options.signal,
      });
    }
    if (checkout.resolvedCommit.toLowerCase() !== selection.remoteCommit) {
      throw new ZigVersionNotFoundError(
        `${desired} (remote changed while the pinned update was being resolved)`,
      );
    }
    return await this.#persistSource(config, sourceRef, checkout, desired, options.signal);
  }

  async doctor(options: OperationOptions = {}): Promise<ZigDoctorResult> {
    const [config, sourceRef] = await Promise.all([this.#config(), this.#sourceRef()]);
    const state = await readZigManagerState(this.#repositoryHome(config, sourceRef));
    if (state.source === null) {
      throw new ZigSourceNotReadyError("select and synchronize Zig source before running doctor");
    }
    await this.#assertSourceReady(config, sourceRef, state.source, options.signal);
    const adapter = releaseAdapterFor(state.source.version);
    const sourceRefDoctor = await sourceRef.doctor(options.signal);
    return await inspectBuildPrerequisites({
      config,
      adapter,
      sourceRefDoctor,
      runner: this.#runner,
      env: this.#env,
      platform: this.#platform,
      outputPath: this.#repositoryHome(config, sourceRef),
      signal: options.signal,
    });
  }

  async build(options: BuildOptions = {}): Promise<BuildResult> {
    const doctor = await this.doctor(options);
    return await this.#buildWithDoctor(doctor, options);
  }

  async docs(options: DocsOptions = {}): Promise<DocsResult> {
    const [config, sourceRef] = await Promise.all([this.#config(), this.#sourceRef()]);
    const repositoryHome = this.#repositoryHome(config, sourceRef);
    const state = await readZigManagerState(repositoryHome);
    if (
      state.source === null || state.activeBuild === null ||
      state.activeBuild.commit !== state.source.commit
    ) {
      throw new DocsBuildRequiredError(
        state.source?.commit ?? "unselected",
        state.activeBuild?.commit ?? null,
      );
    }
    await this.#assertSourceReady(config, sourceRef, state.source, options.signal);
    const manifest = await this.#activeBuildManifest(state, repositoryHome, options.signal);
    const adapter = releaseAdapterFor(state.source.version);
    const result = await buildManagedDocs({
      repositoryHome,
      source: state.source,
      build: manifest,
      adapter,
      runner: this.#runner,
      platform: this.#platform,
      options,
      defaultMega: config.docs.mega,
      progress: this.#progress,
    });
    const latest = await readZigManagerState(repositoryHome);
    if (
      latest.source?.commit !== state.source.commit ||
      latest.activeBuild?.identity !== state.activeBuild.identity
    ) {
      throw new ZigSourceNotReadyError("source or active build changed while docs were generated");
    }
    const finalDirectory = result.manifest.outputPath;
    const docsState: ActiveDocsState = {
      commit: state.source.commit,
      manifestPath: resolve(finalDirectory, DOCS_MANIFEST_FILE),
      directory: finalDirectory,
      megaPath: result.manifest.mega === null
        ? null
        : resolve(finalDirectory, result.manifest.mega.path),
    };
    await writeZigManagerState(repositoryHome, { ...latest, docs: docsState });
    return result;
  }

  async path(options: OperationOptions = {}): Promise<string> {
    const { manifest } = await this.#currentBuild(options.signal);
    return manifest.paths.executable;
  }

  async run(args: readonly string[], options: RunOptions = {}): Promise<ProcessResult> {
    const { manifest } = await this.#currentBuild(options.signal);
    return await this.#runner.run({
      executable: manifest.paths.executable,
      args,
      cwd: options.cwd,
      env: {
        ZIG_GLOBAL_CACHE_DIR: resolve(manifest.paths.cache, "global"),
        ...(options.env ?? {}),
      },
      stdin: options.stdin ?? "inherit",
      signal: options.signal,
      onStdout: options.onStdout,
      onStderr: options.onStderr,
    });
  }

  async env(options: OperationOptions = {}): Promise<ManagedZigEnvironment> {
    const { manifest } = await this.#currentBuild(options.signal);
    return {
      executable: manifest.paths.executable,
      binDirectory: dirname(manifest.paths.executable),
      pathPrepend: [dirname(manifest.paths.executable)],
      variables: {
        ZIG: manifest.paths.executable,
        ZIG_GLOBAL_CACHE_DIR: resolve(manifest.paths.cache, "global"),
      },
    };
  }

  async status(options: OperationOptions = {}): Promise<ZigManagerStatus> {
    const [config, sourceRef] = await Promise.all([this.#config(), this.#sourceRef()]);
    const repositoryHome = this.#repositoryHome(config, sourceRef);
    const state = await readZigManagerState(repositoryHome);
    let repository = null;
    try {
      repository = (await sourceRef.status(repositoryId(config), { signal: options.signal }))[0] ??
        null;
    } catch (cause) {
      if (
        !(cause instanceof RepositoryNotFoundError) && errorCode(cause) !== "REPOSITORY_NOT_FOUND"
      ) throw cause;
    }
    const currentSourceCommit = repository === null
      ? state.source?.commit ?? null
      : repository.currentCommit;
    return {
      schemaVersion: 2,
      source: state.source,
      repository,
      build: await this.#buildStatus(state, repositoryHome, currentSourceCommit, options.signal),
      docs: await this.#docsStatus(state, repositoryHome, currentSourceCommit),
    };
  }

  async setup(options: DocsOptions & BuildOptions = {}): Promise<SetupResult> {
    const source = await this.sync(options);
    const doctor = await this.doctor(options);
    if (!doctor.ok) throw new BuildPrerequisiteError(doctor.issues);
    const build = await this.#buildWithDoctor(doctor, options);
    const docs = await this.docs(options);
    return { source, doctor, build, docs };
  }

  async #buildWithDoctor(doctor: ZigDoctorResult, options: BuildOptions): Promise<BuildResult> {
    if (!doctor.ok) throw new BuildPrerequisiteError(doctor.issues);
    const [config, sourceRef] = await Promise.all([this.#config(), this.#sourceRef()]);
    const repositoryHome = this.#repositoryHome(config, sourceRef);
    const state = await readZigManagerState(repositoryHome);
    if (state.source === null) throw new ZigSourceNotReadyError("no Zig source is selected");
    await this.#assertSourceReady(config, sourceRef, state.source, options.signal);
    const adapter = releaseAdapterFor(state.source.version);
    const result = await buildManagedZig({
      repositoryHome,
      source: state.source,
      doctor,
      adapter,
      runner: this.#runner,
      hostTarget: this.#hostTarget,
      platform: this.#platform,
      config,
      options,
      progress: this.#progress,
    });
    const latest = await readZigManagerState(repositoryHome);
    if (latest.source?.commit !== state.source.commit) {
      throw new ZigSourceNotReadyError("source changed while the compiler was built", {
        builtCommit: state.source.commit,
        currentCommit: latest.source?.commit ?? null,
      });
    }
    const activeBuild: ActiveBuildState = {
      commit: state.source.commit,
      identity: result.manifest.identity,
      manifestPath: resolve(result.manifest.paths.root, "build-manifest.json"),
      executablePath: result.manifest.paths.executable,
    };
    await writeZigManagerState(repositoryHome, { ...latest, activeBuild });
    return result;
  }

  async #currentBuild(
    signal?: AbortSignal,
  ): Promise<{ state: ZigManagerState; manifest: BuildManifest }> {
    const [config, sourceRef] = await Promise.all([this.#config(), this.#sourceRef()]);
    const repositoryHome = this.#repositoryHome(config, sourceRef);
    const state = await readZigManagerState(repositoryHome);
    if (
      state.source === null || state.activeBuild === null ||
      state.activeBuild.commit !== state.source.commit
    ) throw new ZigBinaryNotBuiltError();
    const manifest = await this.#activeBuildManifest(state, repositoryHome, signal);
    return { state, manifest };
  }

  async #activeBuildManifest(
    state: ZigManagerState,
    repositoryHome: string,
    signal?: AbortSignal,
  ): Promise<BuildManifest> {
    if (state.activeBuild === null) throw new ZigBinaryNotBuiltError();
    assertPathContained(repositoryHome, state.activeBuild.manifestPath);
    const manifest = await readBuildManifest(state.activeBuild.manifestPath);
    if (
      manifest.identity !== state.activeBuild.identity ||
      manifest.paths.executable !== state.activeBuild.executablePath ||
      manifest.source.commit !== state.activeBuild.commit
    ) throw new ZigBinaryVerificationError("active build state does not match its manifest");
    const adapter = releaseAdapterFor(manifest.source.version);
    await verifyBuildManifest(
      manifest,
      this.#runner,
      adapter,
      this.#platform,
      state.activeBuild.identity,
      signal,
    );
    return manifest;
  }

  async #assertSourceReady(
    config: ResolvedZigManagerConfig,
    sourceRef: SourceRefApi,
    source: SourceSelectionState,
    signal?: AbortSignal,
  ): Promise<void> {
    const repositoryHome = this.#repositoryHome(config, sourceRef);
    const checkoutPath = resolve(sourceRef.path(repositoryId(config)));
    if (
      resolve(source.repositoryHome) !== repositoryHome ||
      resolve(source.checkoutPath) !== checkoutPath
    ) {
      throw new ZigSourceNotReadyError("persisted source paths do not match source-ref", {
        repositoryHome: source.repositoryHome,
        checkoutPath: source.checkoutPath,
      });
    }
    assertPathContained(config.sourceRoot, checkoutPath);
    await assertRealPathContained(config.projectRoot, repositoryHome);
    await assertRealPathContained(config.projectRoot, checkoutPath);
    const status = (await sourceRef.status(repositoryId(config), { signal }))[0];
    if (
      !status || !status.checkoutExists || !status.matchesLock ||
      status.currentCommit !== source.commit || resolve(status.repositoryHome) !== repositoryHome ||
      resolve(status.checkoutPath) !== checkoutPath
    ) {
      throw new ZigSourceNotReadyError("checkout does not match the selected locked commit", {
        selectedCommit: source.commit,
        currentCommit: status?.currentCommit ?? null,
        lockedCommit: status?.lockedCommit ?? null,
      });
    }
    if (status.dirty) {
      throw new ZigSourceNotReadyError("checkout contains local changes", {
        changes: status.changes,
      });
    }
  }

  async #persistSource(
    config: ResolvedZigManagerConfig,
    sourceRef: SourceRefApi,
    checkout: CheckoutResult,
    selector: string,
    signal?: AbortSignal,
  ): Promise<SourceSelectionState> {
    const repositoryHome = this.#repositoryHome(config, sourceRef);
    if (resolve(checkout.repositoryHome) !== repositoryHome) {
      throw new ZigSourceNotReadyError("source-ref returned an unexpected repository home", {
        expected: repositoryHome,
        actual: checkout.repositoryHome,
      });
    }
    assertPathContained(config.sourceRoot, checkout.checkoutPath);
    await assertRealPathContained(config.projectRoot, checkout.repositoryHome);
    await assertRealPathContained(config.projectRoot, checkout.checkoutPath);
    const revision = await sourceRef.describeRevision(repositoryId(config), {
      tagPattern: "*.*.*",
      abbreviationLength: 9,
      signal,
    });
    if (revision.commit.toLowerCase() !== checkout.resolvedCommit.toLowerCase()) {
      throw new ZigSourceNotReadyError("revision description does not match the selected commit", {
        selectedCommit: checkout.resolvedCommit,
        describedCommit: revision.commit,
      });
    }
    const version = await readZigSourceVersion(checkout.checkoutPath, revision);
    const source: SourceSelectionState = {
      selector,
      version,
      ref: { ...checkout.requested },
      commit: checkout.resolvedCommit.toLowerCase(),
      repositoryHome,
      checkoutPath: resolve(checkout.checkoutPath),
    };
    const prior = await readZigManagerState(repositoryHome);
    await writeZigManagerState(repositoryHome, { ...prior, source });
    return source;
  }

  async #remoteRefs(
    sourceRef: SourceRefApi,
    config: ResolvedZigManagerConfig,
    signal?: AbortSignal,
  ): Promise<RemoteRef[]> {
    return await sourceRef.listRemoteRefs({ url: config.repository, signal });
  }

  async #buildStatus(
    state: ZigManagerState,
    repositoryHome: string,
    currentSourceCommit: string | null,
    signal?: AbortSignal,
  ): Promise<ArtifactStatus> {
    if (state.activeBuild === null) return emptyArtifactStatus();
    const stale = currentSourceCommit === null || state.activeBuild.commit !== currentSourceCommit;
    try {
      await this.#activeBuildManifest(state, repositoryHome, signal);
      return {
        selected: true,
        commit: state.activeBuild.commit,
        stale,
        valid: true,
        path: state.activeBuild.executablePath,
        message: null,
      };
    } catch (cause) {
      return {
        selected: true,
        commit: state.activeBuild.commit,
        stale,
        valid: false,
        path: state.activeBuild.executablePath,
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }

  async #docsStatus(
    state: ZigManagerState,
    repositoryHome: string,
    currentSourceCommit: string | null,
  ): Promise<ArtifactStatus> {
    if (state.docs === null) return emptyArtifactStatus();
    const stale = currentSourceCommit === null || state.docs.commit !== currentSourceCommit;
    try {
      assertPathContained(repositoryHome, state.docs.manifestPath);
      const manifest = await readDocsManifest(state.docs.manifestPath);
      if (
        manifest.source.commit !== state.docs.commit ||
        resolve(manifest.outputPath) !== resolve(state.docs.directory) ||
        (manifest.mega === null ? null : resolve(manifest.outputPath, manifest.mega.path)) !==
          (state.docs.megaPath === null ? null : resolve(state.docs.megaPath))
      ) throw new Error("docs state does not match its manifest");
      assertPathContained(repositoryHome, manifest.outputPath);
      await verifyDocsManifestFiles(manifest);
      return {
        selected: true,
        commit: state.docs.commit,
        stale,
        valid: true,
        path: state.docs.directory,
        message: null,
      };
    } catch (cause) {
      return {
        selected: true,
        commit: state.docs.commit,
        stale,
        valid: false,
        path: state.docs.directory,
        message: cause instanceof Error ? cause.message : String(cause),
      };
    }
  }

  #repositoryHome(config: ResolvedZigManagerConfig, sourceRef: SourceRefApi): string {
    const path = resolve(sourceRef.path(repositoryId(config), { repositoryRoot: true }));
    assertPathContained(config.sourceRoot, path);
    return path;
  }

  async #config(): Promise<ResolvedZigManagerConfig> {
    if (this.#configPromise === null) {
      this.#configPromise = this.#providedConfig === undefined
        ? loadZigManagerConfig(this.#projectRoot)
        : (async () => {
          const config = resolveZigManagerConfig(this.#providedConfig, this.#projectRoot);
          await assertRealPathContained(config.projectRoot, config.sourceRoot);
          return config;
        })();
    }
    return await this.#configPromise;
  }

  async #sourceRef(): Promise<SourceRefApi> {
    if (this.#providedSourceRef) return this.#providedSourceRef;
    if (this.#defaultSourceRef === null) {
      const config = await this.#config();
      this.#defaultSourceRef = new SourceRefStore({
        projectRoot: config.projectRoot,
        root: config.sourceRoot,
        lockFile: "source-ref.lock.json",
      });
    }
    return this.#defaultSourceRef;
  }
}

function repositoryId(config: ResolvedZigManagerConfig): { provider: string; name: string } {
  return { provider: config.provider, name: config.name };
}

function sameId(
  left: { readonly provider: string; readonly name: string },
  right: { readonly provider: string; readonly name: string },
): boolean {
  return left.provider === right.provider && left.name === right.name;
}

function refsEqual(
  left: { readonly kind: string; readonly value: string },
  right: { readonly kind: string; readonly value: string },
): boolean {
  return left.kind === right.kind && left.value === right.value;
}

function selectorForRef(ref: { readonly kind: string; readonly value: string }): string {
  if (ref.kind === "tag" && parseZigTag(ref.value)) return ref.value;
  return `${ref.kind}:${ref.value}`;
}

function emptyArtifactStatus(): ArtifactStatus {
  return { selected: false, commit: null, stale: false, valid: false, path: null, message: null };
}

function hostPlatform(): "linux" | "darwin" | "windows" {
  if (Deno.build.os === "linux" || Deno.build.os === "darwin" || Deno.build.os === "windows") {
    return Deno.build.os;
  }
  throw new TypeError(`zig-manager does not support host platform '${Deno.build.os}'`);
}

function readToolEnvironment(): Readonly<Record<string, string | undefined>> {
  const names = [
    "ZIG_MANAGER_CMAKE",
    "ZIG_MANAGER_CC",
    "ZIG_MANAGER_CXX",
    "ZIG_MANAGER_LLVM_CONFIG",
    "ZIG_MANAGER_CLANG",
    "ZIG_MANAGER_LLD",
    "ZIG_MANAGER_GENERATOR_TOOL",
    "ZIG_MANAGER_CMAKE_PREFIX_PATH",
    "CC",
    "CXX",
  ];
  const result: Record<string, string | undefined> = {};
  for (const name of names) {
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
  const code = (cause as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}
