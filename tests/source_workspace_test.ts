import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  type CheckoutResult,
  type DescribeRevisionOptions,
  type DoctorResult as SourceRefDoctorResult,
  type EnsureRequest,
  type GitRef,
  type ListRemoteRefsRequest,
  LockedRequestMismatchError,
  type PathOptions,
  type RemoteHead,
  type RemoteRef,
  RepositoryNotFoundError,
  type RepositorySelector,
  type RepositoryStatus,
  type ResolveRemoteHeadRequest,
  type RevisionDescription,
  type StatusOptions,
  type UpdateOptions,
} from "@reckagentek/source-ref";
import {
  ZigReleaseUnsupportedError,
  ZigSourceNotReadyError,
  ZigVersionNotFoundError,
} from "../src/errors.ts";
import { DEFAULT_GLOBAL_CONFIG, type GlobalConfig } from "../src/global_config.ts";
import {
  GlobalOperationLockBusyError,
  GlobalOperationLockManager,
} from "../src/global_operation_lock.ts";
import type { ResolvedSource } from "../src/install_store.ts";
import {
  SourceWorkspace,
  type SourceWorkspaceSourceRef,
  ZIG_SOURCE_REPOSITORY_IDENTITY,
} from "../src/source_workspace.ts";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const COMMIT_C = "c".repeat(40);
const COMMIT_D = "d".repeat(40);
const NOW = "2026-08-10T12:34:56.789Z";
const REPOSITORY_URL = "https://codeberg.org/ziglang/zig.git";

Deno.test("latest means literal symbolic remote HEAD rather than a tag named HEAD", async () => {
  await withFixture(async ({ fake, workspace, progress, clockCalls }) => {
    fake.addVersion(COMMIT_A, "0.16.0");
    fake.addVersion(COMMIT_B, "0.17.0", "0.16.0", 27);
    fake.addVersion(COMMIT_C, "0.16.2");
    fake.setHead("trunk", COMMIT_B);
    fake.refs.push(
      { kind: "tag", name: "HEAD", commit: COMMIT_C },
      { kind: "tag", name: "0.16.2", commit: COMMIT_C },
    );

    const latest = await workspace.prepare("latest", (prepared) => prepared);
    assertEquals(latest.source.requestedSelector, "latest");
    assertEquals(latest.source.resolvedRef, { kind: "head", value: "trunk" });
    assertEquals(latest.source.commit, COMMIT_B);
    assertEquals(latest.source.resolvedAt, NOW);
    assertEquals(latest.checkout.requested, { kind: "branch", value: "trunk" });
    assertEquals(latest.version.text, `0.17.0-dev.27+${COMMIT_B.slice(0, 9)}`);
    assertEquals(fake.calls.filter((call) => call.method === "resolveRemoteHead").length, 1);
    assertEquals(fake.calls.filter((call) => call.method === "listRemoteRefs").length, 0);

    const literalTag = await workspace.prepare("tag:HEAD", (prepared) => prepared);
    assertEquals(literalTag.source.resolvedRef, { kind: "tag", value: "HEAD" });
    assertEquals(literalTag.source.commit, COMMIT_C);
    assertEquals(literalTag.checkout.requested, { kind: "tag", value: "HEAD" });
    assertEquals(fake.calls.filter((call) => call.method === "resolveRemoteHead").length, 1);
    assertEquals(clockCalls(), 2);
    assertEquals(progress, [
      "Resolving Zig source 'latest'...\n",
      `Preparing Zig source 'latest' at ${COMMIT_B}...\n`,
      "Resolving Zig source 'tag:HEAD'...\n",
      `Preparing Zig source 'tag:HEAD' at ${COMMIT_C}...\n`,
    ]);
  });
});

