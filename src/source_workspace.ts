import {
  type CheckoutResult,
  type DescribeRevisionOptions,
  type DoctorResult as SourceRefDoctorResult,
  type EnsureRequest,
  type GitRef,
  type ListRemoteRefsRequest,
  type PathOptions,
  type RemoteHead,
  type RemoteRef,
  type RepositoryId,
  RepositoryNotFoundError,
  type RepositorySelector,
  type RepositoryStatus,
  type ResolveRemoteHeadRequest,
  SourceRefStore,
  type StatusOptions,
  type UpdateOptions,
} from "@source-ref/source-ref";
import { isAbsolute, join, resolve } from "@std/path";
import {
  InvalidZigSelectorError,
  ZigOperationAbortedError,
  ZigSourceNotReadyError,
  ZigVersionNotFoundError,
} from "./errors.ts";
import { assertPathBelow, assertPathContained } from "./filesystem.ts";
import type { GlobalConfig } from "./global_config.ts";
import { GlobalOperationLockManager } from "./global_operation_lock.ts";
import {
  type ResolvedRefKind,
  type ResolvedSource,
  validateResolvedSource,
} from "./install_store.ts";
import { type ReleaseAdapter, releaseAdapterFor } from "./release_adapter.ts";
import { readZigSourceVersion } from "./source_version.ts";
import type { RevisionDescription, ZigSourceVersion } from "./types.ts";
import { listStableZigVersions, parseZigSelector, resolveZigSelector } from "./versions.ts";

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REMOTE_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export const ZIG_SOURCE_REPOSITORY_ID: RepositoryId = Object.freeze({
  provider: "codeberg",
  name: "zig",
});
export const ZIG_SOURCE_REPOSITORY_IDENTITY = "codeberg/zig";

/** The public source-ref surface needed by the global Zig source workspace. */
export interface SourceWorkspaceSourceRef {
  resolveRemoteHead(request: ResolveRemoteHeadRequest): Promise<RemoteHead>;
  listRemoteRefs(request: ListRemoteRefsRequest): Promise<RemoteRef[]>;
  ensure(request: EnsureRequest): Promise<CheckoutResult>;
  update(selector: RepositorySelector, options?: UpdateOptions): Promise<CheckoutResult>;
  describeRevision(
    selector: RepositorySelector,
    options?: DescribeRevisionOptions,
  ): Promise<RevisionDescription>;
  doctor(signal?: AbortSignal): Promise<SourceRefDoctorResult>;
  status(selector?: RepositorySelector, options?: StatusOptions): Promise<RepositoryStatus[]>;
  path(selector: RepositorySelector, options?: PathOptions): string;
}

export interface SourceWorkspaceLockLease {
  readonly owner: { readonly operationId: string };
  release(): Promise<void>;
}

export interface SourceWorkspaceLockManager {
  acquireSource(options: {
    readonly operation: string;
    readonly operationId?: string;
    readonly scope?: string;
    readonly selector?: string;
    readonly signal?: AbortSignal;
    readonly wait?: { readonly timeoutMs?: number; readonly pollIntervalMs?: number };
  }): Promise<SourceWorkspaceLockLease>;
}

export type SourceWorkspaceProgress = (message: string) => void | Promise<void>;

export interface SourceWorkspaceOptions {
  readonly config: GlobalConfig;
  readonly cacheRoot: string;
  readonly stateRoot: string;
  /** Defaults to `<cacheRoot>/sources`. */
  readonly sourceRoot?: string;
  /** Defaults to `<stateRoot>/source-ref.lock.json`. */
  readonly sourceRefLockFile?: string;
  readonly sourceRef?: SourceWorkspaceSourceRef;
  readonly lockManager?: SourceWorkspaceLockManager;
  readonly now?: () => Date;
  readonly progress?: SourceWorkspaceProgress;
}

export interface ResolveSourceOptions {
  readonly signal?: AbortSignal;
}

export interface PrepareSourceOptions extends ResolveSourceOptions {
  readonly operation?: string;
  readonly operationId?: string;
  readonly scope?: string;
}

export interface SourceWorkspaceResolution {
  readonly requestedSelector: string;
  readonly resolvedRef: {
    readonly kind: ResolvedRefKind;
    readonly value: string;
  };
  /** The source-ref ref used to materialize the observed commit. */
  readonly checkoutRef: GitRef;
  readonly commit: string;
  readonly resolvedAt: string;
}

