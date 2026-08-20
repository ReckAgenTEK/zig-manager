import { basename, dirname, isAbsolute, relative, resolve } from "@std/path";

export const GLOBAL_OPERATION_LOCK_OWNER_SCHEMA_VERSION = 1 as const;
export const GLOBAL_OPERATION_LOCK_OWNER_FILE = "owner.json";
export const GLOBAL_OPERATION_LOCK_MAX_OWNER_BYTES = 64 * 1024;

const SAFE_KEY = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OWNER_KEYS = new Set([
  "schemaVersion",
  "operationId",
  "pid",
  "operation",
  "scope",
  "selector",
  "startedAt",
]);

export type GlobalOperationLockTarget =
  | { readonly kind: "source" }
  | { readonly kind: "catalog" }
  | { readonly kind: "global" }
  | { readonly kind: "scope"; readonly scopeKey: string }
  | { readonly kind: "install"; readonly installationId: string };

export interface GlobalOperationLockOwner {
  readonly schemaVersion: 1;
  readonly operationId: string;
  readonly pid: number;
  readonly operation: string;
  readonly scope?: string;
  readonly selector?: string;
  readonly startedAt: string;
}

export interface GlobalOperationLockWaitOptions {
  /** Optional total contention wait. Zero performs one inspection and then times out. */
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export interface GlobalOperationLockAcquireOptions {
  readonly operation: string;
  readonly operationId?: string;
  readonly scope?: string;
  readonly selector?: string;
  readonly signal?: AbortSignal;
  /** Omit for fail-fast acquisition. An empty object waits until acquisition or cancellation. */
  readonly wait?: GlobalOperationLockWaitOptions;
}

export interface GlobalOperationLockOwnerEntry {
  readonly path: string;
  readonly target: GlobalOperationLockTarget;
  readonly owner: GlobalOperationLockOwner;
}

export interface GlobalOperationLockOwnerEnumeration {
  readonly owners: readonly GlobalOperationLockOwnerEntry[];
  /** Any entry here makes operation correlation incomplete and cleanup must be conservative. */
  readonly uncertain: readonly string[];
}

export type PidLivenessProbe = (pid: number) => boolean | Promise<boolean>;
export type OperationLockSleep = (milliseconds: number) => Promise<void>;

export interface GlobalOperationLockManagerOptions {
  readonly stateRoot: string;
  readonly pid?: number;
  readonly now?: () => Date;
  readonly monotonicNow?: () => number;
  readonly randomUUID?: () => string;
  readonly sleep?: OperationLockSleep;
  readonly isPidAlive?: PidLivenessProbe;
}

export type GlobalOperationLockErrorCode =
  | "LOCK_INVALID"
  | "LOCK_BUSY"
  | "LOCK_WAIT_TIMEOUT"
  | "LOCK_ABORTED"
  | "LOCK_OWNER_ALIVE"
  | "LOCK_OWNERSHIP_LOST"
  | "LOCK_IO";

export class GlobalOperationLockError extends Error {
  readonly code: GlobalOperationLockErrorCode;
  readonly lockPath: string;
  readonly owner: GlobalOperationLockOwner | null;

  constructor(
    code: GlobalOperationLockErrorCode,
    message: string,
    lockPath: string,
    owner: GlobalOperationLockOwner | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    this.lockPath = lockPath;
    this.owner = owner;
  }
}

export class GlobalOperationLockValidationError extends GlobalOperationLockError {
  constructor(lockPath: string, reason: string, options?: ErrorOptions) {
    super(
      "LOCK_INVALID",
      `Invalid operation lock '${lockPath}': ${reason}`,
      lockPath,
      null,
      options,
    );
  }
}

export class GlobalOperationLockBusyError extends GlobalOperationLockError {
  constructor(lockPath: string, owner: GlobalOperationLockOwner | null) {
    super(
      "LOCK_BUSY",
      owner === null
        ? "Another zm operation is running. Try again in a few minutes."
        : `Another zm operation is running (PID ${owner.pid}: ${owner.operation}). ` +
          "Try again in a few minutes.",
      lockPath,
      owner,
    );
  }
}

export class GlobalOperationLockTimeoutError extends GlobalOperationLockError {
  readonly timeoutMs: number;