Deno.test("stable and minor selectors use strict numeric stable-tag ordering", async () => {
  await withFixture(async ({ fake, workspace }) => {
    fake.addVersion(COMMIT_A, "0.17.0");
    fake.addVersion(COMMIT_B, "0.16.10");
    fake.addVersion(COMMIT_C, "0.16.9");
    fake.refs.push(
      { kind: "tag", name: "0.16.9", commit: COMMIT_C },
      { kind: "tag", name: "0.16.10", commit: COMMIT_B },
      { kind: "tag", name: "0.17.0", commit: COMMIT_A },
      { kind: "tag", name: "0.99.0-dev.1", commit: COMMIT_D },
      { kind: "tag", name: "v1.0.0", commit: COMMIT_D },
      { kind: "branch", name: "9.9.9", commit: COMMIT_D },
    );

    const stable = await workspace.prepare("stable", (prepared) => prepared.source);
    assertEquals(stable.resolvedRef, { kind: "tag", value: "0.17.0" });
    assertEquals(stable.commit, COMMIT_A);

    const minor = await workspace.prepare("0.16", (prepared) => prepared.source);
    assertEquals(minor.resolvedRef, { kind: "tag", value: "0.16.10" });
    assertEquals(minor.commit, COMMIT_B);

    const exact = await workspace.prepare("0.16.9", (prepared) => prepared.source);
    assertEquals(exact.resolvedRef, { kind: "tag", value: "0.16.9" });
    assertEquals(exact.commit, COMMIT_C);
    assert(
      fake.calls.filter((call) => call.method === "listRemoteRefs").every((call) =>
        call.kind === "tag"
      ),
    );
  });
});

Deno.test("explicit tag and branch selectors preserve their ref kind", async () => {
  await withFixture(async ({ fake, workspace }) => {
    fake.addVersion(COMMIT_A, "0.16.0");
    fake.addVersion(COMMIT_B, "0.17.0", "0.16.0", 3);
    fake.refs.push(
      { kind: "tag", name: "nightly", commit: COMMIT_B },
      { kind: "branch", name: "release", commit: COMMIT_A },
    );

    const tag = await workspace.prepare("tag:nightly", (prepared) => prepared.source);
    assertEquals(tag.resolvedRef, { kind: "tag", value: "nightly" });
    assertEquals(tag.commit, COMMIT_B);

    const branch = await workspace.prepare("branch:release", (prepared) => prepared.source);
    assertEquals(branch.resolvedRef, { kind: "branch", value: "release" });
    assertEquals(branch.commit, COMMIT_A);
    assertEquals(
      fake.calls.filter((call) => call.method === "listRemoteRefs").map((call) => call.kind),
      ["tag", "branch"],
    );
  });
});

Deno.test("commit selector performs no remote HEAD or ref discovery", async () => {
  await withFixture(async ({ fake, workspace }) => {
    fake.addVersion(COMMIT_C, "0.16.3");
    fake.failRemoteDiscovery = true;

    const prepared = await workspace.prepare(
      `commit:${COMMIT_C.toUpperCase()}`,
      (value) => value,
    );
    assertEquals(prepared.source.requestedSelector, `commit:${COMMIT_C.toUpperCase()}`);
    assertEquals(prepared.source.resolvedRef, { kind: "commit", value: COMMIT_C });
    assertEquals(prepared.source.commit, COMMIT_C);
    assertEquals(prepared.checkout.requested, { kind: "commit", value: COMMIT_C });
    assertEquals(remoteDiscoveryCalls(fake), 0);
  });
});

Deno.test("moving latest and branch selectors advance with update rather than preserving ensure lock", async () => {
  await withFixture(async ({ fake, workspace }) => {
    fake.addVersion(COMMIT_A, "0.16.0");
    fake.addVersion(COMMIT_B, "0.16.1");
    fake.addVersion(COMMIT_C, "0.16.2");
    fake.setHead("main", COMMIT_A);
    fake.setBranch("release", COMMIT_A);

    assertEquals(
      (await workspace.prepare("latest", (prepared) => prepared.source)).commit,
      COMMIT_A,
    );
    assertEquals(fake.locked?.commit, COMMIT_A);
    fake.setHead("main", COMMIT_B);
    assertEquals(
      (await workspace.prepare("latest", (prepared) => prepared.source)).commit,
      COMMIT_B,
    );
    assertEquals(fake.locked?.commit, COMMIT_B);

    assertEquals(
      (await workspace.prepare("branch:release", (prepared) => prepared.source)).commit,
      COMMIT_A,
    );
    fake.setBranch("release", COMMIT_C);
    assertEquals(
      (await workspace.prepare("branch:release", (prepared) => prepared.source)).commit,
      COMMIT_C,
    );
    assertEquals(fake.locked?.commit, COMMIT_C);
    assertEquals(fake.calls.filter((call) => call.method === "ensure").length, 1);
    assert(fake.calls.filter((call) => call.method === "update").length >= 4);
  });
});

