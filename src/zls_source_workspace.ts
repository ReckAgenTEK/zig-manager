import {
  type CheckoutResult,
  type DescribeRevisionOptions,
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
  type RevisionDescription,
  SourceRefStore,
  type StatusOptions,
  type UpdateOptions,
} from "@reckagentek/source-ref";
import { isAbsolute, join, relative, resolve } from "@std/path";
import { GlobalOperationLockManager } from "./global_operation_lock.ts";
import {
  parseZlsStableTag,
  readZlsSourceMetadata,
  selectZlsStableTags,
  validateZlsSourceVersion,
  type ZlsSourceVersion,
  type ZlsZigCompatibility,
} from "./zls_source_version.ts";

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REMOTE_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export const ZLS_SOURCE_REPOSITORY_URL = "https://github.com/zigtools/zls.git" as const;
export const ZLS_SOURCE_REPOSITORY_ID: RepositoryId = Object.freeze({
  provider: "github",
  name: "zls",
});
export const ZLS_SOURCE_REPOSITORY_IDENTITY = "github/zls" as const;

export type ZlsResolvedRefKind = "head" | "tag" | "branch" | "commit";

export type ZlsSourceSelector =
  | { readonly kind: "latest" }
  | { readonly kind: "tag"; readonly value: string }
  | { readonly kind: "branch"; readonly value: string }
  | { readonly kind: "commit"; readonly value: string };

export interface ResolvedZlsSource {
  readonly component: "zls";
  readonly repository: {
    readonly identity: typeof ZLS_SOURCE_REPOSITORY_IDENTITY;
    readonly url: typeof ZLS_SOURCE_REPOSITORY_URL;
  };
  readonly requestedSelector: string;
  readonly resolvedRef: {
    readonly kind: ZlsResolvedRefKind;
    readonly value: string;
  };
  readonly commit: string;
  readonly version: string;
  readonly versionMetadata: ZlsSourceVersion;
  readonly resolvedAt: string;
}

/** The public source-ref surface needed by the ZLS source workspace. */
export interface ZlsSourceWorkspaceSourceRef {
  resolveRemoteHead(request: ResolveRemoteHeadRequest): Promise<RemoteHead>;
  listRemoteRefs(request: ListRemoteRefsRequest): Promise<RemoteRef[]>;
  ensure(request: EnsureRequest): Promise<CheckoutResult>;
  update(selector: RepositorySelector, options?: UpdateOptions): Promise<CheckoutResult>;
  describeRevision(
    selector: RepositorySelector,
    options?: DescribeRevisionOptions,
  ): Promise<RevisionDescription>;
  status(selector?: RepositorySelector, options?: StatusOptions): Promise<RepositoryStatus[]>;
  path(selector: RepositorySelector, options?: PathOptions): string;
}

export interface ZlsSourceWorkspaceLockLease {
  readonly owner: { readonly operationId: string };
  release(): Promise<void>;
}

export interface ZlsSourceWorkspaceLockManager {
  acquireSource(options: {
    readonly operation: string;
    readonly operationId?: string;
    readonly scope?: string;
    readonly selector?: string;
    readonly signal?: AbortSignal;
    readonly wait?: { readonly timeoutMs?: number; readonly pollIntervalMs?: number };
  }): Promise<ZlsSourceWorkspaceLockLease>;
}

export type ZlsSourceWorkspaceProgress = (message: string) => void | Promise<void>;

export interface ZlsSourceWorkspaceOptions {
  readonly cacheRoot: string;
  readonly stateRoot: string;
  /** Defaults to `<cacheRoot>/sources`. */
  readonly sourceRoot?: string;
  /** Defaults to `<stateRoot>/source-ref.lock.json`. */
  readonly sourceRefLockFile?: string;
  readonly sourceRef?: ZlsSourceWorkspaceSourceRef;
  readonly lockManager?: ZlsSourceWorkspaceLockManager;
  readonly now?: () => Date;
  readonly progress?: ZlsSourceWorkspaceProgress;
}