  constructor(lockPath: string, timeoutMs: number, owner: GlobalOperationLockOwner | null) {
    super(
      "LOCK_WAIT_TIMEOUT",
      `Timed out after ${timeoutMs}ms waiting for operation lock: ${lockPath}`,
      lockPath,
      owner,
    );
    this.timeoutMs = timeoutMs;
  }
}

export class GlobalOperationLockAbortedError extends GlobalOperationLockError {
  constructor(lockPath: string, options?: ErrorOptions) {
    super(
      "LOCK_ABORTED",
      `Waiting for operation lock was aborted: ${lockPath}`,
      lockPath,
      null,
      options,
    );
  }
}

export class GlobalOperationLockOwnerAliveError extends GlobalOperationLockError {
  constructor(lockPath: string, owner: GlobalOperationLockOwner) {
    super(
      "LOCK_OWNER_ALIVE",
      `Refusing to unlock operation owned by live local PID ${owner.pid}: ${lockPath}`,
      lockPath,
      owner,
    );
  }
}

export class GlobalOperationLockOwnershipLostError extends GlobalOperationLockError {
  constructor(
    lockPath: string,
    expectedOperationId: string,
    owner: GlobalOperationLockOwner | null,
  ) {
    super(
      "LOCK_OWNERSHIP_LOST",
      `Operation lock ownership changed before release: ${lockPath} (expected ${expectedOperationId})`,
      lockPath,
      owner,
    );
  }
}

/** A held lock lease. Release compares the UUID before making the lock path available. */
export class GlobalOperationLock {
  readonly path: string;
  readonly target: GlobalOperationLockTarget;
  readonly owner: GlobalOperationLockOwner;
  readonly contended: boolean;
  readonly waitedMs: number;
  #releaseAction: () => Promise<void>;
  #releasePromise: Promise<void> | null = null;
  #released = false;

  constructor(
    path: string,
    target: GlobalOperationLockTarget,
    owner: GlobalOperationLockOwner,
    contended: boolean,
    waitedMs: number,
    releaseAction: () => Promise<void>,
  ) {
    this.path = path;
    this.target = target;
    this.owner = owner;
    this.contended = contended;
    this.waitedMs = waitedMs;
    this.#releaseAction = releaseAction;
  }

  get released(): boolean {
    return this.#released;
  }

  release(): Promise<void> {
    if (this.#released) return Promise.resolve();
    if (this.#releasePromise !== null) return this.#releasePromise;
    this.#releasePromise = this.#releaseAction().then(
      () => {
        this.#released = true;
      },
      (cause) => {
        this.#releasePromise = null;
        throw cause;
      },
    );
    return this.#releasePromise;
  }
}

/**
 * Manager-state directory locks. Contention probes the recorded local PID. Locks owned by a live
 * process remain authoritative; locks proven to belong to a dead process are removed atomically.
 * Every target is fail-fast unless the caller explicitly requests abortable waiting.
 */
export class GlobalOperationLockManager {
  readonly stateRoot: string;
  readonly locksRoot: string;
  readonly pid: number;
  readonly #now: () => Date;
  readonly #monotonicNow: () => number;
  readonly #randomUUID: () => string;
  readonly #sleep: OperationLockSleep;
  readonly #isPidAlive: PidLivenessProbe;

  constructor(options: GlobalOperationLockManagerOptions) {
    this.stateRoot = normalizeRoot(options.stateRoot, "stateRoot");
    this.locksRoot = containedChild(this.stateRoot, "locks");
    this.pid = positiveSafeInteger(options.pid ?? Deno.pid, "pid");
    this.#now = options.now ?? (() => new Date());
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.#randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    this.#sleep = options.sleep ?? defaultSleep;
    this.#isPidAlive = options.isPidAlive ?? defaultPidLivenessProbe;
  }

  pathFor(targetValue: GlobalOperationLockTarget): string {
    const target = validateTarget(targetValue);
    switch (target.kind) {
      case "source":
        return containedChild(this.locksRoot, "source.lock");
      case "catalog":
        return containedChild(this.locksRoot, "catalog.lock");
      case "global":
        return containedChild(this.locksRoot, "global.lock");
      case "scope":
        return containedChild(this.locksRoot, "scopes", `${target.scopeKey}.lock`);
      case "install":
        return containedChild(this.locksRoot, "installs", `${target.installationId}.lock`);
    }
  }