Deno.test("checkout commit is compared with the observed remote commit to reject races", async () => {
  await withFixture(async ({ fake, workspace }) => {
    fake.addVersion(COMMIT_A, "0.16.0");
    fake.addVersion(COMMIT_B, "0.16.1");
    fake.setHead("main", COMMIT_A);
    fake.beforeNextMutation = () => fake.setHead("main", COMMIT_B);
    let callbackRan = false;

    const error = await assertRejects(
      () =>
        workspace.prepare("latest", () => {
          callbackRan = true;
        }),
      ZigVersionNotFoundError,
      "remote changed",
    );
    assertEquals(error.code, "ZIG_VERSION_NOT_FOUND");
    assertFalse(callbackRan);
    assertEquals(fake.locked?.commit, COMMIT_B);

    const recovered = await workspace.prepare(`commit:${COMMIT_B}`, (prepared) => prepared.source);
    assertEquals(recovered.commit, COMMIT_B);
  });
});

Deno.test("dirty checkout and non-exact status fields are rejected before callback", async () => {
  await withFixture(async ({ fake, workspace, root }) => {
    fake.addVersion(COMMIT_A, "0.16.0");
    fake.setHead("main", COMMIT_A);
    fake.dirty = true;
    let callbacks = 0;

    const dirty = await assertRejects(
      () => workspace.prepare("latest", () => callbacks++),
      ZigSourceNotReadyError,
      "local changes",
    );
    assertEquals(dirty.details.changes, [" M CMakeLists.txt"]);
    fake.dirty = false;

    const invalidStatuses: readonly Partial<RepositoryStatus>[] = [
      { matchesLock: false },
      { lockedCommit: COMMIT_B },
      { currentCommit: COMMIT_B },
      { currentBranch: "main" },
      { changes: ["unexpected clean status entry"] },
      { repositoryHome: join(root, "outside-repository") },
      { checkoutPath: join(root, "outside-checkout") },
      { mode: "branch" },
    ];
    for (const patch of invalidStatuses) {
      fake.statusPatch = patch;
      await assertRejects(
        () => workspace.prepare("latest", () => callbacks++),
        ZigSourceNotReadyError,
        "exactly match",
      );
    }
    fake.statusPatch = {};
    fake.checkoutPatch = { checkoutPath: join(root, "unexpected-result-path") };
    await assertRejects(
      () => workspace.prepare("latest", () => callbacks++),
      ZigSourceNotReadyError,
      "unexpected checkout result",
    );
    assertEquals(callbacks, 0);
  });
});

Deno.test("existing source-root symlink is rejected before source-ref mutation", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-source-workspace-symlink-" });
  try {
    const cacheRoot = join(root, "cache");
    const sourceRoot = join(cacheRoot, "sources");
    const outside = join(root, "outside");
    await Deno.mkdir(cacheRoot);
    await Deno.mkdir(outside);
    await Deno.symlink(outside, sourceRoot);
    const fake = new FakeSourceRef(sourceRoot);
    fake.addVersion(COMMIT_A, "0.16.0");
    fake.setHead("main", COMMIT_A);
    const workspace = new SourceWorkspace({
      config: globalConfig(),
      cacheRoot,
      stateRoot: join(root, "state"),
      sourceRef: fake,
    });

    await assertRejects(
      () => workspace.prepare("latest", () => {}),
      ZigSourceNotReadyError,
      "not a physical directory",
    );
    assertEquals(fake.calls.filter((call) => call.method === "update").length, 0);
    assertEquals(fake.calls.filter((call) => call.method === "ensure").length, 0);
  } finally {
    await cleanup(root);
  }
});