export interface ResolveZlsSourceOptions {
  readonly signal?: AbortSignal;
}

export interface PrepareZlsSourceOptions extends ResolveZlsSourceOptions {
  readonly operation?: string;
  readonly operationId?: string;
  readonly scope?: string;
}

export interface ZlsSourceWorkspaceResolution {
  readonly requestedSelector: string;
  readonly resolvedRef: {
    readonly kind: ZlsResolvedRefKind;
    readonly value: string;
  };
  /** The source-ref ref used to materialize the observed commit. */
  readonly checkoutRef: GitRef;
  readonly commit: string;
  readonly resolvedAt: string;
}

export interface PreparedZlsSource {
  readonly operationId: string;
  readonly source: ResolvedZlsSource;
  readonly version: ZlsSourceVersion;
  readonly zigCompatibility: ZlsZigCompatibility;
  readonly checkout: CheckoutResult;
  readonly revision: RevisionDescription;
  readonly repositoryHome: string;
  readonly checkoutPath: string;
}

export interface PrepareStableZlsSourceOptions extends PrepareZlsSourceOptions {
  /** Accepts a materialized stable candidate before the install callback runs. */
  readonly acceptStable?: (prepared: PreparedZlsSource) => boolean | Promise<boolean>;
}

export type ZlsSourceWorkspaceErrorCode =
  | "ZLS_SOURCE_SELECTOR_INVALID"
  | "ZLS_SOURCE_VERSION_NOT_FOUND"
  | "ZLS_SOURCE_NOT_READY"
  | "ZLS_SOURCE_OPERATION_ABORTED";

export class ZlsSourceWorkspaceError extends Error {
  readonly code: ZlsSourceWorkspaceErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ZlsSourceWorkspaceErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
  }
}

export class InvalidZlsSourceSelectorError extends ZlsSourceWorkspaceError {
  constructor(selector: string, reason: string) {
    super(
      "ZLS_SOURCE_SELECTOR_INVALID",
      `Invalid ZLS source selector '${selector}': ${reason}`,
      { selector, reason },
    );
  }
}

export class ZlsSourceVersionNotFoundError extends ZlsSourceWorkspaceError {
  constructor(selector: string) {
    super(
      "ZLS_SOURCE_VERSION_NOT_FOUND",
      `No remote ZLS reference matches selector '${selector}'`,
      { selector },
    );
  }
}

export class ZlsSourceNotReadyError extends ZlsSourceWorkspaceError {
  constructor(
    reason: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(
      "ZLS_SOURCE_NOT_READY",
      `Selected ZLS source is not ready: ${reason}`,
      { reason, ...details },
      options,
    );
  }
}

export class ZlsSourceOperationAbortedError extends ZlsSourceWorkspaceError {
  constructor(operation: string, options?: ErrorOptions) {
    super(
      "ZLS_SOURCE_OPERATION_ABORTED",
      `ZLS source operation was aborted: ${operation}`,
      { operation },
      options,
    );
  }
}

/** Owns the one mutable global ZLS checkout while a prepared-source callback is running. */
export class ZlsSourceWorkspace {
  readonly cacheRoot: string;
  readonly stateRoot: string;
  readonly sourceRoot: string;
  readonly sourceRefLockFile: string;
  readonly repositoryId: RepositoryId = ZLS_SOURCE_REPOSITORY_ID;

  readonly #sourceRef: ZlsSourceWorkspaceSourceRef;
  readonly #locks: ZlsSourceWorkspaceLockManager;
  readonly #now: () => Date;
  readonly #progress: ZlsSourceWorkspaceProgress;