  async acquire(
    targetValue: GlobalOperationLockTarget,
    optionsValue: GlobalOperationLockAcquireOptions,
  ): Promise<GlobalOperationLock> {
    const target = validateTarget(targetValue);
    const options = validateAcquireOptions(target, optionsValue);
    const lockPath = this.pathFor(target);
    throwIfAborted(options.signal, lockPath);

    const operationId = validateUuid(options.operationId ?? this.#randomUUID(), "operationId");
    const startedAt = timestamp(this.#now(), "now()");
    const owner = validateGlobalOperationLockOwner({
      schemaVersion: GLOBAL_OPERATION_LOCK_OWNER_SCHEMA_VERSION,
      operationId,
      pid: this.pid,
      operation: options.operation,
      ...(options.scope === undefined ? {} : { scope: options.scope }),
      ...(options.selector === undefined ? {} : { selector: options.selector }),
      startedAt,
    });
    const wait = options.wait;
    const waitStarted = finiteNumber(this.#monotonicNow(), "monotonicNow()");
    let contended = false;
    let lastOwner: GlobalOperationLockOwner | null = null;

    await this.#ensureParent(target);
    while (true) {
      throwIfAborted(options.signal, lockPath);
      if (await this.#tryCreate(lockPath, owner)) {
        const waitedMs = Math.max(
          0,
          finiteNumber(this.#monotonicNow(), "monotonicNow()") - waitStarted,
        );
        return new GlobalOperationLock(
          lockPath,
          target,
          owner,
          contended,
          waitedMs,
          () => this.#releaseOwned(target, operationId),
        );
      }

      contended = true;
      lastOwner = await this.#inspectWithIncompleteRetry(target);
      if (lastOwner === null) continue;
      if (!await this.#ownerIsAlive(lastOwner, lockPath)) {
        try {
          await this.#removeOwned(target, lastOwner.operationId);
        } catch (cause) {
          // Release or replacement between inspection and compare-remove is harmless. Retry the
          // create/inspect cycle without touching the new owner.
          if (cause instanceof GlobalOperationLockOwnershipLostError) continue;
          throw cause;
        }
        continue;
      }
      if (wait === undefined) throw new GlobalOperationLockBusyError(lockPath, lastOwner);

      const elapsed = finiteNumber(this.#monotonicNow(), "monotonicNow()") - waitStarted;
      const remaining = wait.timeoutMs === null ? null : wait.timeoutMs - Math.max(0, elapsed);
      if (remaining !== null && remaining <= 0) {
        throw new GlobalOperationLockTimeoutError(lockPath, wait.timeoutMs!, lastOwner);
      }
      await this.#sleepAbortably(
        remaining === null ? wait.pollIntervalMs : Math.min(wait.pollIntervalMs, remaining),
        options.signal,
        lockPath,
      );
    }
  }

  acquireSource(
    options: GlobalOperationLockAcquireOptions,
  ): Promise<GlobalOperationLock> {
    return this.acquire({ kind: "source" }, options);
  }

  acquireCatalog(
    options: GlobalOperationLockAcquireOptions,
  ): Promise<GlobalOperationLock> {
    return this.acquire({ kind: "catalog" }, options);
  }

  acquireGlobal(
    options: GlobalOperationLockAcquireOptions,
  ): Promise<GlobalOperationLock> {
    return this.acquire({ kind: "global" }, options);
  }

  acquireScope(
    scopeKey: string,
    options: GlobalOperationLockAcquireOptions,
  ): Promise<GlobalOperationLock> {
    return this.acquire({ kind: "scope", scopeKey }, options);
  }

  acquireInstall(
    installationId: string,
    options: GlobalOperationLockAcquireOptions,
  ): Promise<GlobalOperationLock> {
    return this.acquire({ kind: "install", installationId }, options);
  }

  /** Read and strictly validate an existing owner. Missing locks return null. */
  async inspect(targetValue: GlobalOperationLockTarget): Promise<GlobalOperationLockOwner | null> {
    const target = validateTarget(targetValue);
    return await this.#inspectWithIncompleteRetry(target);
  }

  /** Enumerate retained owners without PID probing or mutation. Unverifiable entries are reported. */
  async enumerateOwners(): Promise<GlobalOperationLockOwnerEnumeration> {
    const owners: GlobalOperationLockOwnerEntry[] = [];
    const uncertain: string[] = [];
    const inspectTarget = async (target: GlobalOperationLockTarget) => {
      const path = this.pathFor(target);
      try {
        const owner = await this.#inspectWithIncompleteRetry(target);
        if (owner !== null) owners.push({ path, target, owner });
      } catch {
        uncertain.push(path);
      }
    };

    let stateInfo: Deno.FileInfo | null;
    try {
      stateInfo = await lstatIfPresent(this.stateRoot);
      if (stateInfo === null) return { owners, uncertain };
      await assertPhysicalDirectory(this.stateRoot, stateInfo, "state root");
    } catch {
      return { owners, uncertain: [this.stateRoot] };
    }

    let locksInfo: Deno.FileInfo | null;
    try {
      locksInfo = await lstatIfPresent(this.locksRoot);
      if (locksInfo === null) return { owners, uncertain };
      await assertPhysicalDirectory(this.locksRoot, locksInfo, "locks root");
    } catch {
      return { owners, uncertain: [this.locksRoot] };
    }

    let topEntries: Deno.DirEntry[];
    try {
      topEntries = [];
      for await (const entry of Deno.readDir(this.locksRoot)) topEntries.push(entry);
      topEntries.sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      return { owners, uncertain: [this.locksRoot] };
    }

    const topNames = new Set(topEntries.map((entry) => entry.name));
    if (topNames.has("source.lock")) await inspectTarget({ kind: "source" });
    if (topNames.has("catalog.lock")) await inspectTarget({ kind: "catalog" });
    if (topNames.has("global.lock")) await inspectTarget({ kind: "global" });

    for (const category of ["scopes", "installs"] as const) {
      if (!topNames.has(category)) continue;
      const categoryPath = containedChild(this.locksRoot, category);
      try {
        const info = await Deno.lstat(categoryPath);
        await assertPhysicalDirectory(categoryPath, info, "lock category");
        const entries: Deno.DirEntry[] = [];
        for await (const entry of Deno.readDir(categoryPath)) entries.push(entry);
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
          const match = /^([0-9a-f]{64})\.lock$/.exec(entry.name);
          if (match === null) {
            uncertain.push(containedChild(categoryPath, entry.name));
            continue;
          }
          await inspectTarget(
            category === "scopes"
              ? { kind: "scope", scopeKey: match[1] }
              : { kind: "install", installationId: match[1] },
          );
        }
      } catch {
        uncertain.push(categoryPath);
      }
    }

    for (const entry of topEntries) {
      if (
        entry.name !== "source.lock" && entry.name !== "catalog.lock" &&
        entry.name !== "global.lock" &&
        entry.name !== "scopes" && entry.name !== "installs"
      ) uncertain.push(resolve(this.locksRoot, entry.name));
    }
    owners.sort((left, right) => left.path.localeCompare(right.path));
    return { owners, uncertain: [...new Set(uncertain)].sort() };
  }

  /**
   * Explicit lock removal. Malformed owners are retained, and a live/unknown local PID is never
   * unlocked. Acquisition already removes well-formed locks proven to have dead owners.
   */
  async unlock(targetValue: GlobalOperationLockTarget): Promise<boolean> {
    const target = validateTarget(targetValue);
    const lockPath = this.pathFor(target);
    const owner = await this.#inspectWithIncompleteRetry(target);
    if (owner === null) return false;
    const alive = await this.#ownerIsAlive(owner, lockPath);
    if (alive) throw new GlobalOperationLockOwnerAliveError(lockPath, owner);
    await this.#removeOwned(target, owner.operationId);
    return true;
  }

  async #ownerIsAlive(owner: GlobalOperationLockOwner, lockPath: string): Promise<boolean> {
    try {
      const alive = await this.#isPidAlive(owner.pid);
      if (typeof alive !== "boolean") {
        throw new TypeError("PID liveness probe did not return a boolean");
      }
      return alive;
    } catch (cause) {
      throw new GlobalOperationLockError(
        "LOCK_IO",
        `Could not determine whether lock owner PID ${owner.pid} is alive: ${lockPath}`,
        lockPath,
        owner,
        { cause },
      );
    }
  }

  async #ensureParent(target: GlobalOperationLockTarget): Promise<void> {
    try {
      await ensurePhysicalDirectoryTree(this.stateRoot);
      await ensurePhysicalDirectory(this.locksRoot, this.stateRoot);
      if (target.kind === "scope") {
        await ensurePhysicalDirectory(containedChild(this.locksRoot, "scopes"), this.locksRoot);
      } else if (target.kind === "install") {
        await ensurePhysicalDirectory(containedChild(this.locksRoot, "installs"), this.locksRoot);
      }
    } catch (cause) {
      if (cause instanceof GlobalOperationLockError) throw cause;
      throw new GlobalOperationLockValidationError(this.pathFor(target), errorMessage(cause), {
        cause,
      });
    }
  }

  async #tryCreate(lockPath: string, owner: GlobalOperationLockOwner): Promise<boolean> {
    let created = false;
    try {
      await Deno.mkdir(lockPath, { mode: 0o700 });
      created = true;
    } catch (cause) {
      if (!(cause instanceof Deno.errors.AlreadyExists)) {
        throw new GlobalOperationLockError(
          "LOCK_IO",
          `Could not create operation lock: ${lockPath}`,
          lockPath,
          null,
          { cause },
        );
      }
    }
    if (!created) {
      const info = await lstatIfPresent(lockPath);
      if (info === null) return false;
      if (!await assertPhysicalDirectoryIfPresent(lockPath, info, "lock path")) return false;
      return false;
    }

    const ownerPath = containedChild(lockPath, GLOBAL_OPERATION_LOCK_OWNER_FILE);
    try {
      await writeNewOwnerFile(ownerPath, owner);
      return true;
    } catch (cause) {
      await removeOwnedCreation(lockPath, ownerPath);
      if (cause instanceof GlobalOperationLockError) throw cause;
      throw new GlobalOperationLockError(
        "LOCK_IO",
        `Could not initialize operation lock owner: ${lockPath}`,
        lockPath,
        null,
        { cause },
      );
    }
  }