Deno.test("locked source dependencies select LLVM 21 or 22 without version guessing", async () => {
  await withFixture(async ({ fake, workspace }) => {
    fake.addVersion(COMMIT_A, "0.17.0", "0.16.0", 20, 21);
    fake.addVersion(COMMIT_B, "0.17.0", "0.16.0", 21, 22);
    fake.addVersion(COMMIT_C, "0.17.0", "0.16.0", 22, 23);

    fake.setHead("main", COMMIT_A);
    assertEquals(
      await workspace.prepare("latest", (prepared) => prepared.adapter.id),
      "zig-cmake-llvm21-autodoc-v1",
    );

    fake.setHead("main", COMMIT_B);
    assertEquals(
      await workspace.prepare("latest", (prepared) => prepared.adapter.id),
      "zig-cmake-llvm22-autodoc-v1",
    );

    fake.setHead("main", COMMIT_C);
    const unsupported = await assertRejects(
      () => workspace.prepare("latest", () => {}),
      ZigReleaseUnsupportedError,
    );
    assertEquals(
      (unsupported.details.sourceContract as { llvmMajor: number }).llvmMajor,
      23,
    );
    assertEquals(unsupported.details.commit, COMMIT_C);
  });
});

Deno.test("unsupported derived source version fails explicitly and releases source lock", async () => {
  await withFixture(async ({ fake, workspace }) => {
    fake.addVersion(COMMIT_D, "0.18.0");
    fake.addVersion(COMMIT_A, "0.17.0");
    fake.setHead("main", COMMIT_D);
    let callbackRan = false;
    const error = await assertRejects(
      () =>
        workspace.prepare("latest", () => {
          callbackRan = true;
        }),
      ZigReleaseUnsupportedError,
      "0.18.0",
    );
    assertEquals(error.code, "ZIG_RELEASE_UNSUPPORTED");
    assertFalse(callbackRan);

    fake.setHead("main", COMMIT_A);
    assertEquals(
      (await workspace.prepare("latest", (prepared) => prepared.source)).version,
      "0.17.0",
    );
  });
});

Deno.test("prepareExact preserves metadata and rejects a concurrent live owner", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-source-workspace-exact-" });
  try {
    const cacheRoot = join(root, "cache");
    const stateRoot = join(root, "state");
    const fake = new FakeSourceRef(join(cacheRoot, "sources"));
    fake.addVersion(COMMIT_A, "0.16.0");
    fake.failRemoteDiscovery = true;
    const lockManager = new GlobalOperationLockManager({ stateRoot });
    const progress: string[] = [];
    const workspace = new SourceWorkspace({
      config: globalConfig(),
      cacheRoot,
      stateRoot,
      sourceRef: fake,
      lockManager,
      now: () => {
        throw new Error("exact preparation must not read the clock");
      },
      progress: (message) => {
        progress.push(message);
      },
    });
    const source = exactSource(COMMIT_A);
    const callbackStarted = deferred<void>();
    const callbackGate = deferred<void>();
    let callbackOperationId = "";

    const running = workspace.prepareExact(source, async (prepared) => {
      callbackOperationId = prepared.operationId;
      assertEquals(prepared.source, source);
      assertEquals(prepared.checkout.requested, { kind: "commit", value: COMMIT_A });
      assertEquals(prepared.checkout.resolvedCommit, COMMIT_A);
      assertEquals(prepared.adapter.id, "zig-cmake-llvm21-autodoc-v1");
      callbackStarted.resolve();
      await callbackGate.promise;
      return prepared.source.version;
    }, { operation: "sync exact source", scope: "/test/scope" });

    await callbackStarted.promise;
    const owner = await lockManager.inspect({ kind: "source" });
    assertEquals(owner?.operation, "sync exact source");
    assertEquals(owner?.scope, "/test/scope");
    assertEquals(owner?.selector, "latest");
    assertEquals(callbackOperationId, owner?.operationId);
    const mutations = mutationCalls(fake);
    let queuedCallbackRan = false;
    const busy = await assertRejects(
      () =>
        workspace.prepareExact(source, (prepared) => {
          queuedCallbackRan = true;
          return prepared.operationId;
        }, { operation: "concurrent exact source", scope: "/other/scope" }),
      GlobalOperationLockBusyError,
    );
    assertEquals(busy.owner?.operationId, callbackOperationId);
    assertFalse(queuedCallbackRan);
    assertEquals(mutationCalls(fake), mutations);

    callbackGate.resolve();
    assertEquals(await running, "0.16.0");
    assertEquals(await lockManager.inspect({ kind: "source" }), null);
    assertEquals(remoteDiscoveryCalls(fake), 0);
    assertEquals(progress, [`Preparing exact Zig source at ${COMMIT_A}...\n`]);
  } finally {
    await cleanup(root);
  }
});

