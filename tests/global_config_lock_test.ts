import {
  assert,
  assertEquals,
  assertFalse,
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  CANONICAL_ZIG_REPOSITORY_URL,
  DEFAULT_GLOBAL_CONFIG,
  GLOBAL_CONFIG_MAX_BYTES,
  GlobalConfigStore,
  GlobalConfigValidationError,
  resolveGlobalConfig,
} from "../src/global_config.ts";
import {
  computeScopeOperationLockKey,
  GLOBAL_OPERATION_LOCK_OWNER_FILE,
  GlobalOperationLock,
  GlobalOperationLockAbortedError,
  GlobalOperationLockBusyError,
  GlobalOperationLockManager,
  GlobalOperationLockOwnerAliveError,
  GlobalOperationLockOwnershipLostError,
  GlobalOperationLockTimeoutError,
  GlobalOperationLockValidationError,
  validateGlobalOperationLockOwner,
} from "../src/global_operation_lock.ts";

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const INSTALL_A = "a".repeat(64);
const SCOPE_A = "b".repeat(64);
const STARTED_AT = "2026-08-10T12:00:00.000Z";

Deno.test("optional global config uses complete immutable defaults and only injected inputs", async () => {
  await withTempRoot(async (root) => {
    const configPath = join(root, "not-created", "config.json");
    const store = new GlobalConfigStore({ configPath, env: {} });
    assertEquals(await store.load(), DEFAULT_GLOBAL_CONFIG);
    assertEquals((await store.load()).zigRepository, CANONICAL_ZIG_REPOSITORY_URL);
    assertFalse(await exists(join(root, "not-created")));

    const injected = new GlobalConfigStore(configPath, {
      ZIG_MANAGER_CC: "/injected/cc",
      CC: "/ambient/cc",
    });
    assertEquals((await injected.load()).tools.cCompiler, "/injected/cc");
    assertFalse(await exists(configPath));
  });
});

Deno.test("partial global config merges defaults and injected environment overrides", async () => {
  await withTempRoot(async (root) => {
    const configPath = join(root, "config", "config.json");
    await Deno.mkdir(join(root, "config"));
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({
        $schema: "https://jsr.io/@reckagentek/zig-manager/zig-manager-global.schema.json",
        zigRepository: "https://example.test/from-file.git",
        build: {
          profile: "debug",
          jobs: 2,
          cpu: "native",
          cmakePrefixPath: "/from/file",
        },
        tools: {
          cmake: "/from/file/cmake",
          cCompiler: null,
          clang: "/from/file/clang",
        },
        warnings: {
          cacheBytes: 1024,
          movingSelectorMaxAgeHours: 12.5,
        },
      }),
    );

    const config = await new GlobalConfigStore({
      path: configPath,
      env: {
        ZIG_MANAGER_ZIG_REPOSITORY: "https://mirror.example.test/zig.git",
        ZIG_MANAGER_BUILD_PROFILE: "relwithdebinfo",
        ZIG_MANAGER_BUILD_GENERATOR: "Unix Makefiles",
        ZIG_MANAGER_BUILD_JOBS: "17",
        ZIG_MANAGER_BUILD_CPU: "baseline",
        ZIG_MANAGER_CMAKE_PREFIX_PATH: "/from/env",
        ZIG_MANAGER_CMAKE: "/from/env/cmake",
        ZIG_MANAGER_CC: "/from/env/cc",
        CC: "/ignored/cc",
        CXX: "/fallback/cxx",
        ZIG_MANAGER_LLVM_CONFIG: "/from/env/llvm-config",
        ZIG_MANAGER_WARNING_CACHE_BYTES: "2048",
        ZIG_MANAGER_MOVING_SELECTOR_MAX_AGE_HOURS: "6.25",
      },
    }).load();

    assertEquals(config, {
      zigRepository: "https://mirror.example.test/zig.git",
      build: {
        profile: "relwithdebinfo",
        generator: "Unix Makefiles",
        jobs: 17,
        cpu: "baseline",
        cmakePrefixPath: "/from/env",
      },
      tools: {
        cmake: "/from/env/cmake",
        cCompiler: "/from/env/cc",
        cxxCompiler: "/fallback/cxx",
        llvmConfig: "/from/env/llvm-config",
        clang: "/from/file/clang",
        lld: null,
        generatorTool: null,
      },
      warnings: {
        cacheBytes: 2048,
        movingSelectorMaxAgeHours: 6.25,
      },
    });
  });
});