  async #inspectWithIncompleteRetry(
    target: GlobalOperationLockTarget,
  ): Promise<GlobalOperationLockOwner | null> {
    const lockPath = this.pathFor(target);
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await this.#inspectOnce(target);
      if (result !== INCOMPLETE_OWNER) return result;
      if (attempt < 4) await this.#sleep(1);
    }
    throw new GlobalOperationLockValidationError(lockPath, "owner.json is missing");
  }

  async #inspectOnce(
    target: GlobalOperationLockTarget,
  ): Promise<GlobalOperationLockOwner | null | typeof INCOMPLETE_OWNER> {
    const lockPath = this.pathFor(target);
    const stateInfo = await lstatIfPresent(this.stateRoot);
    if (stateInfo === null) return null;
    await assertPhysicalDirectory(this.stateRoot, stateInfo, "state root");

    const locksInfo = await lstatIfPresent(this.locksRoot);
    if (locksInfo === null) return null;
    await assertPhysicalDirectory(this.locksRoot, locksInfo, "locks root");
    assertContained(this.stateRoot, this.locksRoot, "locks root");

    const parent = dirname(lockPath);
    if (parent !== this.locksRoot) {
      const parentInfo = await lstatIfPresent(parent);
      if (parentInfo === null) return null;
      await assertPhysicalDirectory(parent, parentInfo, "lock category");
      assertContained(this.locksRoot, parent, "lock category");
    }

    const lockInfo = await lstatIfPresent(lockPath);
    if (lockInfo === null) return null;
    if (!await assertPhysicalDirectoryIfPresent(lockPath, lockInfo, "lock path")) return null;
    assertContained(this.locksRoot, lockPath, "lock path");

    const ownerPath = containedChild(lockPath, GLOBAL_OPERATION_LOCK_OWNER_FILE);
    const ownerInfo = await lstatIfPresent(ownerPath);
    if (ownerInfo === null) return INCOMPLETE_OWNER;
    if (!ownerInfo.isFile || ownerInfo.isSymlink) {
      throw new GlobalOperationLockValidationError(ownerPath, "owner is not a physical file");
    }
    if (ownerInfo.size > GLOBAL_OPERATION_LOCK_MAX_OWNER_BYTES) {
      throw new GlobalOperationLockValidationError(ownerPath, "owner file is too large");
    }

    let value: unknown;
    try {
      value = JSON.parse(await Deno.readTextFile(ownerPath));
    } catch (cause) {
      if (cause instanceof Deno.errors.NotFound) return INCOMPLETE_OWNER;
      throw new GlobalOperationLockValidationError(ownerPath, "owner is not valid readable JSON", {
        cause,
      });
    }
    try {
      return validateGlobalOperationLockOwner(value);
    } catch (cause) {
      throw new GlobalOperationLockValidationError(ownerPath, errorMessage(cause), { cause });
    }
  }

  async #releaseOwned(target: GlobalOperationLockTarget, operationId: string): Promise<void> {
    const owner = await this.#inspectWithIncompleteRetry(target);
    const lockPath = this.pathFor(target);
    if (owner === null || owner.operationId !== operationId) {
      throw new GlobalOperationLockOwnershipLostError(lockPath, operationId, owner);
    }
    await this.#removeOwned(target, operationId);
  }

  async #removeOwned(target: GlobalOperationLockTarget, operationId: string): Promise<void> {
    const lockPath = this.pathFor(target);
    const current = await this.#inspectWithIncompleteRetry(target);
    if (current === null || current.operationId !== operationId) {
      throw new GlobalOperationLockOwnershipLostError(lockPath, operationId, current);
    }

    const releaseId = validateUuid(this.#randomUUID(), "release UUID");
    const tombstone = containedChild(
      dirname(lockPath),
      `.${basename(lockPath)}.release-${releaseId}`,
    );
    try {
      await Deno.rename(lockPath, tombstone);
    } catch (cause) {
      const owner = await this.#inspectWithIncompleteRetry(target);
      if (owner === null || owner.operationId !== operationId) {
        throw new GlobalOperationLockOwnershipLostError(lockPath, operationId, owner);
      }
      throw new GlobalOperationLockError(
        "LOCK_IO",
        `Could not release operation lock: ${lockPath}`,
        lockPath,
        owner,
        { cause },
      );
    }
    try {
      await Deno.remove(tombstone, { recursive: true });
    } catch (cause) {
      throw new GlobalOperationLockError(
        "LOCK_IO",
        `Operation lock was released but its private cleanup path remains: ${tombstone}`,
        lockPath,
        current,
        { cause },
      );
    }
  }

  async #sleepAbortably(
    milliseconds: number,
    signal: AbortSignal | undefined,
    lockPath: string,
  ): Promise<void> {
    throwIfAborted(signal, lockPath);
    if (signal === undefined) {
      await this.#sleep(milliseconds);
      return;
    }
    let abort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new GlobalOperationLockAbortedError(lockPath, { cause: signal.reason }));
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      await Promise.race([this.#sleep(milliseconds), aborted]);
    } finally {
      if (abort !== undefined) signal.removeEventListener("abort", abort);
    }
    throwIfAborted(signal, lockPath);
  }
}