Deno.test("prepareExact verifies stored repository and derived version", async () => {
  await withFixture(async ({ fake, workspace }) => {
    fake.addVersion(COMMIT_A, "0.16.0");
    const wrongVersion = {
      ...exactSource(COMMIT_A),
      version: "0.16.1",
      versionMetadata: {
        ...exactSource(COMMIT_A).versionMetadata,
        base: "0.16.1",
        text: "0.16.1",
        taggedAncestor: "0.16.1",
      },
    };
    await assertRejects(
      () => workspace.prepareExact(wrongVersion, () => {}),
      ZigSourceNotReadyError,
      "derived version",
    );

    const wrongRepository = {
      ...exactSource(COMMIT_A),
      repository: {
        identity: "codeberg/not-zig",
        url: REPOSITORY_URL,
      },
    };
    await assertRejects(
      () => workspace.prepareExact(wrongRepository, () => {}),
      ZigSourceNotReadyError,
      "does not match global config",
    );
  });
});

interface Fixture {
  readonly root: string;
  readonly fake: FakeSourceRef;
  readonly workspace: SourceWorkspace;
  readonly progress: string[];
  readonly clockCalls: () => number;
}

async function withFixture(action: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "zig-source-workspace-" });
  try {
    const cacheRoot = join(root, "cache");
    const fake = new FakeSourceRef(join(cacheRoot, "sources"));
    const progress: string[] = [];
    let clockCallCount = 0;
    const workspace = new SourceWorkspace({
      config: globalConfig(),
      cacheRoot,
      stateRoot: join(root, "state"),
      sourceRef: fake,
      now: () => {
        clockCallCount++;
        return new Date(NOW);
      },
      progress: (message) => {
        progress.push(message);
      },
    });
    await action({ root, fake, workspace, progress, clockCalls: () => clockCallCount });
  } finally {
    await cleanup(root);
  }
}

function globalConfig(): GlobalConfig {
  return { ...DEFAULT_GLOBAL_CONFIG, zigRepository: REPOSITORY_URL };
}

function exactSource(commit: string): ResolvedSource {
  return {
    component: "zig",
    repository: { identity: ZIG_SOURCE_REPOSITORY_IDENTITY, url: REPOSITORY_URL },
    requestedSelector: "latest",
    resolvedRef: { kind: "head", value: "main" },
    commit,
    version: "0.16.0",
    versionMetadata: {
      kind: "release",
      base: "0.16.0",
      text: "0.16.0",
      taggedAncestor: "0.16.0",
      commitsAfterTag: 0,
      commitAbbreviation: commit.slice(0, 9),
    },
    resolvedAt: NOW,
  };
}

function remoteDiscoveryCalls(fake: FakeSourceRef): number {
  return fake.calls.filter((call) =>
    call.method === "resolveRemoteHead" || call.method === "listRemoteRefs"
  ).length;
}

function mutationCalls(fake: FakeSourceRef): number {
  return fake.calls.filter((call) => call.method === "update" || call.method === "ensure").length;
}

interface FakeCall {
  readonly method: string;
  readonly kind?: "tag" | "branch";
}

interface VersionMetadata {
  readonly base: string;
  readonly tag: string;
  readonly distance: number;
  readonly llvmMajor: number;
}

class FakeSourceRef implements SourceWorkspaceSourceRef {
  readonly sourceRoot: string;
  readonly repositoryHome: string;
  readonly checkoutPath: string;
  readonly calls: FakeCall[] = [];
  readonly refs: RemoteRef[] = [];
  readonly versions = new Map<string, VersionMetadata>();
  head: RemoteHead = { branch: "main", commit: COMMIT_A };
  locked: { ref: GitRef; commit: string } | null = null;
  dirty = false;
  failRemoteDiscovery = false;
  statusPatch: Partial<RepositoryStatus> = {};
  checkoutPatch: Partial<CheckoutResult> = {};
  beforeNextMutation: (() => void) | null = null;

  constructor(sourceRoot: string) {
    this.sourceRoot = sourceRoot;
    this.repositoryHome = join(sourceRoot, "codeberg", "zig");
    this.checkoutPath = join(this.repositoryHome, "git-src");
  }

  addVersion(commit: string, base: string, tag = base, distance = 0, llvmMajor = 21): void {
    this.versions.set(commit, { base, tag, distance, llvmMajor });
  }