export interface PreparedSource {
  readonly operationId: string;
  readonly source: ResolvedSource;
  readonly version: ZigSourceVersion;
  readonly adapter: ReleaseAdapter;
  readonly checkout: CheckoutResult;
  readonly revision: RevisionDescription;
  readonly repositoryHome: string;
  readonly checkoutPath: string;
}

/**
 * Owns the one mutable global Zig checkout. Callbacks execute while the manager source lock is held.
 */
export class SourceWorkspace {
  readonly config: GlobalConfig;
  readonly cacheRoot: string;
  readonly stateRoot: string;
  readonly sourceRoot: string;
  readonly sourceRefLockFile: string;
  readonly repositoryId: RepositoryId = ZIG_SOURCE_REPOSITORY_ID;

  readonly #repositoryUrl: string;
  readonly #sourceRef: SourceWorkspaceSourceRef;
  readonly #locks: SourceWorkspaceLockManager;
  readonly #now: () => Date;
  readonly #progress: SourceWorkspaceProgress;

  constructor(options: SourceWorkspaceOptions) {
    this.config = options.config;
    this.#repositoryUrl = normalizedRepositoryUrl(options.config.zigRepository);
    this.cacheRoot = normalizedRoot(options.cacheRoot, "cacheRoot");
    this.stateRoot = normalizedRoot(options.stateRoot, "stateRoot");
    this.sourceRoot = normalizedPath(
      options.sourceRoot ?? join(this.cacheRoot, "sources"),
      "sourceRoot",
    );
    this.sourceRefLockFile = normalizedPath(
      options.sourceRefLockFile ?? join(this.stateRoot, "source-ref.lock.json"),
      "sourceRefLockFile",
    );
    assertPathBelow(this.cacheRoot, this.sourceRoot);
    assertPathBelow(this.stateRoot, this.sourceRefLockFile);

    this.#sourceRef = options.sourceRef ?? new SourceRefStore({
      projectRoot: this.cacheRoot,
      root: this.sourceRoot,
      lockFile: this.sourceRefLockFile,
    });
    this.#locks = options.lockManager ?? new GlobalOperationLockManager({
      stateRoot: this.stateRoot,
    });
    this.#now = options.now ?? (() => new Date());
    this.#progress = options.progress ?? (() => {});
  }

  /** Resolve a selector to the exact remote commit observed now, without moving the checkout. */
  async resolve(
    selector: string,
    options: ResolveSourceOptions = {},
  ): Promise<SourceWorkspaceResolution> {
    validateSelectorSyntax(selector);
    throwIfAborted(options.signal, `resolve Zig source '${selector}'`);

    if (selector === "latest") {
      const head = await this.#sourceRef.resolveRemoteHead({
        url: this.#repositoryUrl,
        signal: options.signal,
      });
      throwIfAborted(options.signal, `resolve Zig source '${selector}'`);
      const branch = remoteHeadBranch(head.branch, selector);
      return {
        requestedSelector: selector,
        resolvedRef: { kind: "head", value: branch },
        checkoutRef: { kind: "branch", value: branch },
        commit: remoteCommit(head.commit, selector),
        resolvedAt: timestamp(this.#now()),
      };
    }

    if (selector === "stable") {
      const refs = await this.#sourceRef.listRemoteRefs({
        url: this.#repositoryUrl,
        kind: "tag",
        signal: options.signal,
      });
      throwIfAborted(options.signal, `resolve Zig source '${selector}'`);
      const stable = listStableZigVersions(refs)[0];
      if (stable === undefined) throw new ZigVersionNotFoundError(selector);
      const selected = resolveZigSelector(stable.text, refs);
      return resolutionFromSelection(selector, selected.ref, selected.remoteCommit, this.#now);
    }

    const parsed = parseZigSelector(selector);
    if (parsed.kind === "commit") {
      const selected = resolveZigSelector(selector, []);
      return resolutionFromSelection(selector, selected.ref, selected.remoteCommit, this.#now);
    }

    const refs = await this.#sourceRef.listRemoteRefs({
      url: this.#repositoryUrl,
      kind: parsed.kind === "branch" ? "branch" : "tag",
      signal: options.signal,
    });
    throwIfAborted(options.signal, `resolve Zig source '${selector}'`);
    const selected = resolveZigSelector(selector, refs);
    return resolutionFromSelection(selector, selected.ref, selected.remoteCommit, this.#now);
  }

  async versions(signal?: AbortSignal) {
    throwIfAborted(signal, "list remote Zig versions");
    const refs = await this.#sourceRef.listRemoteRefs({
      url: this.#repositoryUrl,
      kind: "tag",
      signal,
    });
    throwIfAborted(signal, "list remote Zig versions");
    return listStableZigVersions(refs);
  }

  async doctor(signal?: AbortSignal): Promise<SourceRefDoctorResult> {
    throwIfAborted(signal, "inspect Zig source workspace");
    const result = await this.#sourceRef.doctor(signal);
    throwIfAborted(signal, "inspect Zig source workspace");
    return result;
  }

  /** Resolve, validate, and expose source while retaining the global source-workspace lease. */
  async prepare<T>(
    selector: string,
    callback: (prepared: PreparedSource) => T | Promise<T>,
    options: PrepareSourceOptions = {},
  ): Promise<T> {
    validateSelectorSyntax(selector);
    requiredCallback(callback);
    const lease = await this.#locks.acquireSource({
      operation: options.operation ?? "prepare Zig source",
      ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
      selector,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      wait: {},
    });
    try {
      throwIfAborted(options.signal, `prepare Zig source '${selector}'`);
      await this.#progress(`Resolving Zig source '${selector}'...\n`);
      const resolution = await this.resolve(selector, options);
      throwIfAborted(options.signal, `prepare Zig source '${selector}'`);
      await this.#progress(
        `Preparing Zig source '${selector}' at ${resolution.commit}...\n`,
      );
      const prepared = await this.#materialize(
        resolution,
        lease.owner.operationId,
        options.signal,
      );
      throwIfAborted(options.signal, `prepare Zig source '${selector}'`);
      return await callback(prepared);
    } catch (cause) {
      if (options.signal?.aborted && !(cause instanceof ZigOperationAbortedError)) {
        throw aborted(`prepare Zig source '${selector}'`, options.signal, cause);
      }
      throw cause;
    } finally {
      await lease.release();
    }
  }

  /**
   * Recreate an already-resolved source exactly. This is the local source path used by sync and
   * never re-resolves the stored selector or contacts remote ref discovery.
   */
  async prepareExact<T>(
    sourceValue: ResolvedSource,
    callback: (prepared: PreparedSource) => T | Promise<T>,
    options: PrepareSourceOptions = {},
  ): Promise<T> {
    requiredCallback(callback);
    const source = checkedExactSource(sourceValue, this.#repositoryUrl);
    const lease = await this.#locks.acquireSource({
      operation: options.operation ?? "prepare exact Zig source",
      ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
      selector: source.requestedSelector,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      wait: {},
    });
    try {
      throwIfAborted(options.signal, "prepare exact Zig source");
      await this.#progress(`Preparing exact Zig source at ${source.commit}...\n`);
      const prepared = await this.#materialize(
        {
          requestedSelector: source.requestedSelector,
          resolvedRef: source.resolvedRef,
          checkoutRef: { kind: "commit", value: source.commit },
          commit: source.commit,
          resolvedAt: source.resolvedAt,
        },
        lease.owner.operationId,
        options.signal,
        source,
      );
      throwIfAborted(options.signal, "prepare exact Zig source");
      return await callback(prepared);
    } catch (cause) {
      if (options.signal?.aborted && !(cause instanceof ZigOperationAbortedError)) {
        throw aborted("prepare exact Zig source", options.signal, cause);
      }
      throw cause;
    } finally {
      await lease.release();
    }
  }

  async #materialize(
    resolution: SourceWorkspaceResolution,
    operationId: string,
    signal?: AbortSignal,
    exactSource?: ResolvedSource,
  ): Promise<PreparedSource> {
    throwIfAborted(signal, "materialize Zig source");
    const paths = this.#expectedPaths();
    await this.#assertLayoutBeforeMutation(paths);
    throwIfAborted(signal, "materialize Zig source");

    const checkout = await this.#updateOrEnsure(resolution.checkoutRef, signal);
    throwIfAborted(signal, "materialize Zig source");
    const checkoutCommit = canonicalCheckoutCommit(checkout.resolvedCommit);
    if (checkoutCommit !== resolution.commit) {
      if (exactSource !== undefined) {
        throw new ZigSourceNotReadyError("checkout did not reach the stored exact commit", {
          expectedCommit: resolution.commit,
          actualCommit: checkoutCommit,
        });
      }
      throw new ZigVersionNotFoundError(
        `${resolution.requestedSelector} (remote changed while the checkout was being resolved)`,
      );
    }
    this.#assertCheckoutResult(checkout, paths, resolution.checkoutRef, resolution.commit);
    await this.#assertPhysicalLayout(paths);
    await this.#assertStatus(paths, resolution.checkoutRef, resolution.commit, signal);
    throwIfAborted(signal, "materialize Zig source");

    const revision = await this.#sourceRef.describeRevision(this.repositoryId, {
      tagPattern: "*.*.*",
      abbreviationLength: 9,
      signal,
    });
    throwIfAborted(signal, "materialize Zig source");
    const describedCommit = canonicalCheckoutCommit(revision.commit);
    if (describedCommit !== resolution.commit) {
      throw new ZigSourceNotReadyError("revision description does not match the locked commit", {
        expectedCommit: resolution.commit,
        describedCommit,
      });
    }

    const version = await readZigSourceVersion(paths.checkoutPath, revision);
    throwIfAborted(signal, "materialize Zig source");
    if (exactSource !== undefined && version.text !== exactSource.version) {
      throw new ZigSourceNotReadyError("derived version does not match the stored exact source", {
        commit: resolution.commit,
        expectedVersion: exactSource.version,
        actualVersion: version.text,
      });
    }
    if (
      exactSource !== undefined &&
      JSON.stringify(version) !== JSON.stringify(exactSource.versionMetadata)
    ) {
      throw new ZigSourceNotReadyError(
        "derived structured version does not match stored exact source",
        {
          commit: resolution.commit,
        },
      );
    }
    const adapter = releaseAdapterFor(version, resolution.commit);
    const source = exactSource ?? validateResolvedSource({
      component: "zig",
      repository: {
        identity: ZIG_SOURCE_REPOSITORY_IDENTITY,
        url: this.#repositoryUrl,
      },
      requestedSelector: resolution.requestedSelector,
      resolvedRef: resolution.resolvedRef,
      commit: resolution.commit,
      version: version.text,
      versionMetadata: version,
      resolvedAt: resolution.resolvedAt,
    });
    return {
      operationId,
      source,
      version,
      adapter,
      checkout,
      revision,
      repositoryHome: paths.repositoryHome,
      checkoutPath: paths.checkoutPath,
    };
  }

  async #updateOrEnsure(ref: GitRef, signal?: AbortSignal): Promise<CheckoutResult> {
    try {
      return await this.#sourceRef.update(this.repositoryId, { ref, signal });
    } catch (cause) {
      if (
        !(cause instanceof RepositoryNotFoundError) && errorCode(cause) !== "REPOSITORY_NOT_FOUND"
      ) {
        throw cause;
      }
      return await this.#sourceRef.ensure({
        id: this.repositoryId,
        url: this.#repositoryUrl,
        mode: "pinned",
        ref,
        signal,
      });
    }
  }

  #expectedPaths(): WorkspacePaths {
    const repositoryHome = exactNormalizedPath(
      this.#sourceRef.path(this.repositoryId, { repositoryRoot: true }),
      "source-ref repository home",
    );
    const checkoutPath = exactNormalizedPath(
      this.#sourceRef.path(this.repositoryId),
      "source-ref checkout path",
    );
    assertPathBelow(this.sourceRoot, repositoryHome);
    assertPathBelow(repositoryHome, checkoutPath);
    assertPathContained(this.cacheRoot, checkoutPath);
    return { repositoryHome, checkoutPath };
  }

  async #assertLayoutBeforeMutation(paths: WorkspacePaths): Promise<void> {
    await assertPhysicalDirectoryIfPresent(this.cacheRoot, "manager cache root");
    await assertPhysicalDirectoryIfPresent(this.sourceRoot, "source workspace root");
    await assertPhysicalDirectoryIfPresent(paths.repositoryHome, "source repository home");
    await assertPhysicalDirectoryIfPresent(paths.checkoutPath, "source checkout");
  }

  async #assertPhysicalLayout(paths: WorkspacePaths): Promise<void> {
    await assertPhysicalDirectory(this.cacheRoot, "manager cache root");
    await assertPhysicalDirectory(this.sourceRoot, "source workspace root");
    await assertPhysicalDirectory(paths.repositoryHome, "source repository home");
    await assertPhysicalDirectory(paths.checkoutPath, "source checkout");
  }

  #assertCheckoutResult(
    checkout: CheckoutResult,
    paths: WorkspacePaths,
    ref: GitRef,
    commit: string,
  ): void {
    if (
      !sameRepositoryId(checkout.id, this.repositoryId) ||
      checkout.repositoryHome !== paths.repositoryHome ||
      checkout.checkoutPath !== paths.checkoutPath ||
      checkout.url !== this.#repositoryUrl ||
      checkout.mode !== "pinned" ||
      !sameRef(checkout.requested, ref) ||
      checkout.resolvedCommit !== commit
    ) {
      throw new ZigSourceNotReadyError("source-ref returned an unexpected checkout result", {
        expectedRepositoryHome: paths.repositoryHome,
        actualRepositoryHome: checkout.repositoryHome,
        expectedCheckoutPath: paths.checkoutPath,
        actualCheckoutPath: checkout.checkoutPath,
        expectedCommit: commit,
        actualCommit: checkout.resolvedCommit,
      });
    }
  }

  async #assertStatus(
    paths: WorkspacePaths,
    ref: GitRef,
    commit: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const statuses = await this.#sourceRef.status(this.repositoryId, { signal });
    if (statuses.length !== 1) {
      throw new ZigSourceNotReadyError("source-ref returned an unexpected status count", {
        expected: 1,
        actual: statuses.length,
      });
    }
    const status = statuses[0];
    if (status.dirty === true) {
      throw new ZigSourceNotReadyError("checkout contains local changes", {
        changes: status.changes,
      });
    }
    if (
      !sameRepositoryId(status.id, this.repositoryId) ||
      status.repositoryHome !== paths.repositoryHome ||
      status.checkoutPath !== paths.checkoutPath ||
      status.url !== this.#repositoryUrl ||
      status.mode !== "pinned" ||
      !sameRef(status.requested, ref) ||
      status.lockedCommit !== commit ||
      status.checkoutExists !== true ||
      status.currentCommit !== commit ||
      status.currentBranch !== null ||
      status.dirty !== false ||
      !Array.isArray(status.changes) ||
      status.changes.length !== 0 ||
      status.aheadBehind !== null ||
      status.matchesLock !== true
    ) {
      throw new ZigSourceNotReadyError("checkout status does not exactly match its source lock", {
        expectedCommit: commit,
        lockedCommit: status.lockedCommit,
        currentCommit: status.currentCommit,
        repositoryHome: status.repositoryHome,
        checkoutPath: status.checkoutPath,
        dirty: status.dirty,
        matchesLock: status.matchesLock,
      });
    }
  }
}