Deno.test("global config strictly rejects unknown keys, controls, invalid values, and credentials", () => {
  const invalidValues: readonly unknown[] = [
    { currentZig: "latest" },
    { build: { typo: true } },
    { tools: { cc: "/usr/bin/cc" } },
    { warnings: { unknown: 1 } },
    { build: { generator: "Ninja\nmalicious" } },
    { tools: { cmake: "/usr/bin/cm\u007fake" } },
    { zigRepository: "not a URL" },
    { zigRepository: "http://codeberg.org/ziglang/zig.git" },
    { zigRepository: "https://user@codeberg.org/ziglang/zig.git" },
    { zigRepository: "https://user:secret@codeberg.org/ziglang/zig.git" },
    { zigRepository: "https://codeberg.org/ziglang/zig.git?token=secret" },
    { zigRepository: "https://codeberg.org/ziglang/zig.git#branch" },
    { build: { jobs: 0 } },
    { build: { jobs: 1.5 } },
    { build: { cpu: "host" } },
    { warnings: { cacheBytes: -1 } },
    { warnings: { movingSelectorMaxAgeHours: 0 } },
  ];
  for (const value of invalidValues) assertThrows(() => resolveGlobalConfig(value), TypeError);

  assertThrows(
    () => resolveGlobalConfig({}, { ZIG_MANAGER_CMAKE: "bad\npath" }),
    TypeError,
    "control",
  );
  assertThrows(
    () => resolveGlobalConfig({}, { ZIG_MANAGER_ZIG_REPOSITORY: "https://u:p@example.test/x" }),
    TypeError,
    "credentials",
  );
  assertThrows(
    () => resolveGlobalConfig({}, { ZIG_MANAGER_BUILD_JOBS: "01" }),
    TypeError,
    "positive integer",
  );
});

Deno.test("global config writes atomically and invalid writes preserve prior bytes", async () => {
  await withTempRoot(async (root) => {
    const configPath = join(root, "config root", "config.json");
    const store = new GlobalConfigStore({ configPath, env: {} });
    const resolved = await store.write({
      zigRepository: "https://example.test/zig.git",
      build: { jobs: 8 },
      tools: { cCompiler: "/opt/tool chain/cc", lld: null },
      warnings: { cacheBytes: 0 },
    });
    assertEquals(resolved.build.profile, "release");
    assertEquals(resolved.build.jobs, 8);
    assertEquals((await store.load()).tools.cCompiler, "/opt/tool chain/cc");

    const original = await Deno.readTextFile(configPath);
    const error = await assertRejects(
      () => store.write({ build: { jobs: 4, typo: true } }),
      GlobalConfigValidationError,
      "unknown key",
    );
    assertEquals(error.configPath, configPath);
    assertEquals(await Deno.readTextFile(configPath), original);
    await assertRejects(
      () => store.write({ build: { generator: "x".repeat(GLOBAL_CONFIG_MAX_BYTES) } }),
      GlobalConfigValidationError,
      "exceeds",
    );
    assertEquals(await Deno.readTextFile(configPath), original);
    assertEquals(
      (await collectNames(join(root, "config root"))).filter((name) => name.includes(".tmp-")),
      [],
    );
  });
});

Deno.test("global config refuses symlinks and oversized or malformed documents", async () => {
  await withTempRoot(async (root) => {
    const outside = join(root, "outside.json");
    const linked = join(root, "linked.json");
    await Deno.writeTextFile(outside, "{}\n");
    await Deno.symlink(outside, linked);
    await assertRejects(
      () => new GlobalConfigStore(linked).load(),
      GlobalConfigValidationError,
      "physical file",
    );
    await assertRejects(
      () => new GlobalConfigStore(linked).write({ build: { jobs: 2 } }),
      GlobalConfigValidationError,
      "physical file",
    );
    assertEquals(await Deno.readTextFile(outside), "{}\n");

    const realParent = join(root, "real-parent");
    const linkedParent = join(root, "linked-parent");
    await Deno.mkdir(realParent);
    await Deno.symlink(realParent, linkedParent);
    await Deno.writeTextFile(join(realParent, "config.json"), "{}\n");
    await assertRejects(
      () => new GlobalConfigStore(join(linkedParent, "config.json")).load(),
      GlobalConfigValidationError,
      "physical directory",
    );

    const oversized = join(root, "oversized.json");
    await Deno.writeTextFile(oversized, `{"padding":"${"x".repeat(GLOBAL_CONFIG_MAX_BYTES)}"}`);
    await assertRejects(
      () => new GlobalConfigStore(oversized).load(),
      GlobalConfigValidationError,
      "exceeds",
    );

    const malformed = join(root, "malformed.json");
    await Deno.writeTextFile(malformed, "{not-json\n");
    await assertRejects(
      () => new GlobalConfigStore(malformed).load(),
      GlobalConfigValidationError,
      "valid readable JSON",
    );
  });
});