export function validateGlobalOperationLockOwner(value: unknown): GlobalOperationLockOwner {
  const root = strictObject(value, "owner");
  rejectUnknown(root, OWNER_KEYS, "owner");
  for (
    const required of [
      "schemaVersion",
      "operationId",
      "pid",
      "operation",
      "startedAt",
    ]
  ) {
    if (!hasOwn(root, required)) throw new TypeError(`owner.${required} is required`);
  }
  if (root.schemaVersion !== GLOBAL_OPERATION_LOCK_OWNER_SCHEMA_VERSION) {
    throw new TypeError(
      `owner.schemaVersion must be ${GLOBAL_OPERATION_LOCK_OWNER_SCHEMA_VERSION}`,
    );
  }
  const owner: GlobalOperationLockOwner = {
    schemaVersion: GLOBAL_OPERATION_LOCK_OWNER_SCHEMA_VERSION,
    operationId: validateUuid(root.operationId, "owner.operationId"),
    pid: positiveSafeInteger(root.pid, "owner.pid"),
    operation: ownerText(root.operation, "owner.operation"),
    ...(hasOwn(root, "scope") ? { scope: ownerText(root.scope, "owner.scope") } : {}),
    ...(hasOwn(root, "selector") ? { selector: ownerText(root.selector, "owner.selector") } : {}),
    startedAt: validateTimestamp(root.startedAt, "owner.startedAt"),
  };
  if (
    new TextEncoder().encode(JSON.stringify(owner)).byteLength >
      GLOBAL_OPERATION_LOCK_MAX_OWNER_BYTES
  ) {
    throw new TypeError(`owner exceeds ${GLOBAL_OPERATION_LOCK_MAX_OWNER_BYTES} bytes`);
  }
  return owner;
}