  setHead(branch: string, commit: string): void {
    this.head = { branch, commit };
    this.setBranch(branch, commit);
  }

  setBranch(name: string, commit: string): void {
    const index = this.refs.findIndex((ref) => ref.kind === "branch" && ref.name === name);
    const ref: RemoteRef = { kind: "branch", name, commit };
    if (index === -1) this.refs.push(ref);
    else this.refs[index] = ref;
  }

  resolveRemoteHead(_request: ResolveRemoteHeadRequest): Promise<RemoteHead> {
    this.calls.push({ method: "resolveRemoteHead" });
    if (this.failRemoteDiscovery) return Promise.reject(new Error("remote discovery disabled"));
    return Promise.resolve({ ...this.head });
  }

  listRemoteRefs(request: ListRemoteRefsRequest): Promise<RemoteRef[]> {
    this.calls.push({ method: "listRemoteRefs", kind: request.kind });
    if (this.failRemoteDiscovery) return Promise.reject(new Error("remote discovery disabled"));
    return Promise.resolve(
      this.refs.filter((ref) => request.kind === undefined || ref.kind === request.kind).map((
        ref,
      ) => ({ ...ref })),
    );
  }

  doctor(): Promise<SourceRefDoctorResult> {
    this.calls.push({ method: "doctor" });
    return Promise.resolve({
      schemaVersion: 1,
      ok: true,
      git: {
        available: true,
        version: "2.50.0",
        minimumVersion: "2.20.0",
        supported: true,
        message: null,
      },
      projectRoot: this.sourceRoot,
      root: this.sourceRoot,
      lockFile: join(this.sourceRoot, "source-ref.lock.json"),
    });
  }

  async ensure(request: EnsureRequest): Promise<CheckoutResult> {
    this.calls.push({ method: "ensure" });
    this.runMutationHook();
    const wasMissing = this.locked === null;
    if (this.locked !== null && !sameRef(this.locked.ref, request.ref)) {
      throw new LockedRequestMismatchError("codeberg/zig");
    }
    // Deliberately preserve an existing lock, matching source-ref ensure semantics.
    const commit = this.locked?.commit ?? this.resolveRef(request.ref);
    this.locked ??= { ref: cloneRef(request.ref), commit };
    await this.writeSource(commit);
    return this.result(request.ref, commit, wasMissing);
  }

  async update(
    _selector: RepositorySelector,
    options: UpdateOptions = {},
  ): Promise<CheckoutResult> {
    this.calls.push({ method: "update" });
    if (this.locked === null) throw new RepositoryNotFoundError("codeberg/zig");
    this.runMutationHook();
    const ref = options.ref ?? this.locked.ref;
    const commit = this.resolveRef(ref);
    this.locked = { ref: cloneRef(ref), commit };
    await this.writeSource(commit);
    return this.result(ref, commit, false);
  }

  describeRevision(
    _selector: RepositorySelector,
    _options?: DescribeRevisionOptions,
  ): Promise<RevisionDescription> {
    this.calls.push({ method: "describeRevision" });
    if (this.locked === null) return Promise.reject(new RepositoryNotFoundError("codeberg/zig"));
    const metadata = this.versions.get(this.locked.commit);
    if (metadata === undefined) {
      return Promise.reject(new Error(`missing version metadata for ${this.locked.commit}`));
    }
    return Promise.resolve({
      commit: this.locked.commit,
      tag: metadata.tag,
      commitsSinceTag: metadata.distance,
      abbreviatedCommit: this.locked.commit.slice(0, 9),
    });
  }

  status(
    _selector?: RepositorySelector,
    _options?: StatusOptions,
  ): Promise<RepositoryStatus[]> {
    this.calls.push({ method: "status" });
    if (this.locked === null) return Promise.reject(new RepositoryNotFoundError("codeberg/zig"));
    const base: RepositoryStatus = {
      id: { provider: "codeberg", name: "zig" },
      repositoryHome: this.repositoryHome,
      checkoutPath: this.checkoutPath,
      url: REPOSITORY_URL,
      mode: "pinned",
      requested: cloneRef(this.locked.ref),
      lockedCommit: this.locked.commit,
      checkoutExists: true,
      currentCommit: this.locked.commit,
      currentBranch: null,
      dirty: this.dirty,
      changes: this.dirty ? [" M CMakeLists.txt"] : [],
      aheadBehind: null,
      matchesLock: true,
    };
    return Promise.resolve([{ ...base, ...this.statusPatch }]);
  }