Deno.test("global config JSON schema is strict, partial, and carries canonical defaults", async () => {
  const schemaPath = new URL("../schema/zig-manager-global.schema.json", import.meta.url);
  const schema = JSON.parse(await Deno.readTextFile(schemaPath));
  assertEquals(schema.additionalProperties, false);
  assertEquals(schema.required, undefined);
  assertEquals(schema.properties.zigRepository.default, CANONICAL_ZIG_REPOSITORY_URL);
  assertEquals(schema.properties.build.additionalProperties, false);
  assertEquals(schema.properties.build.properties.profile.default, "release");
  assertEquals(schema.properties.build.properties.generator.default, "Ninja");
  assertEquals(schema.properties.build.properties.jobs.default, null);
  assertEquals(schema.properties.build.properties.cpu.default, "baseline");
  assertEquals(schema.properties.warnings.properties.movingSelectorMaxAgeHours.default, 24);
  assertEquals(schema.properties.current, undefined);
});

Deno.test("operation lock owner JSON is strict and acquisition is create-new/fail-fast", async () => {
  await withTempRoot(async (root) => {
    const stateRoot = join(root, "state");
    const manager = lockManager(stateRoot, { isPidAlive: () => false });
    const first = await manager.acquireSource({
      operation: "install latest",
      operationId: UUID_A,
      scope: "/physical/project path",
      selector: "latest",
    });
    assertEquals(first.path, join(stateRoot, "locks", "source.lock"));
    assertFalse(first.contended);
    assertEquals(first.owner, {
      schemaVersion: 1,
      operationId: UUID_A,
      pid: 4242,
      operation: "install latest",
      scope: "/physical/project path",
      selector: "latest",
      startedAt: STARTED_AT,
    });
    assertEquals(await manager.inspect({ kind: "source" }), first.owner);
    assertEquals(
      JSON.parse(await Deno.readTextFile(join(first.path, GLOBAL_OPERATION_LOCK_OWNER_FILE))),
      first.owner,
    );

    const busy = await assertRejects(
      () =>
        manager.acquireSource({
          operation: "update",
          operationId: UUID_B,
        }),
      GlobalOperationLockBusyError,
    );
    assertEquals(busy.owner, first.owner);
    assert(await exists(first.path));

    await first.release();
    assert(first.released);
    await first.release();
    assertEquals(await manager.inspect({ kind: "source" }), null);
  });
});

Deno.test("concurrent directory-lock acquisition has exactly one owner", async () => {
  await withTempRoot(async (root) => {
    const manager = lockManager(join(root, "state"), { isPidAlive: () => false });
    const attempts = await Promise.allSettled([
      manager.acquireCatalog({ operation: "catalog-a", operationId: UUID_A }),
      manager.acquireCatalog({ operation: "catalog-b", operationId: UUID_B }),
    ]);
    const acquired = attempts.filter((result) => result.status === "fulfilled");
    const rejected = attempts.filter((result) => result.status === "rejected");
    assertEquals(acquired.length, 1);
    assertEquals(rejected.length, 1);
    if (rejected[0].status === "rejected") {
      assertInstanceOf(rejected[0].reason, GlobalOperationLockBusyError);
    }
    if (acquired[0].status === "fulfilled") await acquired[0].value.release();
  });
});

