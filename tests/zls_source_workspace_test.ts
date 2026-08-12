import { assert, assertEquals, assertFalse, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  type CheckoutResult,
  type DescribeRevisionOptions,
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
} from "@zignado/source-ref";
import {
  deriveZlsSourceVersion,
  parseBuildZigZonVersion,
  parseZlsZigCompatibility,
  selectHighestZlsTag,
  ZlsSourceVersionError,
  zlsZigCompatibilityReason,
} from "../src/zls_source_version.ts";
import {
  type ResolvedZlsSource,
  ZLS_SOURCE_REPOSITORY_IDENTITY,
  ZLS_SOURCE_REPOSITORY_URL,
  ZlsSourceNotReadyError,
  ZlsSourceVersionNotFoundError,
  ZlsSourceWorkspace,
  type ZlsSourceWorkspaceLockManager,
  type ZlsSourceWorkspaceSourceRef,
} from "../src/zls_source_workspace.ts";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const COMMIT_C = "c".repeat(40);
const COMMIT_D = "d".repeat(40);
const NOW = "2026-08-11T12:34:56.789Z";

Deno.test("strict ZLS release-cycle selection and source versions are canonical", () => {
  const selected = selectHighestZlsTag(
    [
      { kind: "tag", name: "0.16.9", commit: COMMIT_A },
      { kind: "tag", name: "0.16.10", commit: COMMIT_B },
      { kind: "tag", name: "v0.16.99", commit: COMMIT_C },
      { kind: "tag", name: "00.16.99", commit: COMMIT_C },
      { kind: "tag", name: "0.16.11-dev.1", commit: COMMIT_C },
      { kind: "branch", name: "0.16.99", commit: COMMIT_D },
      { kind: "tag", name: "0.17.0", commit: COMMIT_D },
    ],
    0,
    16,
  );
  assertEquals(selected, {
    tag: "0.16.10",
    version: { major: 0, minor: 16, patch: 10, text: "0.16.10" },
    commit: COMMIT_B,
  });
  assertEquals(selectHighestZlsTag([], 0, 16), null);
  assertThrows(() => selectHighestZlsTag([], -1, 16), TypeError);

  assertEquals(
    parseBuildZigZonVersion('.{\n    .name = .zls,\n    .version = "0.17.0-dev",\n}\n'),
    "0.17.0-dev",
  );
  const release = deriveZlsSourceVersion("0.16.0", revision(COMMIT_A, "0.16.0", 0));
  assertEquals(release, {
    kind: "release",
    declaredVersion: "0.16.0",
    base: "0.16.0",
    text: "0.16.0",
    versionString: "0.16.0",
    taggedAncestor: "0.16.0",
    commitsAfterTag: 0,
    commitAbbreviation: COMMIT_A.slice(0, 9),
  });
  const development = deriveZlsSourceVersion(
    "0.17.0-dev",
    revision(COMMIT_B, "0.16.0", 27),
  );
  assertEquals(development.text, `0.17.0-dev.27+${COMMIT_B.slice(0, 9)}`);
  assertEquals(development.versionString, development.text);
  assertThrows(
    () => deriveZlsSourceVersion("0.16.0", revision(COMMIT_B, "0.16.0", 1)),
    ZlsSourceVersionError,
    "not newer",
  );
  assertThrows(
    () => parseBuildZigZonVersion('.{ .version = "0.17.0-dev.1" }'),
    ZlsSourceVersionError,
    "exactly once",
  );
  const developmentCompatibility = parseZlsZigCompatibility(
    zonSource("0.17.0-dev", "0.17.0-dev.292+fc1c83a36"),
    buildSource("0.17.0-dev.601+0ff175b69"),
  );
  assertEquals(developmentCompatibility, {
    minimumBuildVersion: "0.17.0-dev.292+fc1c83a36",
    maximumBuildVersionExclusive: "0.17.0-dev.601+0ff175b69",
  });
  assertEquals(
    zlsZigCompatibilityReason(
      "0.17.0-dev.1746+89e0881f1",
      development,
      developmentCompatibility,
    ),
    "ZLS supports Zig versions below 0.17.0-dev.601+0ff175b69, not 0.17.0-dev.1746+89e0881f1",
  );
  assertEquals(
    zlsZigCompatibilityReason(
      "0.17.0-dev.291+aaaaaaaaa",
      development,
      developmentCompatibility,
    ),
    "ZLS requires Zig 0.17.0-dev.292+fc1c83a36 or newer, not 0.17.0-dev.291+aaaaaaaaa",
  );
  assertEquals(
    zlsZigCompatibilityReason(
      "0.17.0-dev.601+0ff175b69",
      development,
      developmentCompatibility,
    ),
    "ZLS supports Zig versions below 0.17.0-dev.601+0ff175b69, not 0.17.0-dev.601+0ff175b69",
  );
  assertEquals(
    zlsZigCompatibilityReason(
      "0.17.0-dev.400+aaaaaaaaa",
      development,
      developmentCompatibility,
    ),
    null,
  );
  const releaseCompatibility = parseZlsZigCompatibility(
    zonSource("0.16.0", "0.16.0"),
    buildSource(null),
  );
  assertEquals(zlsZigCompatibilityReason("0.16.0", release, releaseCompatibility), null);
  assertEquals(
    zlsZigCompatibilityReason("0.17.0", release, releaseCompatibility),
    "tagged ZLS 0.16.0 requires Zig release cycle 0.16, not 0.17.0",
  );
});