  constructor(options: ZlsSourceWorkspaceOptions) {
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
    assertPathBelow(this.cacheRoot, this.sourceRoot, "sourceRoot");
    assertPathBelow(this.stateRoot, this.sourceRefLockFile, "sourceRefLockFile");

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

  /** Resolves a selector to the exact remote commit observed now without moving the checkout. */
  async resolve(
    selector: string,
    options: ResolveZlsSourceOptions = {},
  ): Promise<ZlsSourceWorkspaceResolution> {
    const parsed = parseZlsSourceSelector(selector);
    throwIfAborted(options.signal, `resolve ZLS source '${selector}'`);

    if (parsed.kind === "latest") {
      const head = await this.#sourceRef.resolveRemoteHead({
        url: ZLS_SOURCE_REPOSITORY_URL,
        signal: options.signal,
      });
      throwIfAborted(options.signal, `resolve ZLS source '${selector}'`);
      const branch = remoteHeadBranch(head.branch, selector);
      return {
        requestedSelector: selector,
        resolvedRef: { kind: "head", value: branch },
        checkoutRef: { kind: "branch", value: branch },
        commit: remoteCommit(head.commit, selector),
        resolvedAt: timestamp(this.#now()),
      };
    }

    if (parsed.kind === "commit") {
      return {
        requestedSelector: selector,
        resolvedRef: { kind: "commit", value: parsed.value },
        checkoutRef: { kind: "commit", value: parsed.value },
        commit: parsed.value,
        resolvedAt: timestamp(this.#now()),
      };
    }

    const refs = await this.#sourceRef.listRemoteRefs({
      url: ZLS_SOURCE_REPOSITORY_URL,
      kind: parsed.kind,
      signal: options.signal,
    });
    throwIfAborted(options.signal, `resolve ZLS source '${selector}'`);
    const selected = refs.find((ref) => ref.kind === parsed.kind && ref.name === parsed.value);
    if (selected === undefined) throw new ZlsSourceVersionNotFoundError(selector);
    const commit = remoteCommit(selected.commit, selector);
    return {
      requestedSelector: selector,
      resolvedRef: { kind: parsed.kind, value: parsed.value },
      checkoutRef: { kind: parsed.kind, value: parsed.value },
      commit,
      resolvedAt: timestamp(this.#now()),
    };
  }

  /** Resolves the highest strict ZLS tag in one Zig major/minor release cycle. */
  async resolveStable(
    major: number,
    minor: number,
    options: ResolveZlsSourceOptions = {},
  ): Promise<ZlsSourceWorkspaceResolution> {
    return (await this.#resolveStableCandidates(major, minor, options))[0];
  }

  /** Resolves, validates, and exposes source while retaining the manager source lock. */
  async prepare<T>(
    selector: string,
    callback: (prepared: PreparedZlsSource) => T | Promise<T>,
    options: PrepareZlsSourceOptions = {},
  ): Promise<T> {
    parseZlsSourceSelector(selector);
    requiredCallback(callback);
    const lease = await this.#locks.acquireSource({
      operation: options.operation ?? "prepare ZLS source",
      ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
      selector,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    try {
      throwIfAborted(options.signal, `prepare ZLS source '${selector}'`);
      await this.#progress(`Resolving ZLS source '${selector}'...\n`);
      const resolution = await this.resolve(selector, options);
      throwIfAborted(options.signal, `prepare ZLS source '${selector}'`);
      await this.#progress(`Preparing ZLS source '${selector}' at ${resolution.commit}...\n`);
      const prepared = await this.#materialize(
        resolution,
        lease.owner.operationId,
        options.signal,
      );
      throwIfAborted(options.signal, `prepare ZLS source '${selector}'`);
      return await callback(prepared);
    } catch (cause) {
      if (options.signal?.aborted && !(cause instanceof ZlsSourceOperationAbortedError)) {
        throw aborted(`prepare ZLS source '${selector}'`, options.signal, cause);
      }
      throw cause;
    } finally {
      await lease.release();
    }
  }