  path(_selector: RepositorySelector, options: PathOptions = {}): string {
    this.calls.push({ method: "path" });
    return options.repositoryRoot ? this.repositoryHome : this.checkoutPath;
  }

  private resolveRef(ref: GitRef): string {
    if (ref.kind === "commit") return ref.value.toLowerCase();
    const remote = this.refs.find((item) => item.kind === ref.kind && item.name === ref.value);
    if (remote === undefined) throw new Error(`missing fake ${ref.kind}:${ref.value}`);
    return remote.commit.toLowerCase();
  }

  private runMutationHook(): void {
    const hook = this.beforeNextMutation;
    this.beforeNextMutation = null;
    hook?.();
  }

  private async writeSource(commit: string): Promise<void> {
    const metadata = this.versions.get(commit);
    if (metadata === undefined) throw new Error(`missing version metadata for ${commit}`);
    const [major, minor, patch] = metadata.base.split(".");
    await Deno.mkdir(this.checkoutPath, { recursive: true });
    await Deno.writeTextFile(
      join(this.checkoutPath, "CMakeLists.txt"),
      [
        "cmake_minimum_required(VERSION 3.15)",
        `set(ZIG_VERSION_MAJOR ${major})`,
        `set(ZIG_VERSION_MINOR ${minor})`,
        `set(ZIG_VERSION_PATCH ${patch})`,
        'set(ZIG_VERSION "" CACHE STRING "Override Zig version")',
        'set(ZIG_USE_LLVM_CONFIG ON CACHE BOOL "use llvm-config")',
        `find_package(llvm ${metadata.llvmMajor})`,
        `find_package(clang ${metadata.llvmMajor})`,
        `find_package(lld ${metadata.llvmMajor})`,
        "set(ZIG_BUILD_ARGS",
        ...(metadata.llvmMajor === 21 ? ["  -Dno-langref"] : []),
        ")",
        'set(ZIG_EXTRA_BUILD_ARGS "" CACHE STRING "Extra zig build args")',
        "if(ZIG_EXTRA_BUILD_ARGS)",
        "  list(APPEND ZIG_BUILD_ARGS ${ZIG_EXTRA_BUILD_ARGS})",
        "endif()",
        "install(SCRIPT cmake/install.cmake)",
        "",
      ].join("\n"),
    );
    if (metadata.llvmMajor !== 21) {
      await Deno.writeTextFile(
        join(this.checkoutPath, "build.zig"),
        'const skip_install_langref = b.option(bool, "no-langref", "skip copying of langref") orelse false;\n',
      );
    }
    if (metadata.llvmMajor === 22) {
      const sourceRoot = join(this.checkoutPath, "src");
      await Deno.mkdir(sourceRoot, { recursive: true });
      await Promise.all([
        Deno.writeTextFile(
          join(sourceRoot, "zig_llvm.cpp"),
          "opt_bisect.setIntervals({0, limit});\n",
        ),
        Deno.writeTextFile(
          join(sourceRoot, "zig_llvm-ar.cpp"),
          '#include "llvm/ADT/StringMap.h"\n',
        ),
        Deno.writeTextFile(
          join(sourceRoot, "zig_clang_driver.cpp"),
          '#include "clang/Options/Options.h"\n',
        ),
      ]);
    }
  }

  private result(ref: GitRef, commit: string, cloned: boolean): CheckoutResult {
    return {
      operationId: "fake-source-operation",
      id: { provider: "codeberg", name: "zig" },
      repositoryHome: this.repositoryHome,
      checkoutPath: this.checkoutPath,
      url: REPOSITORY_URL,
      mode: "pinned",
      requested: cloneRef(ref),
      resolvedCommit: commit,
      cloned,
      fetched: true,
      checkoutChanged: true,
      ...this.checkoutPatch,
    };
  }
}

function cloneRef(ref: GitRef): GitRef {
  return { kind: ref.kind, value: ref.value } as GitRef;
}

function sameRef(left: GitRef, right: GitRef): boolean {
  return left.kind === right.kind && left.value === right.value;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

async function cleanup(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound)) throw cause;
  }
}