Deno.test("latest follows symbolic remote HEAD and materializes verified development metadata", async () => {
  await withFixture(async ({ fake, lockManager, progress, workspace }) => {
    fake.addVersion(COMMIT_A, "0.16.0", "0.16.0", 0);
    fake.addVersion(COMMIT_B, "0.17.0-dev", "0.16.0", 27);
    fake.setHead("master", COMMIT_B);
    fake.refs.push({ kind: "tag", name: "HEAD", commit: COMMIT_A });

    const prepared = await workspace.prepare("latest", (value) => {
      assert(lockManager.held);
      return value;
    });

    assertEquals(prepared.source, {
      component: "zls",
      repository: {
        identity: ZLS_SOURCE_REPOSITORY_IDENTITY,
        url: ZLS_SOURCE_REPOSITORY_URL,
      },
      requestedSelector: "latest",
      resolvedRef: { kind: "head", value: "master" },
      commit: COMMIT_B,
      version: `0.17.0-dev.27+${COMMIT_B.slice(0, 9)}`,
      versionMetadata: prepared.version,
      resolvedAt: NOW,
    });
    assertEquals(prepared.checkout.requested, { kind: "branch", value: "master" });
    assertEquals(prepared.version.versionString, prepared.source.version);
    assertEquals(prepared.checkoutPath, fake.checkoutPath);
    assertEquals(fake.calls.filter((call) => call.method === "resolveRemoteHead").length, 1);
    assertEquals(fake.calls.filter((call) => call.method === "listRemoteRefs").length, 0);
    assertEquals(fake.describeOptions?.tagPattern, "*.*.*");
    assertEquals(fake.describeOptions?.abbreviationLength, 9);
    assertFalse(lockManager.held);
    assertEquals(progress, [
      "Resolving ZLS source 'latest'...\n",
      `Preparing ZLS source 'latest' at ${COMMIT_B}...\n`,
    ]);
    assert(
      fake.calls.filter((call) => call.url !== undefined).every((call) =>
        call.url === ZLS_SOURCE_REPOSITORY_URL
      ),
    );
  });
});

Deno.test("exact stable tags, branches, and commits preserve ref kind", async () => {
  await withFixture(async ({ fake, workspace }) => {
    fake.addVersion(COMMIT_A, "0.16.0", "0.16.0", 0);
    fake.addVersion(COMMIT_B, "0.17.0-dev", "0.16.0", 3);
    fake.addVersion(COMMIT_C, "0.17.0-dev", "0.16.0", 4);
    fake.refs.push({ kind: "tag", name: "0.16.0", commit: COMMIT_A });
    fake.setBranch("release-work", COMMIT_B);

    const tag = await workspace.prepare("0.16.0", (prepared) => prepared);
    assertEquals(tag.source.resolvedRef, { kind: "tag", value: "0.16.0" });
    assertEquals(tag.checkout.requested, { kind: "tag", value: "0.16.0" });

    const branch = await workspace.prepare("branch:release-work", (prepared) => prepared);
    assertEquals(branch.source.resolvedRef, { kind: "branch", value: "release-work" });
    assertEquals(branch.checkout.requested, { kind: "branch", value: "release-work" });

    fake.failRemoteDiscovery = true;
    const commit = await workspace.prepare(
      `commit:${COMMIT_C.toUpperCase()}`,
      (prepared) => prepared,
    );
    assertEquals(commit.source.resolvedRef, { kind: "commit", value: COMMIT_C });
    assertEquals(commit.checkout.requested, { kind: "commit", value: COMMIT_C });
    assertEquals(
      fake.calls.filter((call) => call.method === "listRemoteRefs").map((call) => call.kind),
      ["tag", "branch"],
    );
  });
});