  /** Prepares strict cycle tags newest-first until the optional predicate accepts one. */
  async prepareStable<T>(
    major: number,
    minor: number,
    callback: (prepared: PreparedZlsSource) => T | Promise<T>,
    options: PrepareStableZlsSourceOptions = {},
  ): Promise<T> {
    requiredCallback(callback);
    if (options.acceptStable !== undefined && typeof options.acceptStable !== "function") {
      throw new TypeError("ZLS stable candidate predicate must be a function");
    }
    const cycle = `${major}.${minor}`;
    const lease = await this.#locks.acquireSource({
      operation: options.operation ?? `prepare stable ZLS cycle ${cycle}`,
      ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
      selector: cycle,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    try {
      throwIfAborted(options.signal, `prepare stable ZLS cycle ${cycle}`);
      await this.#progress(`Resolving stable ZLS cycle '${cycle}'...\n`);
      const resolutions = await this.#resolveStableCandidates(major, minor, options);
      for (const resolution of resolutions) {
        throwIfAborted(options.signal, `prepare stable ZLS cycle ${cycle}`);
        await this.#progress(
          `Preparing ZLS source '${resolution.requestedSelector}' at ${resolution.commit}...\n`,
        );
        const prepared = await this.#materialize(
          resolution,
          lease.owner.operationId,
          options.signal,
        );
        throwIfAborted(options.signal, `prepare stable ZLS cycle ${cycle}`);
        if (options.acceptStable !== undefined && !(await options.acceptStable(prepared))) {
          continue;
        }
        throwIfAborted(options.signal, `prepare stable ZLS cycle ${cycle}`);
        return await callback(prepared);
      }
      throw new ZlsSourceVersionNotFoundError(`${major}.${minor}.x`);
    } catch (cause) {
      if (options.signal?.aborted && !(cause instanceof ZlsSourceOperationAbortedError)) {
        throw aborted(`prepare stable ZLS cycle ${cycle}`, options.signal, cause);
      }
      throw cause;
    } finally {
      await lease.release();
    }
  }

  async #resolveStableCandidates(
    major: number,
    minor: number,
    options: ResolveZlsSourceOptions,
  ): Promise<readonly ZlsSourceWorkspaceResolution[]> {
    const cycle = `${major}.${minor}`;
    throwIfAborted(options.signal, `resolve stable ZLS cycle ${cycle}`);
    const refs = await this.#sourceRef.listRemoteRefs({
      url: ZLS_SOURCE_REPOSITORY_URL,
      kind: "tag",
      signal: options.signal,
    });
    throwIfAborted(options.signal, `resolve stable ZLS cycle ${cycle}`);
    const selected = selectZlsStableTags(refs, major, minor);
    if (selected.length === 0) throw new ZlsSourceVersionNotFoundError(`${cycle}.x`);
    const resolvedAt = timestamp(this.#now());
    return selected.map((candidate) => ({
      requestedSelector: candidate.tag,
      resolvedRef: { kind: "tag", value: candidate.tag },
      checkoutRef: { kind: "tag", value: candidate.tag },
      commit: remoteCommit(candidate.commit, candidate.tag),
      resolvedAt,
    }));
  }

  /** Reconstructs stored ZLS source without remote HEAD/ref discovery or reading the clock. */
  async prepareExact<T>(
    sourceValue: ResolvedZlsSource,
    callback: (prepared: PreparedZlsSource) => T | Promise<T>,
    options: PrepareZlsSourceOptions = {},
  ): Promise<T> {
    requiredCallback(callback);
    const source = checkedExactSource(sourceValue);
    const lease = await this.#locks.acquireSource({
      operation: options.operation ?? "prepare exact ZLS source",
      ...(options.operationId === undefined ? {} : { operationId: options.operationId }),
      selector: source.requestedSelector,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    try {
      throwIfAborted(options.signal, "prepare exact ZLS source");
      await this.#progress(`Preparing exact ZLS source at ${source.commit}...\n`);
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
      throwIfAborted(options.signal, "prepare exact ZLS source");
      return await callback(prepared);
    } catch (cause) {
      if (options.signal?.aborted && !(cause instanceof ZlsSourceOperationAbortedError)) {
        throw aborted("prepare exact ZLS source", options.signal, cause);
      }
      throw cause;
    } finally {
      await lease.release();
    }
  }

  async #materialize(
    resolution: ZlsSourceWorkspaceResolution,
    operationId: string,
    signal?: AbortSignal,
    exactSource?: ResolvedZlsSource,
  ): Promise<PreparedZlsSource> {
    throwIfAborted(signal, "materialize ZLS source");
    const paths = this.#expectedPaths();
    await this.#assertLayoutBeforeMutation(paths);
    throwIfAborted(signal, "materialize ZLS source");

    const checkout = await this.#updateOrEnsure(resolution.checkoutRef, signal);
    throwIfAborted(signal, "materialize ZLS source");
    const checkoutCommit = canonicalCheckoutCommit(checkout.resolvedCommit);
    if (checkoutCommit !== resolution.commit) {
      if (exactSource !== undefined) {
        throw new ZlsSourceNotReadyError("checkout did not reach the stored exact commit", {
          expectedCommit: resolution.commit,
          actualCommit: checkoutCommit,
        });
      }
      throw new ZlsSourceVersionNotFoundError(
        `${resolution.requestedSelector} (remote changed while the checkout was being resolved)`,
      );
    }
    this.#assertCheckoutResult(checkout, paths, resolution.checkoutRef, resolution.commit);
    await this.#assertPhysicalLayout(paths);
    await this.#assertStatus(paths, resolution.checkoutRef, resolution.commit, signal);
    throwIfAborted(signal, "materialize ZLS source");

    const revision = await this.#sourceRef.describeRevision(this.repositoryId, {
      tagPattern: "*.*.*",
      abbreviationLength: 9,
      signal,
    });
    throwIfAborted(signal, "materialize ZLS source");
    const describedCommit = canonicalCheckoutCommit(revision.commit);
    if (describedCommit !== resolution.commit) {
      throw new ZlsSourceNotReadyError("revision description does not match the locked commit", {
        expectedCommit: resolution.commit,
        describedCommit,
      });
    }

    const metadata = await readZlsSourceMetadata(paths.checkoutPath, revision);
    const { version, zigCompatibility } = metadata;
    throwIfAborted(signal, "materialize ZLS source");
    if (exactSource !== undefined && version.text !== exactSource.version) {
      throw new ZlsSourceNotReadyError("derived version does not match the stored exact source", {
        commit: resolution.commit,
        expectedVersion: exactSource.version,
        actualVersion: version.text,
      });
    }
    if (exactSource !== undefined && !sameSourceVersion(version, exactSource.versionMetadata)) {
      throw new ZlsSourceNotReadyError(
        "derived structured version does not match the stored exact source",
        { commit: resolution.commit },
      );
    }

    const source = exactSource ?? validateResolvedZlsSource({
      component: "zls",
      repository: {
        identity: ZLS_SOURCE_REPOSITORY_IDENTITY,
        url: ZLS_SOURCE_REPOSITORY_URL,
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
      zigCompatibility,
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
        url: ZLS_SOURCE_REPOSITORY_URL,
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
    assertPathBelow(this.sourceRoot, repositoryHome, "source-ref repository home");
    assertPathBelow(repositoryHome, checkoutPath, "source-ref checkout path");
    assertPathContained(this.cacheRoot, checkoutPath, "source-ref checkout path");
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
      checkout.url !== ZLS_SOURCE_REPOSITORY_URL || checkout.mode !== "pinned" ||
      !sameRef(checkout.requested, ref) || checkout.resolvedCommit !== commit
    ) {
      throw new ZlsSourceNotReadyError("source-ref returned an unexpected checkout result", {
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
      throw new ZlsSourceNotReadyError("source-ref returned an unexpected status count", {
        expected: 1,
        actual: statuses.length,
      });
    }
    const status = statuses[0];
    if (status.dirty === true) {
      throw new ZlsSourceNotReadyError("checkout contains local changes", {
        changes: status.changes,
      });
    }
    if (
      !sameRepositoryId(status.id, this.repositoryId) ||
      status.repositoryHome !== paths.repositoryHome ||
      status.checkoutPath !== paths.checkoutPath || status.url !== ZLS_SOURCE_REPOSITORY_URL ||
      status.mode !== "pinned" || !sameRef(status.requested, ref) ||
      status.lockedCommit !== commit || status.checkoutExists !== true ||
      status.currentCommit !== commit || status.currentBranch !== null || status.dirty !== false ||
      !Array.isArray(status.changes) || status.changes.length !== 0 ||
      status.aheadBehind !== null || status.matchesLock !== true
    ) {
      throw new ZlsSourceNotReadyError(
        "checkout status does not exactly match its source lock",
        {
          expectedCommit: commit,
          lockedCommit: status.lockedCommit,
          currentCommit: status.currentCommit,
          repositoryHome: status.repositoryHome,
          checkoutPath: status.checkoutPath,
          dirty: status.dirty,
          matchesLock: status.matchesLock,
        },
      );
    }
  }
}

interface WorkspacePaths {
  readonly repositoryHome: string;
  readonly checkoutPath: string;
}

export function parseZlsSourceSelector(selector: string): ZlsSourceSelector {
  if (typeof selector !== "string" || selector.length === 0 || selector.trim() !== selector) {
    throw new InvalidZlsSourceSelectorError(
      String(selector),
      "selector must be nonempty without surrounding whitespace",
    );
  }
  if (/\p{Cc}/u.test(selector)) {
    throw new InvalidZlsSourceSelectorError(selector, "selector contains a control character");
  }
  if (selector === "latest") return { kind: "latest" };

  const stable = parseZlsStableTag(selector);
  if (stable !== null) return { kind: "tag", value: stable.text };
  if (selector.startsWith("tag:")) {
    const value = selector.slice("tag:".length);
    if (parseZlsStableTag(value) === null) {
      throw new InvalidZlsSourceSelectorError(
        selector,
        "tag must be an exact strict major.minor.patch ZLS release",
      );
    }
    return { kind: "tag", value };
  }
  if (selector.startsWith("branch:")) {
    const value = selector.slice("branch:".length);
    if (value.length === 0 || value.trim() !== value) {
      throw new InvalidZlsSourceSelectorError(
        selector,
        "branch name must be nonempty without surrounding whitespace",
      );
    }
    return { kind: "branch", value };
  }
  if (selector.startsWith("commit:")) {
    const value = selector.slice("commit:".length);
    if (!REMOTE_OBJECT_ID.test(value)) {
      throw new InvalidZlsSourceSelectorError(
        selector,
        "commit must be an exact 40- or 64-digit object ID",
      );
    }
    return { kind: "commit", value: value.toLowerCase() };
  }
  throw new InvalidZlsSourceSelectorError(
    selector,
    "expected latest, x.y.z, tag:x.y.z, branch:<name>, or commit:<object-id>",
  );
}

export function validateResolvedZlsSource(
  value: unknown,
  path = "source",
): ResolvedZlsSource {
  const item = requiredRecord(value, path);
  assertExactKeys(item, [
    "component",
    "repository",
    "requestedSelector",
    "resolvedRef",
    "commit",
    "version",
    "versionMetadata",
    "resolvedAt",
  ], path);
  if (item.component !== "zls") throw new Error(`${path}.component must be 'zls'`);

  const repository = requiredRecord(item.repository, `${path}.repository`);
  assertExactKeys(repository, ["identity", "url"], `${path}.repository`);
  if (repository.identity !== ZLS_SOURCE_REPOSITORY_IDENTITY) {
    throw new Error(`${path}.repository.identity must be '${ZLS_SOURCE_REPOSITORY_IDENTITY}'`);
  }
  if (repository.url !== ZLS_SOURCE_REPOSITORY_URL) {
    throw new Error(`${path}.repository.url must be '${ZLS_SOURCE_REPOSITORY_URL}'`);
  }

  const requestedSelector = requiredText(item.requestedSelector, `${path}.requestedSelector`);
  const selector = parseZlsSourceSelector(requestedSelector);
  const resolvedRefValue = requiredRecord(item.resolvedRef, `${path}.resolvedRef`);
  assertExactKeys(resolvedRefValue, ["kind", "value"], `${path}.resolvedRef`);
  const refKind = resolvedRefValue.kind;
  if (refKind !== "head" && refKind !== "tag" && refKind !== "branch" && refKind !== "commit") {
    throw new Error(`${path}.resolvedRef.kind is invalid`);
  }
  const refValue = requiredText(resolvedRefValue.value, `${path}.resolvedRef.value`);
  if (refKind === "tag" && parseZlsStableTag(refValue) === null) {
    throw new Error(`${path}.resolvedRef.value must be a strict stable ZLS tag`);
  }
  if (
    refKind === "commit" &&
    canonicalStoredCommit(refValue, `${path}.resolvedRef.value`) !== refValue
  ) {
    throw new Error(`${path}.resolvedRef.value must be a canonical object ID`);
  }
  if (
    (refKind === "head" || refKind === "branch") &&
    (refValue.trim() !== refValue || /\p{Cc}/u.test(refValue))
  ) {
    throw new Error(`${path}.resolvedRef.value is not a canonical branch name`);
  }
  assertSelectorResolution(selector, refKind, refValue, path);

  const commit = canonicalStoredCommit(item.commit, `${path}.commit`);
  if (refKind === "commit" && refValue !== commit) {
    throw new Error(`${path}.resolvedRef.value must match ${path}.commit`);
  }
  const version = requiredText(item.version, `${path}.version`);
  let versionMetadata: ZlsSourceVersion;
  try {
    versionMetadata = validateZlsSourceVersion(item.versionMetadata, `${path}.versionMetadata`);
  } catch (cause) {
    throw new Error(errorMessage(cause), { cause });
  }
  if (version !== versionMetadata.text) {
    throw new Error(`${path}.version must match ${path}.versionMetadata.text`);
  }
  if (!commit.startsWith(versionMetadata.commitAbbreviation)) {
    throw new Error(`${path}.versionMetadata.commitAbbreviation does not identify the commit`);
  }
  const resolvedAt = canonicalTimestamp(item.resolvedAt, `${path}.resolvedAt`);
  return {
    component: "zls",
    repository: {
      identity: ZLS_SOURCE_REPOSITORY_IDENTITY,
      url: ZLS_SOURCE_REPOSITORY_URL,
    },
    requestedSelector,
    resolvedRef: { kind: refKind, value: refValue },
    commit,
    version,
    versionMetadata,
    resolvedAt,
  };
}

function checkedExactSource(value: unknown): ResolvedZlsSource {
  try {
    return validateResolvedZlsSource(value);
  } catch (cause) {
    throw new ZlsSourceNotReadyError("stored resolved source metadata is invalid", {
      cause: errorMessage(cause),
    }, { cause });
  }
}

function assertSelectorResolution(
  selector: ZlsSourceSelector,
  refKind: ZlsResolvedRefKind,
  refValue: string,
  path: string,
): void {
  if (selector.kind === "latest") {
    if (refKind !== "head") throw new Error(`${path}.resolvedRef must preserve symbolic HEAD`);
    return;
  }
  if (selector.kind !== refKind || selector.value !== refValue) {
    throw new Error(`${path}.resolvedRef does not match ${path}.requestedSelector`);
  }
}

function remoteHeadBranch(value: unknown, selector: string): string {
  if (
    typeof value !== "string" || value.length === 0 || value.trim() !== value ||
    /\p{Cc}/u.test(value)
  ) {
    throw new ZlsSourceNotReadyError("source-ref returned a malformed symbolic remote HEAD", {
      selector,
      branch: value,
    });
  }
  return value;
}

function remoteCommit(value: unknown, selector: string): string {
  if (typeof value !== "string" || !REMOTE_OBJECT_ID.test(value)) {
    throw new ZlsSourceNotReadyError("source-ref returned a malformed remote commit ID", {
      selector,
      commit: value,
    });
  }
  return value.toLowerCase();
}

function canonicalCheckoutCommit(value: unknown): string {
  if (typeof value !== "string" || !OBJECT_ID.test(value)) {
    throw new ZlsSourceNotReadyError("source-ref returned a non-canonical checkout commit", {
      commit: value,
    });
  }
  return value;
}

function canonicalStoredCommit(value: unknown, path: string): string {
  if (typeof value !== "string" || !OBJECT_ID.test(value)) {
    throw new Error(`${path} must be a lowercase 40- or 64-digit object ID`);
  }
  return value;
}

function sameSourceVersion(left: ZlsSourceVersion, right: ZlsSourceVersion): boolean {
  return left.kind === right.kind && left.declaredVersion === right.declaredVersion &&
    left.base === right.base && left.text === right.text &&
    left.versionString === right.versionString && left.taggedAncestor === right.taggedAncestor &&
    left.commitsAfterTag === right.commitsAfterTag &&
    left.commitAbbreviation === right.commitAbbreviation;
}

function sameRepositoryId(left: RepositoryId, right: RepositoryId): boolean {
  return left.provider === right.provider && left.name === right.name;
}

function sameRef(left: GitRef, right: GitRef): boolean {
  return left.kind === right.kind && left.value === right.value;
}

function requiredCallback<T>(value: unknown): asserts value is (input: PreparedZlsSource) => T {
  if (typeof value !== "function") throw new TypeError("ZLS source workspace callback is required");
}

function timestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("ZLS source workspace clock must return a valid Date");
  }
  return value.toISOString();
}