interface WorkspacePaths {
  readonly repositoryHome: string;
  readonly checkoutPath: string;
}

function resolutionFromSelection(
  selector: string,
  ref: GitRef,
  commitValue: string,
  now: () => Date,
): SourceWorkspaceResolution {
  const commit = remoteCommit(commitValue, selector);
  return {
    requestedSelector: selector,
    resolvedRef: { kind: ref.kind, value: ref.value },
    checkoutRef: { kind: ref.kind, value: ref.value } as GitRef,
    commit,
    resolvedAt: timestamp(now()),
  };
}

function validateSelectorSyntax(selector: string): void {
  if (selector === "latest" || selector === "stable") return;
  parseZigSelector(selector);
}

function remoteHeadBranch(value: unknown, selector: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value.trim() !== value ||
    /\p{Cc}/u.test(value)
  ) {
    throw new InvalidZigSelectorError(
      selector,
      "source-ref returned a malformed symbolic remote HEAD branch",
    );
  }
  return value;
}

function remoteCommit(value: unknown, selector: string): string {
  if (typeof value !== "string" || !REMOTE_OBJECT_ID.test(value)) {
    throw new InvalidZigSelectorError(
      selector,
      "source-ref returned a malformed remote commit ID",
    );
  }
  return value.toLowerCase();
}