Deno.test("prepareExact reconstructs the stored commit and version without remote discovery", async () => {
  await withFixture(async ({ fake, setClockFailure, workspace }) => {
    fake.addVersion(COMMIT_A, "0.16.0", "0.16.0", 0);
    fake.addVersion(COMMIT_B, "0.17.0-dev", "0.16.0", 27);
    fake.setHead("master", COMMIT_B);
    const source = await workspace.prepare("latest", (prepared) => prepared.source);

    fake.failRemoteDiscovery = true;
    setClockFailure();
    const reconstructed = await workspace.prepareExact(source, (prepared) => prepared);
    assertEquals(reconstructed.source, source);
    assertEquals(reconstructed.checkout.requested, { kind: "commit", value: COMMIT_B });
    assertEquals(remoteDiscoveryCalls(fake), 1);

    assert(source.versionMetadata.kind === "development");
    const wrongHeight = 28;
    const wrongText = `0.17.0-dev.${wrongHeight}+${COMMIT_B.slice(0, 9)}`;
    const wrongSource: ResolvedZlsSource = {
      ...source,
      version: wrongText,
      versionMetadata: {
        ...source.versionMetadata,
        text: wrongText,
        versionString: wrongText,
        commitsAfterTag: wrongHeight,
      },
    };
    await assertRejects(
      () => workspace.prepareExact(wrongSource, () => {}),
      ZlsSourceNotReadyError,
      "derived version",
    );
    assertEquals(remoteDiscoveryCalls(fake), 1);
  });
});

Deno.test("remote races and dirty exact status prevent source exposure", async () => {
  await withFixture(async ({ fake, workspace }) => {
    fake.addVersion(COMMIT_A, "0.16.0", "0.16.0", 0);
    fake.addVersion(COMMIT_B, "0.16.1", "0.16.1", 0);
    fake.setHead("master", COMMIT_A);
    fake.beforeNextMutation = () => fake.setHead("master", COMMIT_B);
    let callbacks = 0;

    await assertRejects(
      () => workspace.prepare("latest", () => callbacks++),
      ZlsSourceVersionNotFoundError,
      "remote changed",
    );
    fake.setHead("master", COMMIT_A);
    fake.dirty = true;
    await assertRejects(
      () => workspace.prepare("latest", () => callbacks++),
      ZlsSourceNotReadyError,
      "local changes",
    );
    assertEquals(callbacks, 0);
  });
});

Deno.test("a source-root symlink is rejected before source-ref mutation", async () => {
  const root = await Deno.makeTempDir({ prefix: "zls-source-workspace-symlink-" });
  try {
    const cacheRoot = join(root, "cache");
    const sourceRoot = join(cacheRoot, "sources");
    const outside = join(root, "outside");
    await Deno.mkdir(cacheRoot);
    await Deno.mkdir(outside);
    await Deno.symlink(outside, sourceRoot);
    const fake = new FakeSourceRef(sourceRoot);
    fake.addVersion(COMMIT_A, "0.16.0", "0.16.0", 0);
    fake.setHead("master", COMMIT_A);
    const workspace = new ZlsSourceWorkspace({
      cacheRoot,
      stateRoot: join(root, "state"),
      sourceRef: fake,
      lockManager: new FakeLockManager(),
    });

    await assertRejects(
      () => workspace.prepare("latest", () => {}),
      ZlsSourceNotReadyError,
      "not a physical directory",
    );
    assertEquals(mutationCalls(fake), 0);
  } finally {
    await cleanup(root);
  }
});

interface Fixture {
  readonly fake: FakeSourceRef;
  readonly lockManager: FakeLockManager;
  readonly progress: string[];
  readonly workspace: ZlsSourceWorkspace;
  readonly setClockFailure: () => void;
}