function canonicalTimestamp(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} must be a canonical timestamp`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`${path} must be a canonical timestamp`);
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
    throw new ZlsSourceNotReadyError(`${label} is not normalized`, { value });
  }
  return normalized;
}

function assertPathContained(root: string, candidate: string, label: string): void {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  const rel = relative(normalizedRoot, normalizedCandidate);
  const separator = Deno.build.os === "windows" ? "\\" : "/";
  if (rel === ".." || rel.startsWith(`..${separator}`) || isAbsolute(rel)) {
    throw new TypeError(`${label} must be contained by ${normalizedRoot}: ${normalizedCandidate}`);
  }
}

function assertPathBelow(root: string, candidate: string, label: string): void {
  assertPathContained(root, candidate, label);
  if (resolve(root) === resolve(candidate)) {
    throw new TypeError(`${label} must be below ${resolve(root)}`);
  }
}

async function assertPhysicalDirectoryIfPresent(path: string, label: string): Promise<void> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return;
    throw new ZlsSourceNotReadyError(`${label} could not be inspected`, {
      path,
      cause: errorMessage(cause),
    }, { cause });
  }
  await assertPhysicalDirectoryInfo(path, label, info);
}

async function assertPhysicalDirectory(path: string, label: string): Promise<void> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (cause) {
    throw new ZlsSourceNotReadyError(`${label} could not be inspected`, {
      path,
      cause: errorMessage(cause),
    }, { cause });
  }
  await assertPhysicalDirectoryInfo(path, label, info);
}

async function assertPhysicalDirectoryInfo(
  path: string,
  label: string,
  info: Deno.FileInfo,
): Promise<void> {
  if (!info.isDirectory || info.isSymlink) {
    throw new ZlsSourceNotReadyError(`${label} is not a physical directory`, { path });
  }
  let physical: string;
  try {
    physical = resolve(await Deno.realPath(path));
  } catch (cause) {
    throw new ZlsSourceNotReadyError(`${label} could not be resolved`, {
      path,
      cause: errorMessage(cause),
    }, { cause });
  }
  if (physical !== resolve(path)) {
    throw new ZlsSourceNotReadyError(`${label} traverses a symbolic link`, {
      path,
      physical,
    });
  }
}

function requiredRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key)).sort();
  if (unknown.length > 0) throw new Error(`${path} contains unknown key '${unknown[0]}'`);
  for (const key of keys) if (!(key in value)) throw new Error(`${path}.${key} is required`);
}

function requiredText(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a nonempty string`);
  }
  return value;
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
): ZlsSourceOperationAbortedError {
  return new ZlsSourceOperationAbortedError(operation, { cause });
}