export function serializeGlobalOperationLockOwner(owner: GlobalOperationLockOwner): string {
  return `${JSON.stringify(validateGlobalOperationLockOwner(owner), null, 2)}\n`;
}

/** Stable key for an already-physical absolute scope path. */
export async function computeScopeOperationLockKey(physicalScopePath: string): Promise<string> {
  const path = normalizeAbsolutePath(physicalScopePath, "physical scope path");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateTarget(value: GlobalOperationLockTarget): GlobalOperationLockTarget {
  const root = strictObject(value, "lock target");
  if (root.kind === "source" || root.kind === "catalog" || root.kind === "global") {
    rejectUnknown(root, new Set(["kind"]), "lock target");
    return { kind: root.kind };
  }
  if (root.kind === "scope") {
    rejectUnknown(root, new Set(["kind", "scopeKey"]), "lock target");
    return { kind: "scope", scopeKey: safeKey(root.scopeKey, "lock target scopeKey") };
  }
  if (root.kind === "install") {
    rejectUnknown(root, new Set(["kind", "installationId"]), "lock target");
    return {
      kind: "install",
      installationId: safeKey(root.installationId, "lock target installationId"),
    };
  }
  throw new TypeError("lock target kind must be source, catalog, global, scope, or install");
}

function validateAcquireOptions(
  _target: GlobalOperationLockTarget,
  value: GlobalOperationLockAcquireOptions,
):
  & Required<Pick<GlobalOperationLockAcquireOptions, "operation">>
  & Omit<GlobalOperationLockAcquireOptions, "operation" | "wait">
  & {
    readonly wait?: {
      readonly timeoutMs: number | null;
      readonly pollIntervalMs: number;
    };
  } {
  const root = strictObject(value, "lock acquire options");
  rejectUnknown(
    root,
    new Set(["operation", "operationId", "scope", "selector", "signal", "wait"]),
    "lock acquire options",
  );
  const operation = ownerText(root.operation, "lock acquire options.operation");
  const operationId = hasOwn(root, "operationId")
    ? validateUuid(root.operationId, "lock acquire options.operationId")
    : undefined;
  const scope = hasOwn(root, "scope")
    ? ownerText(root.scope, "lock acquire options.scope")
    : undefined;
  const selector = hasOwn(root, "selector")
    ? ownerText(root.selector, "lock acquire options.selector")
    : undefined;
  const signal = hasOwn(root, "signal") ? abortSignal(root.signal) : undefined;

  let wait: { readonly timeoutMs: number | null; readonly pollIntervalMs: number } | undefined;
  if (hasOwn(root, "wait")) {
    const waitRoot = strictObject(root.wait, "lock acquire options.wait");
    rejectUnknown(waitRoot, new Set(["timeoutMs", "pollIntervalMs"]), "lock acquire options.wait");
    const timeoutMs = hasOwn(waitRoot, "timeoutMs")
      ? nonnegativeFiniteNumber(
        waitRoot.timeoutMs,
        "lock acquire options.wait.timeoutMs",
      )
      : null;
    const pollIntervalMs = hasOwn(waitRoot, "pollIntervalMs")
      ? positiveFiniteNumber(
        waitRoot.pollIntervalMs,
        "lock acquire options.wait.pollIntervalMs",
      )
      : 100;
    wait = { timeoutMs, pollIntervalMs };
  }
  return {
    operation,
    ...(operationId === undefined ? {} : { operationId }),
    ...(scope === undefined ? {} : { scope }),
    ...(selector === undefined ? {} : { selector }),
    ...(signal === undefined ? {} : { signal }),
    ...(wait === undefined ? {} : { wait }),
  };
}

async function writeNewOwnerFile(path: string, owner: GlobalOperationLockOwner): Promise<void> {
  const bytes = new TextEncoder().encode(serializeGlobalOperationLockOwner(owner));
  const file = await Deno.open(path, { createNew: true, write: true, mode: 0o600 });
  try {
    let offset = 0;
    while (offset < bytes.length) offset += await file.write(bytes.subarray(offset));
    await file.sync();
  } finally {
    file.close();
  }
}

async function removeOwnedCreation(lockPath: string, ownerPath: string): Promise<void> {
  try {
    await Deno.remove(ownerPath);
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound)) {
      // The just-created lock directory is still removed below.
    }
  }
  try {
    await Deno.remove(lockPath);
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound)) {
      // Preserve the owner initialization failure.
    }
  }
}