Deno.test("same-install contention waits within a bound and then acquires for caller recheck", async () => {
  await withTempRoot(async (root) => {
    const manager = lockManager(join(root, "state"), { isPidAlive: () => false });
    const first = await manager.acquireInstall(INSTALL_A, {
      operation: "build first",
      operationId: UUID_A,
      selector: "latest",
    });
    const waiting = manager.acquireInstall(INSTALL_A, {
      operation: "coalesced build",
      operationId: UUID_B,
      selector: "latest",
      wait: { timeoutMs: 1000, pollIntervalMs: 5 },
    });
    await delay(20);
    assertEquals(
      (await manager.inspect({ kind: "install", installationId: INSTALL_A }))?.operationId,
      UUID_A,
    );
    await first.release();

    const second = await waiting;
    assert(second.contended);
    assert(second.waitedMs > 0);
    assertEquals(second.owner.operationId, UUID_B);
    assertEquals(
      (await manager.inspect({ kind: "install", installationId: INSTALL_A }))?.operationId,
      UUID_B,
    );
    await second.release();
  });
});

Deno.test("waiting acquisition retries when a released lock disappears during inspection", async () => {
  await withTempRoot(async (root) => {
    const stateRoot = join(root, "state");
    const manager = lockManager(stateRoot, { isPidAlive: () => false });
    const first = await manager.acquireSource({
      operation: "source owner",
      operationId: UUID_A,
    });
    const tombstone = join(stateRoot, "locks", ".source.lock.release-race");
    const originalRealPath = Deno.realPath;
    let lockRealPaths = 0;
    let second: GlobalOperationLock | null = null;
    Object.defineProperty(Deno, "realPath", {
      configurable: true,
      writable: true,
      value: async (path: string | URL) => {
        if (path === first.path && ++lockRealPaths === 2) {
          await Deno.rename(first.path, tombstone);
        }
        return await originalRealPath(path);
      },
    });
    try {
      second = await manager.acquireSource({
        operation: "source waiter",
        operationId: UUID_B,
        wait: { timeoutMs: 1000, pollIntervalMs: 1 },
      });
      assert(second.contended);
      assertEquals(second.owner.operationId, UUID_B);
      assertEquals(lockRealPaths, 2);
    } finally {
      Object.defineProperty(Deno, "realPath", {
        configurable: true,
        writable: true,
        value: originalRealPath,
      });
      if (second !== null) await second.release();
    }
  });
});

Deno.test("install wait timeout and abort retain the existing owner without stale removal", async () => {
  await withTempRoot(async (root) => {
    let livenessCalls = 0;
    const manager = lockManager(join(root, "state"), {
      isPidAlive: () => {
        livenessCalls++;
        return false;
      },
    });
    const first = await manager.acquireInstall(INSTALL_A, {
      operation: "long build",
      operationId: UUID_A,
    });
    const timeout = await assertRejects(
      () =>
        manager.acquireInstall(INSTALL_A, {
          operation: "bounded waiter",
          operationId: UUID_B,
          wait: { timeoutMs: 20, pollIntervalMs: 3 },
        }),
      GlobalOperationLockTimeoutError,
    );
    assertEquals(timeout.owner?.operationId, UUID_A);
    assertEquals(livenessCalls, 0);
    assertEquals(
      (await manager.inspect({ kind: "install", installationId: INSTALL_A }))?.operationId,
      UUID_A,
    );

    const controller = new AbortController();
    const aborted = manager.acquireInstall(INSTALL_A, {
      operation: "abortable waiter",
      operationId: UUID_C,
      signal: controller.signal,
      wait: { timeoutMs: 1000, pollIntervalMs: 50 },
    });
    setTimeout(() => controller.abort("test cancellation"), 10);
    await assertRejects(() => aborted, GlobalOperationLockAbortedError);
    assertEquals(
      (await manager.inspect({ kind: "install", installationId: INSTALL_A }))?.operationId,
      UUID_A,
    );
    assertEquals(livenessCalls, 0);
    await first.release();
  });
});