async function withFixture(action: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "zls-source-workspace-" });
  try {
    const cacheRoot = join(root, "cache");
    const fake = new FakeSourceRef(join(cacheRoot, "sources"));
    const lockManager = new FakeLockManager();
    const progress: string[] = [];
    let clockFailure = false;
    const workspace = new ZlsSourceWorkspace({
      cacheRoot,
      stateRoot: join(root, "state"),
      sourceRef: fake,
      lockManager,
      now: () => {
        if (clockFailure) throw new Error("exact reconstruction read the clock");
        return new Date(NOW);
      },
      progress: (message) => {
        progress.push(message);
      },
    });
    await action({
      fake,
      lockManager,
      progress,
      workspace,
      setClockFailure: () => clockFailure = true,
    });
  } finally {
    await cleanup(root);
  }
}

function revision(
  commit: string,
  tag: string | null,
  commitsSinceTag: number | null,
): RevisionDescription {
  return {
    commit,
    tag,
    commitsSinceTag,
    abbreviatedCommit: commit.slice(0, 9),
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
  readonly url?: string;
}

interface FakeVersion {
  readonly declaredVersion: string;
  readonly minimumZigVersion: string;
  readonly maximumZigVersionExclusive: string | null;
  readonly tag: string;
  readonly distance: number;
}

class FakeLockManager implements ZlsSourceWorkspaceLockManager {
  held = false;
  #counter = 0;

  acquireSource(): Promise<{
    readonly owner: { readonly operationId: string };
    release(): Promise<void>;
  }> {
    if (this.held) return Promise.reject(new Error("fake source lock is already held"));
    this.held = true;
    const operationId = `fake-zls-source-${++this.#counter}`;
    return Promise.resolve({
      owner: { operationId },
      release: () => {
        this.held = false;
        return Promise.resolve();
      },
    });
  }
}

class FakeSourceRef implements ZlsSourceWorkspaceSourceRef {
  readonly sourceRoot: string;
  readonly repositoryHome: string;
  readonly checkoutPath: string;
  readonly calls: FakeCall[] = [];
  readonly refs: RemoteRef[] = [];
  readonly versions = new Map<string, FakeVersion>();
  head: RemoteHead = { branch: "master", commit: COMMIT_A };
  locked: { ref: GitRef; commit: string } | null = null;
  dirty = false;
  failRemoteDiscovery = false;
  beforeNextMutation: (() => void) | null = null;
  checkoutPatch: Partial<CheckoutResult> = {};
  statusPatch: Partial<RepositoryStatus> = {};
  describeOptions: DescribeRevisionOptions | null = null;

  constructor(sourceRoot: string) {
    this.sourceRoot = sourceRoot;
    this.repositoryHome = join(sourceRoot, "github", "zls");
    this.checkoutPath = join(this.repositoryHome, "git-src");
  }

  addVersion(
    commit: string,
    declaredVersion: string,
    tag: string,
    distance: number,
    minimumZigVersion = declaredVersion.endsWith("-dev")
      ? `${declaredVersion.slice(0, -"-dev".length)}-dev.1+aaaaaaaaa`
      : declaredVersion,
    maximumZigVersionExclusive: string | null = null,
  ): void {
    this.versions.set(commit, {
      declaredVersion,
      minimumZigVersion,
      maximumZigVersionExclusive,
      tag,
      distance,
    });
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

  resolveRemoteHead(request: ResolveRemoteHeadRequest): Promise<RemoteHead> {
    this.calls.push({ method: "resolveRemoteHead", url: request.url });
    if (this.failRemoteDiscovery) return Promise.reject(new Error("remote discovery disabled"));
    return Promise.resolve({ ...this.head });
  }

  listRemoteRefs(request: ListRemoteRefsRequest): Promise<RemoteRef[]> {
    this.calls.push({ method: "listRemoteRefs", kind: request.kind, url: request.url });
    if (this.failRemoteDiscovery) return Promise.reject(new Error("remote discovery disabled"));
    return Promise.resolve(
      this.refs.filter((ref) => request.kind === undefined || ref.kind === request.kind).map((
        ref,
      ) => ({ ...ref })),
    );
  }

  async ensure(request: EnsureRequest): Promise<CheckoutResult> {
    this.calls.push({ method: "ensure", url: request.url });
    this.runMutationHook();
    const wasMissing = this.locked === null;
    if (this.locked !== null && !sameRef(this.locked.ref, request.ref)) {
      throw new LockedRequestMismatchError(ZLS_SOURCE_REPOSITORY_IDENTITY);
    }
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
    if (this.locked === null) throw new RepositoryNotFoundError(ZLS_SOURCE_REPOSITORY_IDENTITY);
    this.runMutationHook();
    const ref = options.ref ?? this.locked.ref;
    const commit = this.resolveRef(ref);
    this.locked = { ref: cloneRef(ref), commit };
    await this.writeSource(commit);
    return this.result(ref, commit, false);
  }

  describeRevision(
    _selector: RepositorySelector,
    options: DescribeRevisionOptions = {},
  ): Promise<RevisionDescription> {
    this.calls.push({ method: "describeRevision" });
    this.describeOptions = options;
    if (this.locked === null) {
      return Promise.reject(new RepositoryNotFoundError(ZLS_SOURCE_REPOSITORY_IDENTITY));
    }
    const metadata = this.versions.get(this.locked.commit);
    if (metadata === undefined) {
      return Promise.reject(new Error(`missing version metadata for ${this.locked.commit}`));
    }
    return Promise.resolve(
      revision(this.locked.commit, metadata.tag, metadata.distance),
    );
  }

  status(
    _selector?: RepositorySelector,
    _options?: StatusOptions,
  ): Promise<RepositoryStatus[]> {
    this.calls.push({ method: "status" });
    if (this.locked === null) {
      return Promise.reject(new RepositoryNotFoundError(ZLS_SOURCE_REPOSITORY_IDENTITY));
    }
    const status: RepositoryStatus = {
      id: { provider: "github", name: "zls" },
      repositoryHome: this.repositoryHome,
      checkoutPath: this.checkoutPath,
      url: ZLS_SOURCE_REPOSITORY_URL,
      mode: "pinned",
      requested: cloneRef(this.locked.ref),
      lockedCommit: this.locked.commit,
      checkoutExists: true,
      currentCommit: this.locked.commit,
      currentBranch: null,
      dirty: this.dirty,
      changes: this.dirty ? [" M build.zig.zon"] : [],
      aheadBehind: null,
      matchesLock: true,
      ...this.statusPatch,
    };
    return Promise.resolve([status]);
  }

  path(_selector: RepositorySelector, options: PathOptions = {}): string {
    this.calls.push({ method: "path" });
    return options.repositoryRoot ? this.repositoryHome : this.checkoutPath;
  }

  private resolveRef(ref: GitRef): string {
    if (ref.kind === "commit") return ref.value.toLowerCase();
    const remote = this.refs.find((candidate) =>
      candidate.kind === ref.kind && candidate.name === ref.value
    );
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
    await Deno.mkdir(this.checkoutPath, { recursive: true });
    await Deno.writeTextFile(
      join(this.checkoutPath, "build.zig.zon"),
      zonSource(metadata.declaredVersion, metadata.minimumZigVersion),
    );
    await Deno.writeTextFile(
      join(this.checkoutPath, "build.zig"),
      buildSource(metadata.maximumZigVersionExclusive),
    );
  }

  private result(ref: GitRef, commit: string, cloned: boolean): CheckoutResult {
    return {
      operationId: "fake-source-ref-operation",
      id: { provider: "github", name: "zls" },
      repositoryHome: this.repositoryHome,
      checkoutPath: this.checkoutPath,
      url: ZLS_SOURCE_REPOSITORY_URL,
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

function zonSource(version: string, minimumZigVersion: string): string {
  return [
    ".{",
    "    .name = .zls,",
    `    .version = "${version}",`,
    `    .minimum_zig_version = "${minimumZigVersion}",`,
    "}",
    "",
  ].join("\n");
}

function buildSource(maximumZigVersionExclusive: string | null): string {
  return [
    'const std = @import("std");',
    'const builtin = @import("builtin");',
    'const minimum_build_zig_version = @import("build.zig.zon").minimum_zig_version;',
    ...(maximumZigVersionExclusive === null ? [] : [
      "const Build = blk: {",
      `    const version = std.SemanticVersion.parse("${maximumZigVersionExclusive}") catch unreachable;`,
      "    if (builtin.zig_version.order(version) != .lt) {",
      '        @compileError("The used Zig version is not yet supported by ZLS.");',
      "    }",
      "};",
    ]),
    "",
  ].join("\n");
}

function cloneRef(ref: GitRef): GitRef {
  return { kind: ref.kind, value: ref.value } as GitRef;
}

function sameRef(left: GitRef, right: GitRef): boolean {
  return left.kind === right.kind && left.value === right.value;
}

async function cleanup(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound)) throw cause;
  }
}