async function ensurePhysicalDirectoryTree(path: string): Promise<void> {
  const target = normalizeAbsolutePath(path, "directory path");
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

async function ensurePhysicalDirectory(path: string, root: string): Promise<void> {
  assertContained(root, path, "directory");
  try {
    await Deno.mkdir(path, { mode: 0o700 });
  } catch (cause) {
    if (!(cause instanceof Deno.errors.AlreadyExists)) throw cause;
  }
  await assertPhysicalDirectory(path, await Deno.lstat(path), "directory");
}

async function assertPhysicalDirectory(
  path: string,
  info: Deno.FileInfo,
  label: string,
): Promise<void> {
  if (!info.isDirectory || info.isSymlink) {
    throw new GlobalOperationLockValidationError(path, `${label} is not a physical directory`);
  }
  let physical: string;
  try {
    physical = resolve(await Deno.realPath(path));
  } catch (cause) {
    throw new GlobalOperationLockValidationError(path, `${label} cannot be resolved`, { cause });
  }
  if (physical !== resolve(path)) {
    throw new GlobalOperationLockValidationError(path, `${label} traverses a symbolic link`);
  }
}

async function assertPhysicalDirectoryIfPresent(
  path: string,
  info: Deno.FileInfo,
  label: string,
): Promise<boolean> {
  try {
    await assertPhysicalDirectory(path, info, label);
    return true;
  } catch (cause) {
    if (
      cause instanceof GlobalOperationLockValidationError &&
      cause.cause instanceof Deno.errors.NotFound
    ) return false;
    throw cause;
  }
}

function containedChild(root: string, ...segments: string[]): string {
  for (const segment of segments) {
    if (
      typeof segment !== "string" || segment.length === 0 || segment === "." || segment === ".." ||
      segment.includes("/") || segment.includes("\\")
    ) {
      throw new TypeError(`unsafe operation-lock path segment: ${segment}`);
    }
    rejectControls(segment, "operation-lock path segment");
  }
  const candidate = resolve(root, ...segments);
  assertContained(root, candidate, "operation-lock path");
  if (candidate === resolve(root)) {
    throw new TypeError("operation-lock child must be below its root");
  }
  return candidate;
}

function assertContained(root: string, candidate: string, label: string): void {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  const rel = relative(normalizedRoot, normalizedCandidate);
  if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) {
    throw new GlobalOperationLockValidationError(candidate, `${label} escapes ${normalizedRoot}`);
  }
}