Deno.test("scope, source, install, and catalog locks support explicit unbounded waiting", async () => {
  await withTempRoot(async (root) => {
    const manager = lockManager(join(root, "state"), { isPidAlive: () => false });
    const targets = [
      { kind: "scope", scopeKey: SCOPE_A },
      { kind: "source" },
      { kind: "install", installationId: INSTALL_A },
      { kind: "catalog" },
    ] as const;
    for (const target of targets) {
      const first = await manager.acquire(target, {
        operation: `first ${target.kind}`,
        operationId: UUID_A,
      });
      const waiting = manager.acquire(target, {
        operation: `waiting ${target.kind}`,
        operationId: UUID_B,
        wait: { pollIntervalMs: 2 },
      });
      await delay(8);
      assertEquals((await manager.inspect(target))?.operationId, UUID_A);
      await first.release();
      const second = await waiting;
      assert(second.contended);
      assertEquals(second.owner.operationId, UUID_B);
      await second.release();
    }

    await assertRejects(
      () =>
        manager.acquireInstall(INSTALL_A, {
          operation: "bad bound",
          operationId: UUID_A,
          wait: { timeoutMs: Number.POSITIVE_INFINITY },
        }),
      TypeError,
      "finite",
    );
  });
});

Deno.test("explicit waiting aborts for non-install locks without probing stale owners", async () => {
  await withTempRoot(async (root) => {
    let livenessCalls = 0;
    const manager = lockManager(join(root, "state"), {
      isPidAlive: () => {
        livenessCalls++;
        return false;
      },
    });
    const owner = await manager.acquireCatalog({
      operation: "catalog owner",
      operationId: UUID_A,
    });
    const controller = new AbortController();
    const waiting = manager.acquireCatalog({
      operation: "catalog waiter",
      operationId: UUID_B,
      signal: controller.signal,
      wait: {},
    });
    setTimeout(() => controller.abort("stop waiting"), 10);
    await assertRejects(() => waiting, GlobalOperationLockAbortedError);
    assertEquals((await manager.inspect({ kind: "catalog" }))?.operationId, UUID_A);
    assertEquals(livenessCalls, 0);
    await owner.release();
  });
});

Deno.test("lock owner enumeration reports retained owners and uncertain metadata", async () => {
  await withTempRoot(async (root) => {
    const stateRoot = join(root, "state");
    const manager = lockManager(stateRoot, { isPidAlive: () => false });
    const source = await manager.acquireSource({
      operation: "source owner",
      operationId: UUID_A,
    });
    const scope = await manager.acquireScope(SCOPE_A, {
      operation: "scope owner",
      operationId: UUID_B,
    });
    const first = await manager.enumerateOwners();
    assertEquals(first.owners.map((entry) => entry.owner.operationId).sort(), [UUID_A, UUID_B]);
    assertEquals(first.uncertain, []);

    const unknown = join(stateRoot, "locks", "foreign.lock");
    await Deno.mkdir(unknown);
    const uncertain = await manager.enumerateOwners();
    assertEquals(uncertain.owners.length, 2);
    assertEquals(uncertain.uncertain, [unknown]);
    await scope.release();
    await source.release();
  });
});

Deno.test("explicit unlock refuses live owners and removes only owners proven dead", async () => {
  await withTempRoot(async (root) => {
    const stateRoot = join(root, "state");
    const ownerManager = lockManager(stateRoot, { isPidAlive: () => false });
    const lease = await ownerManager.acquireScope(SCOPE_A, {
      operation: "use latest",
      operationId: UUID_A,
      scope: "/project",
    });

    const aliveManager = lockManager(stateRoot, { isPidAlive: (pid) => pid === 4242 });
    const alive = await assertRejects(
      () => aliveManager.unlock({ kind: "scope", scopeKey: SCOPE_A }),
      GlobalOperationLockOwnerAliveError,
    );
    assertEquals(alive.owner?.operationId, UUID_A);
    assert(await exists(lease.path));

    let inspectedPid = 0;
    const deadManager = lockManager(stateRoot, {
      isPidAlive: (pid) => {
        inspectedPid = pid;
        return false;
      },
    });
    assert(await deadManager.unlock({ kind: "scope", scopeKey: SCOPE_A }));
    assertEquals(inspectedPid, 4242);
    assertFalse(await exists(lease.path));
    assertFalse(await deadManager.unlock({ kind: "scope", scopeKey: SCOPE_A }));
    await assertRejects(() => lease.release(), GlobalOperationLockOwnershipLostError);
  });
});