function canonicalCheckoutCommit(value: unknown): string {
  if (typeof value !== "string" || !OBJECT_ID.test(value)) {
    throw new ZigSourceNotReadyError("source-ref returned a non-canonical checkout commit", {
      commit: value,
    });
  }
  return value;
}

function checkedExactSource(value: unknown, repositoryUrl: string): ResolvedSource {
  let source: ResolvedSource;
  try {
    source = validateResolvedSource(value);
  } catch (cause) {
    throw new ZigSourceNotReadyError("stored resolved source metadata is invalid", {
      cause: errorMessage(cause),
    });
  }
  if (
    source.component !== "zig" ||
    source.repository.identity !== ZIG_SOURCE_REPOSITORY_IDENTITY ||
    source.repository.url !== repositoryUrl
  ) {
    throw new ZigSourceNotReadyError("stored source repository does not match global config", {
      expectedIdentity: ZIG_SOURCE_REPOSITORY_IDENTITY,
      actualIdentity: source.repository.identity,
      expectedUrl: repositoryUrl,
      actualUrl: source.repository.url,
    });
  }
  return source;
}

function sameRepositoryId(left: RepositoryId, right: RepositoryId): boolean {
  return left.provider === right.provider && left.name === right.name;
}

function sameRef(left: GitRef, right: GitRef): boolean {
  return left.kind === right.kind && left.value === right.value;
}