function normalizeRoot(path: string, label: string): string {
  const normalized = normalizeAbsolutePath(path, label);
  if (dirname(normalized) === normalized) {
    throw new TypeError(`${label} must not be a filesystem root`);
  }
  return normalized;
}

function normalizeAbsolutePath(path: string, label: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError(`${label} must be a nonempty path`);
  }
  rejectControls(path, label);
  if (!isAbsolute(path)) throw new TypeError(`${label} must be absolute: ${path}`);
  return resolve(path);
}

function safeKey(value: unknown, path: string): string {
  if (typeof value !== "string" || !SAFE_KEY.test(value)) {
    throw new TypeError(`${path} must be exactly 64 lowercase hexadecimal characters`);
  }
  return value;
}

function validateUuid(value: unknown, path: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new TypeError(`${path} must be a canonical lowercase UUID`);
  }
  return value;
}

function ownerText(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${path} must be nonempty without surrounding whitespace`);
  }
  rejectControls(value, path);
  return value;
}

function rejectControls(value: string, path: string): void {
  if (/\p{Cc}/u.test(value)) throw new TypeError(`${path} contains a control character`);
}

function positiveSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${path} must be a positive safe integer`);
  }
  return value as number;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${path} must return a finite number`);
  }
  return value;
}

function nonnegativeFiniteNumber(value: unknown, path: string): number {
  const result = finiteNumber(value, path);
  if (result < 0) throw new TypeError(`${path} must be nonnegative`);
  return result;
}

function positiveFiniteNumber(value: unknown, path: string): number {
  const result = finiteNumber(value, path);
  if (result <= 0) throw new TypeError(`${path} must be positive`);
  return result;
}

function timestamp(value: Date, path: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError(`${path} must return a valid Date`);
  }
  return value.toISOString();
}

function validateTimestamp(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    throw new TypeError(`${path} must be a canonical UTC timestamp`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw new TypeError(`${path} must be a valid canonical UTC timestamp`);
  }
  return value;
}

function abortSignal(value: unknown): AbortSignal {
  if (!(value instanceof AbortSignal)) {
    throw new TypeError("lock acquire options.signal is invalid");
  }
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined, lockPath: string): void {
  if (signal?.aborted) {
    throw new GlobalOperationLockAbortedError(lockPath, { cause: signal.reason });
  }
}

function strictObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) throw new TypeError(`${path} contains unknown key '${unknown[0]}'`);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

async function lstatIfPresent(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.lstat(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return null;
    throw cause;
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function defaultPidLivenessProbe(pid: number): boolean {
  if (pid === Deno.pid) return true;
  try {
    const kill = Deno.kill as unknown as (processId: number, signal: number) => void;
    kill(pid, 0);
    return true;
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return false;
    if (cause instanceof Deno.errors.PermissionDenied) return true;
    throw cause;
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const INCOMPLETE_OWNER = Symbol("incomplete operation lock owner");