Deno.test("malformed lock owners are inspectable errors and are never removed automatically", async () => {
  await withTempRoot(async (root) => {
    const stateRoot = join(root, "state");
    const manager = lockManager(stateRoot, { isPidAlive: () => false });
    const lease = await manager.acquireSource({
      operation: "source build",
      operationId: UUID_A,
    });
    const ownerPath = join(lease.path, GLOBAL_OPERATION_LOCK_OWNER_FILE);
    const malformed = { ...lease.owner, unexpected: true };
    await Deno.writeTextFile(ownerPath, JSON.stringify(malformed));
    await assertRejects(
      () => manager.inspect({ kind: "source" }),
      GlobalOperationLockValidationError,
      "unknown key",
    );
    await assertRejects(
      () => manager.unlock({ kind: "source" }),
      GlobalOperationLockValidationError,
    );
    await assertRejects(
      () => manager.acquireSource({ operation: "other", operationId: UUID_B }),
      GlobalOperationLockValidationError,
    );
    assert(await exists(lease.path));
    assertEquals(JSON.parse(await Deno.readTextFile(ownerPath)), malformed);
  });
});

Deno.test("owner validation rejects unknown fields, controls, malformed UUIDs, and timestamps", () => {
  const owner = {
    schemaVersion: 1,
    operationId: UUID_A,
    pid: 42,
    operation: "install",
    startedAt: STARTED_AT,
  };
  assertEquals(validateGlobalOperationLockOwner(owner), owner);
  for (
    const invalid of [
      { ...owner, extra: true },
      { ...owner, operationId: "not-a-uuid" },
      { ...owner, pid: 0 },
      { ...owner, operation: "bad\noperation" },
      { ...owner, scope: "/bad\u007fpath" },
      { ...owner, startedAt: "2026-08-10T12:00:00Z" },
      { ...owner, startedAt: "2026-02-30T12:00:00.000Z" },
      { ...owner, operation: "x".repeat(64 * 1024) },
    ]
  ) {
    assertThrows(() => validateGlobalOperationLockOwner(invalid), TypeError);
  }
});

Deno.test("operation lock paths enforce safe keys, containment, and physical directories", async () => {
  assertThrows(
    () => new GlobalOperationLockManager({ stateRoot: "relative/state" }),
    TypeError,
    "absolute",
  );
  assertThrows(
    () => new GlobalOperationLockManager({ stateRoot: "/bad\nstate" }),
    TypeError,
    "control",
  );
  assertThrows(
    () => new GlobalOperationLockManager({ stateRoot: "/" }),
    TypeError,
    "filesystem root",
  );

  await withTempRoot(async (root) => {
    const manager = lockManager(join(root, "state"), { isPidAlive: () => false });
    for (const key of ["../escape", "A".repeat(64), "a".repeat(63), `a${"0".repeat(63)}/x`]) {
      assertThrows(
        () => manager.pathFor({ kind: "install", installationId: key }),
        TypeError,
      );
    }
    const key = await computeScopeOperationLockKey(join(root, "scope", "..", "physical"));
    assertEquals(key.length, 64);
    assertEquals(key, await computeScopeOperationLockKey(join(root, "physical")));

    const stateRoot = join(root, "linked-state");
    const outside = join(root, "outside-locks");
    await Deno.mkdir(stateRoot);
    await Deno.mkdir(outside);
    await Deno.symlink(outside, join(stateRoot, "locks"));
    const linkedManager = lockManager(stateRoot, { isPidAlive: () => false });
    const linkedError = await assertRejects(
      () =>
        linkedManager.acquireSource({
          operation: "must not escape",
          operationId: UUID_A,
        }),
      GlobalOperationLockValidationError,
    );
    assertStringIncludes(linkedError.message, "physical directory");
    assertEquals(await collectNames(outside), []);
  });
});

interface LockManagerOverrides {
  readonly isPidAlive: (pid: number) => boolean | Promise<boolean>;
}

function lockManager(
  stateRoot: string,
  overrides: LockManagerOverrides,
): GlobalOperationLockManager {
  return new GlobalOperationLockManager({
    stateRoot,
    pid: 4242,
    now: () => new Date(STARTED_AT),
    isPidAlive: overrides.isPidAlive,
  });
}

async function withTempRoot(action: (root: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-global-config-lock-" });
  try {
    await action(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return false;
    throw cause;
  }
}

async function collectNames(path: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(path)) names.push(entry.name);
  return names.sort();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