function requiredCallback<T>(value: unknown): asserts value is (input: PreparedSource) => T {
  if (typeof value !== "function") throw new TypeError("source workspace callback is required");
}

function timestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("source workspace clock must return a valid Date");
  }
  return value.toISOString();
}

function normalizedRepositoryUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new TypeError("GlobalConfig.zigRepository must be an absolute URL", { cause });
  }
  if (
    url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
    url.search !== "" || url.hash !== "" || url.href !== value
  ) {
    throw new TypeError(
      "GlobalConfig.zigRepository must be a normalized credential-free HTTPS URL",
    );
  }
  return value;
}

function normalizedRoot(value: string, label: string): string {
  const path = normalizedPath(value, label);
  if (path === resolve("/")) throw new TypeError(`${label} must not be the filesystem root`);
  return path;
}

function normalizedPath(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0 || /\p{Cc}/u.test(value)) {
    throw new TypeError(`${label} must be a nonempty path without control characters`);
  }
  if (!isAbsolute(value)) throw new TypeError(`${label} must be absolute: ${value}`);
  return resolve(value);
}

function exactNormalizedPath(value: string, label: string): string {
  const normalized = normalizedPath(value, label);
  if (value !== normalized) {
    throw new ZigSourceNotReadyError(`${label} is not normalized`, { value });
  }
  return normalized;
}

async function assertPhysicalDirectoryIfPresent(path: string, label: string): Promise<void> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return;
    throw new ZigSourceNotReadyError(`${label} could not be inspected`, {
      path,
      cause: errorMessage(cause),
    });
  }
  await assertPhysicalDirectoryInfo(path, label, info);
}

async function assertPhysicalDirectory(path: string, label: string): Promise<void> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (cause) {
    throw new ZigSourceNotReadyError(`${label} could not be inspected`, {
      path,
      cause: errorMessage(cause),
    });
  }
  await assertPhysicalDirectoryInfo(path, label, info);
}

async function assertPhysicalDirectoryInfo(
  path: string,
  label: string,
  info: Deno.FileInfo,
): Promise<void> {
  if (!info.isDirectory || info.isSymlink) {
    throw new ZigSourceNotReadyError(`${label} is not a physical directory`, { path });
  }
  let physical: string;
  try {
    physical = resolve(await Deno.realPath(path));
  } catch (cause) {
    throw new ZigSourceNotReadyError(`${label} could not be resolved`, {
      path,
      cause: errorMessage(cause),
    });
  }
  if (physical !== resolve(path)) {
    throw new ZigSourceNotReadyError(`${label} traverses a symbolic link`, {
      path,
      physical,
    });
  }
}

function errorCode(cause: unknown): string | null {
  if (cause === null || typeof cause !== "object") return null;
  const value = (cause as { readonly code?: unknown }).code;
  return typeof value === "string" ? value : null;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function throwIfAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted) throw aborted(operation, signal);
}

function aborted(
  operation: string,
  signal: AbortSignal,
  cause: unknown = signal.reason,
): ZigOperationAbortedError {
  return new ZigOperationAbortedError(operation, {}, { cause });
}
