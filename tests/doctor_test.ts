import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import {
  inspectBuildPrerequisites,
  inspectHostDiagnostics,
  inspectSessionDiagnostics,
  resourceDiagnosticFindings,
} from "../src/doctor.ts";
import type { GlobalConfig } from "../src/global_config.ts";
import {
  BuildPrerequisiteError,
  PlatformPaths,
  resolveZigManagerConfig,
  ZigCMake21Adapter,
  ZigCMake22Adapter,
  ZigManager,
} from "../src/mod.ts";
import { DenoDiagnosticProbe, type DiagnosticProbe } from "../src/resource_diagnostics.ts";
import type {
  DiagnosticCacheResult,
  DiagnosticFilesystemKind,
  DiagnosticFilesystemResult,
  DiagnosticMemoryResult,
  DiagnosticResourceResult,
  ProcessRequest,
  ProcessResult,
  ResolvedZigManagerConfig,
  SourceRefDoctorResult,
} from "../src/types.ts";
import {
  cleanup,
  COMMIT_A,
  COMMIT_C,
  createDevelopmentFiles,
  FakeProcessRunner,
  FakeSourceRef,
  testConfig,
} from "./test_helpers.ts";

const GIB = 1024 ** 3;
const HOST_TARGET = "x86_64-unknown-linux-gnu";

Deno.test("schema-v2 findings are complete and strict changes only doctor policy", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-doctor-shape-" });
  try {
    const prefix = await createDevelopmentFiles(root);
    const runner = new FakeProcessRunner(prefix);
    const normal = await inspect(root, runner, prefix);
    assertEquals(normal.schemaVersion, 2);
    assertEquals(normal.buildReady, true);
    assertEquals(normal.ok, true);
    assert(normal.counts.warnings > 0);
    assert(normal.findings.some((finding) => finding.code === "ZIG_TOOL_OVERRIDE"));
    for (const finding of normal.findings) {
      for (
        const key of [
          "severity",
          "code",
          "component",
          "summary",
          "required",
          "found",
          "checkedPaths",
          "remediation",
          "packageHints",
          "details",
        ]
      ) assert(Object.hasOwn(finding, key), `finding omitted ${key}`);
      assertFalse(Object.hasOwn(finding, "message"));
    }

    const strict = await inspect(root, new FakeProcessRunner(prefix), prefix, { strict: true });
    assertEquals(strict.buildReady, true);
    assertEquals(strict.ok, false);
    assertEquals(strict.counts.errors, 0);
    assert(strict.counts.warnings > 0);
  } finally {
    await cleanup(root);
  }
});

Deno.test("adapter owns exact LLVM 21 candidates, constraints, files, targets, and Arch packages", () => {
  const requirements = new ZigCMake21Adapter().requirements;
  assertEquals(requirements.tools.llvmConfig.required, "major 21");
  assertEquals(
    requirements.tools.llvmConfig.candidates.linux[0],
    "/usr/lib/llvm21/bin/llvm-config",
  );
  assertEquals(requirements.tools.llvmConfig.archPackages, ["llvm21"]);
  assertEquals(requirements.tools.clang.archPackages, ["clang21"]);
  assertEquals(requirements.tools.lld.archPackages, ["lld21"]);
  assertEquals(requirements.generators.Ninja.archPackages, ["ninja"]);
  assertEquals(requirements.archPackages.git, "git");
  assertEquals(requirements.archPackageConstraints.llvm21.acceptsVersion("21.1.8-1"), true);
  assertEquals(requirements.archPackageConstraints.llvm21.acceptsVersion("20.1.8-1"), false);
  assert(
    requirements.developmentFiles.headers.some((header) => header.archPackages[0] === "lld21"),
  );
  assert(requirements.llvmTargets.includes("AMDGPU"));
});

Deno.test("LLVM 22 adapter uses Arch's unversioned current-major packages", () => {
  const requirements = new ZigCMake22Adapter().requirements;
  assertEquals(requirements.defaultCmakePrefix.linux, "/usr");
  assertEquals(requirements.tools.llvmConfig.required, "major 22");
  assertEquals(requirements.tools.llvmConfig.candidates.linux[0], "/usr/bin/llvm-config");
  assertEquals(requirements.tools.llvmConfig.archPackages, ["llvm"]);
  assertEquals(requirements.tools.clang.archPackages, ["clang"]);
  assertEquals(requirements.tools.lld.archPackages, ["lld"]);
  assertEquals(requirements.archPackageConstraints.llvm.acceptsVersion("22.1.6-1"), true);
  assertEquals(requirements.archPackageConstraints.llvm.acceptsVersion("21.1.8-1"), false);
  assert(
    requirements.developmentFiles.headers.some((header) => header.archPackages[0] === "lld"),
  );
});

Deno.test("incompatible versions and missing development requirements remain blocking errors", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-doctor-errors-" });
  try {
    const prefix = await createDevelopmentFiles(root);
    const runner = new FakeProcessRunner(prefix);
    runner.toolVersions.llvm = "20.0.0";
    const incompatible = await inspect(root, runner, prefix);
    assertEquals(incompatible.buildReady, false);
    assert(
      incompatible.findings.some((finding) =>
        finding.component === "LLVM" && finding.code === "ZIG_TOOL_VERSION_INCOMPATIBLE" &&
        finding.severity === "error"
      ),
    );

    await cleanup(prefix);
    await Deno.mkdir(join(prefix, "include"), { recursive: true });
    await Deno.mkdir(join(prefix, "lib"), { recursive: true });
    const missingFiles = await inspect(root, new FakeProcessRunner(prefix), prefix);
    assert(
      missingFiles.findings.some((finding) =>
        finding.code === "ZIG_DEVELOPMENT_FILES_MISSING" && finding.severity === "error"
      ),
    );
  } finally {
    await cleanup(root);
  }
});

Deno.test("source-ref failures are blocking structured findings", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-doctor-source-ref-" });
  try {
    const prefix = await createDevelopmentFiles(root);
    const result = await inspect(root, new FakeProcessRunner(prefix), prefix, {
      sourceRefDoctor: null,
      sourceRefFailure: new Error("git probe failed"),
    });
    const finding = result.findings.find((item) => item.code === "ZIG_SOURCE_REF_UNAVAILABLE");
    assertEquals(finding?.severity, "error");
    assertStringIncludes(finding?.summary ?? "", "git probe failed");
    assertEquals(result.buildReady, false);
  } finally {
    await cleanup(root);
  }
});

Deno.test("verified Arch hints use only exact read-only pacman requests and inert command data", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-doctor-package-" });
  try {
    const prefix = await createDevelopmentFiles(root);
    const runner = new PackageRunner(prefix, { cmake: true });
    runner.missing.add("cmake");
    const result = await inspect(root, runner, prefix, { config: configWithoutOverrides(root) });
    const finding = result.findings.find((item) =>
      item.code === "ZIG_TOOL_MISSING" && item.component === "cmake"
    );
    assert(finding !== undefined);
    assertEquals(finding.severity, "error");
    assertEquals(finding.packageHints, [{
      manager: "pacman",
      name: "cmake",
      repository: "extra",
      version: "3.31.6-1",
      installedVersion: null,
      verified: true,
    }]);
    assertEquals(finding.command?.displayOnly, true);
    assertEquals(finding.command?.executable, "sudo");
    assertEquals(finding.command?.args, ["/usr/bin/pacman", "-Syu", "cmake"]);
    assertStringIncludes(finding.command?.warning ?? "", "full system upgrade");
    assertStringIncludes(finding.command?.warning ?? "", "unrelated packages");
    assertEquals(
      runner.requests.filter((request) => request.executable === "/usr/bin/pacman").map((request) =>
        request.args
      ),
      [["-Q", "cmake"], ["-Si", "cmake"]],
    );
  } finally {
    await cleanup(root);
  }
});

Deno.test("Git findings use the exact verified Arch git package", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-doctor-git-package-" });
  try {
    const prefix = await createDevelopmentFiles(root);
    const runner = new PackageRunner(prefix, { git: "2.50.1-1" });
    const sourceRef = sourceDoctor(root);
    const result = await inspect(root, runner, prefix, {
      sourceRefDoctor: {
        ...sourceRef,
        ok: false,
        git: {
          ...sourceRef.git,
          available: false,
          version: null,
          supported: false,
          message: "git missing",
        },
      },
    });
    const finding = result.findings.find((item) => item.code === "ZIG_GIT_UNAVAILABLE");
    assertEquals(finding?.packageHints[0]?.name, "git");
    assertEquals(finding?.command?.args, ["/usr/bin/pacman", "-Syu", "git"]);
  } finally {
    await cleanup(root);
  }
});

Deno.test("unverified metadata and explicit overrides suppress package suggestions without weakening errors", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-doctor-package-suppress-" });
  try {
    const prefix = await createDevelopmentFiles(root);
    const unverified = new PackageRunner(prefix, { cmake: false });
    unverified.missing.add("cmake");
    const missing = await inspect(root, unverified, prefix, {
      config: configWithoutOverrides(root),
    });
    const missingFinding = missing.findings.find((finding) => finding.component === "cmake");
    assertEquals(missingFinding?.severity, "error");
    assertEquals(missingFinding?.packageHints, []);
    assertEquals(missingFinding?.command, undefined);

    const outdated = new PackageRunner(prefix, { cmake: "2.8.12-1" });
    outdated.missing.add("cmake");
    const incompatiblePackage = await inspect(root, outdated, prefix, {
      config: configWithoutOverrides(root),
    });
    assertEquals(
      incompatiblePackage.findings.find((finding) => finding.component === "cmake")?.packageHints,
      [],
    );

    const explicitPath = testConfig(root, prefix).tools?.cmake ?? "";
    const explicit = new PackageRunner(prefix, { cmake: true });
    explicit.missing.add(explicitPath);
    const overridden = await inspect(root, explicit, prefix);
    const explicitFinding = overridden.findings.find((finding) =>
      finding.component === "cmake" && finding.code === "ZIG_TOOL_MISSING"
    );
    assertEquals(explicitFinding?.packageHints, []);
    assertEquals(
      explicit.requests.some((request) => request.executable === "/usr/bin/pacman"),
      false,
    );
  } finally {
    await cleanup(root);
  }
});

Deno.test("host, resource, session, and fallback diagnostics retain warning/error policy", async () => {
  const probe = new FakeDiagnosticProbe();
  const unsupported = await inspectHostDiagnostics({
    os: "linux",
    architecture: "aarch64",
    abi: "gnu",
    denoTarget: "aarch64-unknown-linux-gnu",
  }, probe);
  assertEquals(unsupported.host.supported, false);
  assert(unsupported.findings.some((finding) => finding.code === "ZIG_HOST_UNSUPPORTED"));

  const resource: DiagnosticResourceResult = {
    filesystems: [
      filesystem("cache-build", 19 * GIB),
      filesystem("data-staging", 30 * GIB),
      { ...filesystem("scope", null), writable: false, message: "permission denied" },
    ],
    memory: {
      totalBytes: 8 * GIB,
      availableBytes: 4 * GIB,
      recommendedBytes: 16 * GIB,
      message: null,
    },
    cache: {
      path: "/cache",
      thresholdBytes: 1,
      measuredBytes: null,
      complete: false,
      message: "bounded scan failed",
    },
  };
  const resourceFindings = resourceDiagnosticFindings(resource);
  assert(resourceFindings.some((finding) => finding.code === "ZIG_DISK_INSUFFICIENT"));
  assert(resourceFindings.some((finding) => finding.code === "ZIG_DISK_LOW"));
  assert(resourceFindings.some((finding) => finding.code === "ZIG_DISK_UNKNOWN"));
  assert(resourceFindings.some((finding) => finding.code === "ZIG_PATH_UNWRITABLE"));
  assert(resourceFindings.some((finding) => finding.code === "ZIG_MEMORY_LOW"));
  assert(resourceFindings.some((finding) => finding.code === "ZIG_CACHE_SIZE_UNKNOWN"));
  assert(
    resourceDiagnosticFindings({
      ...resource,
      cache: {
        path: "/cache",
        thresholdBytes: 1,
        measuredBytes: 2,
        complete: false,
        message: "threshold reached",
      },
    }).some((finding) => finding.code === "ZIG_CACHE_LARGE"),
  );

  const runner = new FakeProcessRunner("/llvm21");
  const session = await inspectSessionDiagnostics({
    env: { PATH: "/fallback", "BASH_FUNC_zig%%": "() { :; }" },
    expectedShimDirectory: "/managed/shims",
    fallbackPath: "/fallback/zig",
    pinRelevant: true,
    runner,
  });
  assertEquals(session.session.fallback.usable, true);
  assertEquals(session.session.fallback.version, "0.16.0");
  assert(session.findings.some((finding) => finding.code === "ZIG_SESSION_INACTIVE"));
  assert(
    session.findings.some((finding) =>
      finding.code === "ZIG_SHELL_PRECEDENCE" && finding.severity === "info"
    ),
  );
  const missingFallback = await inspectSessionDiagnostics({
    env: { PATH: "/empty" },
    expectedShimDirectory: "/managed/shims",
    fallbackPath: null,
    pinRelevant: false,
    runner,
  });
  assert(
    missingFallback.findings.some((finding) => finding.code === "ZIG_FALLBACK_NOT_FOUND"),
  );
  assertFalse(
    missingFallback.findings.some((finding) => finding.code === "ZIG_SESSION_INACTIVE"),
  );

  const unusableFallback = await inspectSessionDiagnostics({
    env: { PATH: "/broken" },
    expectedShimDirectory: "/managed/shims",
    fallbackPath: "/broken/zig",
    pinRelevant: false,
    runner: { run: () => Promise.resolve(processResult("", "broken\n", 1)) },
  });
  assert(
    unusableFallback.findings.some((finding) => finding.code === "ZIG_FALLBACK_UNUSABLE"),
  );
  const incoherent = await inspectSessionDiagnostics({
    env: {
      PATH: "/wrong:/base",
      ZM_SESSION_ACTIVE: "1",
      ZM_SHIM_DIR: "/wrong",
      ZM_BASE_PATH: "/base",
    },
    expectedShimDirectory: "/managed/shims",
    fallbackPath: "/base/zig",
    pinRelevant: false,
    runner,
  });
  assert(incoherent.findings.some((finding) => finding.code === "ZIG_SESSION_INCOHERENT"));
});

Deno.test("default resource probes reject and never traverse symlinked paths", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-doctor-resource-symlink-" });
  try {
    const physical = join(root, "physical");
    const linked = join(root, "linked");
    await Deno.mkdir(physical);
    await Deno.symlink(physical, linked);
    const probe = new DenoDiagnosticProbe();
    const filesystem = await probe.inspectFilesystem(join(linked, "future"), "cache-build");
    assertEquals(filesystem.writable, false);
    assertStringIncludes(filesystem.message ?? "", "symbolic link");
    const cache = await probe.inspectCache(linked, 1);
    assertEquals(cache.measuredBytes, null);
    assertEquals(cache.complete, false);
    assertStringIncludes(cache.message ?? "", "symbolic link");
  } finally {
    await cleanup(root);
  }
});

Deno.test("development and stale moving sources warn without blocking normal builds", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-doctor-source-warning-" });
  try {
    const prefix = await createDevelopmentFiles(root);
    const probe = new FakeDiagnosticProbe(new Date("2026-08-10T12:00:00.000Z"));
    const result = await inspect(root, new FakeProcessRunner(prefix), prefix, {
      probe,
      source: {
        component: "zig",
        repository: {
          identity: "codeberg/zig",
          url: "https://codeberg.org/ziglang/zig.git",
        },
        requestedSelector: "latest",
        resolvedRef: { kind: "head", value: "master" },
        commit: COMMIT_A,
        version: "0.17.0-dev.1+aaaaaaaaa",
        versionMetadata: {
          kind: "development",
          base: "0.17.0",
          text: "0.17.0-dev.1+aaaaaaaaa",
          taggedAncestor: "0.17.0",
          commitsAfterTag: 1,
          commitAbbreviation: "aaaaaaaaa",
        },
        resolvedAt: "2026-08-01T00:00:00.000Z",
      },
      version: {
        kind: "development",
        base: "0.17.0",
        text: "0.17.0-dev.1+aaaaaaaaa",
        taggedAncestor: "0.17.0",
        commitsAfterTag: 1,
        commitAbbreviation: "aaaaaaaaa",
      },
    });
    assertEquals(result.buildReady, true);
    assert(result.findings.some((finding) => finding.code === "ZIG_DEVELOPMENT_SOURCE"));
    assert(result.findings.some((finding) => finding.code === "ZIG_MOVING_SELECTOR_STALE"));
  } finally {
    await cleanup(root);
  }
});

Deno.test("host doctor is offline, mode combinations are rejected, and effective config is redacted", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-host-doctor-" });
  try {
    const fallback = join(root, "bin", "zig");
    await Deno.mkdir(join(root, "bin"), { recursive: true });
    await Deno.writeTextFile(fallback, "fixture\n", { mode: 0o755 });
    await Deno.chmod(fallback, 0o755);
    const sourceRef = new FakeSourceRef(root);
    const manager = managerForDoctor(root, sourceRef, new FakeDiagnosticProbe());
    const host = await manager.doctor(undefined, { host: true });
    assertEquals(host.schemaVersion, 2);
    assertEquals(host.mode, "host");
    assertEquals(host.adapter, null);
    assertEquals(host.toolchain, null);
    assertEquals(sourceRef.calls, ["doctor"]);
    assertFalse(
      sourceRef.calls.some((call) => call === "resolveRemoteHead" || call === "listRemoteRefs"),
    );

    sourceRef.calls.length = 0;
    const implicitHost = await manager.doctor();
    assertEquals(implicitHost.mode, "host");
    assertEquals(sourceRef.calls, ["doctor"]);

    await Deno.remove(fallback);
    await Deno.mkdir(manager.paths.shimsDir, { recursive: true });
    const managedShim = join(manager.paths.shimsDir, "zig");
    await Deno.writeTextFile(managedShim, "fixture shim\n", { mode: 0o755 });
    await Deno.chmod(managedShim, 0o755);
    await Deno.symlink(managedShim, fallback);
    const recursiveFallback = await manager.doctor(undefined, { host: true });
    assertEquals(recursiveFallback.session.fallback.path, null);
    assert(
      recursiveFallback.findings.some((finding) => finding.code === "ZIG_FALLBACK_NOT_FOUND"),
    );

    await assertRejects(
      () => manager.doctor("0.16.0", { host: true }),
      Error,
      "selector with --host",
    );
    await assertRejects(() => manager.doctor(undefined, { host: true, verify: true }), Error);
    await assertRejects(() => manager.doctor("0.16.0", { verify: true }), Error);
    await assertRejects(() => manager.doctor(undefined, { verify: true }), Error, "requires");

    const secret = managerForDoctor(root, new FakeSourceRef(root), new FakeDiagnosticProbe(), {
      zigRepository: "https://user:super-secret@example.invalid/zig.git?token=hidden",
    });
    const redacted = await secret.doctor(undefined, { host: true });
    const serialized = JSON.stringify(redacted.effectiveConfig);
    assertFalse(serialized.includes("super-secret"));
    assertFalse(serialized.includes("hidden"));
    assertStringIncludes(serialized, "redacted");
  } finally {
    await cleanup(root);
  }
});

Deno.test("selector and pin modes report source failures and full verification without configuring", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-doctor-modes-" });
  try {
    const fixture = await sourceManagerForDoctor(root);
    const selected = await fixture.manager.doctor("0.16.0");
    assertEquals(selected.mode, "source");
    assertEquals(selected.source?.commit, COMMIT_A);
    assertEquals(selected.adapter, "zig-cmake-llvm21-autodoc-v1");
    assert(selected.toolchain !== null);
    assertEquals(
      fixture.runner.requests.some((request) =>
        request.args[0] === "-S" || request.args[0] === "--build"
      ),
      false,
    );

    const unsupported = await fixture.manager.doctor("0.15.2");
    assertEquals(unsupported.adapter, null);
    assert(
      unsupported.findings.some((finding) => finding.code === "ZIG_RELEASE_UNSUPPORTED"),
    );
    const unsupportedFinding = unsupported.findings.find((finding) =>
      finding.code === "ZIG_RELEASE_UNSUPPORTED"
    );
    assertEquals(unsupportedFinding?.details.commit, COMMIT_C);
    assertEquals(unsupportedFinding?.details.version, "0.15.2");

    fixture.sourceRef.failRemote = true;
    const remote = await fixture.manager.doctor("latest");
    assertEquals(remote.adapter, null);
    assert(
      remote.findings.some((finding) => finding.code === "ZIG_REMOTE_HEAD_UNAVAILABLE"),
    );
    fixture.sourceRef.failRemote = false;

    await fixture.manager.use("0.16.0");
    fixture.sourceRef.calls.length = 0;
    const pinned = await fixture.manager.doctor(undefined, { verify: true });
    assertEquals(pinned.mode, "pin");
    assertEquals(pinned.verification?.level, "full-install");
    assertEquals(pinned.verification?.ok, true);
    assertEquals(pinned.verification?.compilesAndRuns, true);
    assertStringIncludes(pinned.verification?.summary ?? "", "compile/run");
    assertFalse(fixture.sourceRef.calls.includes("resolveRemoteHead"));
    assertFalse(fixture.sourceRef.calls.includes("listRemoteRefs"));
  } finally {
    await cleanup(root);
  }
});

Deno.test("scope/data/cache resource errors block use before CMake configure", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-doctor-resource-block-" });
  try {
    const probe = new FakeDiagnosticProbe();
    probe.unwritable.add("data-staging");
    const fixture = await sourceManagerForDoctor(root, probe);
    const error = await assertRejects(
      () => fixture.manager.use("0.16.0"),
      BuildPrerequisiteError,
    );
    assert(
      error.findings.some((finding) =>
        finding.code === "ZIG_PATH_UNWRITABLE" &&
        finding.component === "data-staging filesystem"
      ),
    );
    assertEquals(
      fixture.runner.requests.some((request) => request.args[0] === "-S"),
      false,
    );
    assertEquals(probe.filesystemRequests.map((request) => request.kind), [
      "cache-build",
      "data-staging",
      "scope",
    ]);
  } finally {
    await cleanup(root);
  }
});

function inspect(
  root: string,
  runner: FakeProcessRunner,
  prefix: string,
  options: {
    readonly strict?: boolean;
    readonly config?: ResolvedZigManagerConfig;
    readonly probe?: DiagnosticProbe;
    readonly source?: Parameters<typeof inspectBuildPrerequisites>[0]["source"];
    readonly version?: Parameters<typeof inspectBuildPrerequisites>[0]["sourceVersion"];
    readonly sourceRefDoctor?: SourceRefDoctorResult | null;
    readonly sourceRefFailure?: unknown;
  } = {},
) {
  return inspectBuildPrerequisites({
    config: options.config ?? resolveZigManagerConfig(testConfig(root, prefix), root),
    adapter: new ZigCMake21Adapter(),
    sourceRefDoctor: options.sourceRefDoctor === undefined
      ? sourceDoctor(root)
      : options.sourceRefDoctor,
    sourceRefFailure: options.sourceRefFailure,
    runner,
    env: {},
    platform: "linux",
    resourcePaths: {
      cacheBuild: join(root, "cache-build"),
      dataStaging: join(root, "data-staging"),
      cacheRoot: root,
    },
    diagnosticProbe: options.probe ?? new FakeDiagnosticProbe(),
    source: options.source,
    sourceVersion: options.version,
    arch: true,
    strict: options.strict,
  });
}

function configWithoutOverrides(root: string): ResolvedZigManagerConfig {
  const config = resolveZigManagerConfig(testConfig(root), root);
  return {
    ...config,
    build: { ...config.build, cmakePrefixPath: null },
    tools: {
      cmake: null,
      cCompiler: null,
      cxxCompiler: null,
      llvmConfig: null,
      clang: null,
      lld: null,
      generatorTool: null,
    },
  };
}

function sourceDoctor(root: string): SourceRefDoctorResult {
  return {
    schemaVersion: 1,
    ok: true,
    git: {
      available: true,
      version: "2.50.0",
      minimumVersion: "2.20.0",
      supported: true,
      message: null,
    },
    projectRoot: root,
    root: join(root, ".source-ref"),
    lockFile: join(root, "source-ref.lock.json"),
  };
}

function filesystem(
  kind: DiagnosticFilesystemKind,
  availableBytes: number | null,
): DiagnosticFilesystemResult {
  return {
    kind,
    path: `/${kind}`,
    checkedPath: `/${kind}`,
    writable: true,
    availableBytes,
    minimumBytes: 20 * GIB,
    recommendedBytes: 40 * GIB,
    message: null,
  };
}

class FakeDiagnosticProbe implements DiagnosticProbe {
  readonly #now: Date;
  filesystemBytes: number | null = 80 * GIB;
  memory: DiagnosticMemoryResult = {
    totalBytes: 64 * GIB,
    availableBytes: 48 * GIB,
    recommendedBytes: 16 * GIB,
    message: null,
  };
  cache: DiagnosticCacheResult | null = null;
  osRelease = "NAME=Arch Linux\nID=arch\n";
  readonly unwritable = new Set<DiagnosticFilesystemKind>();
  readonly filesystemRequests: {
    readonly path: string;
    readonly kind: DiagnosticFilesystemKind;
  }[] = [];

  constructor(now = new Date("2026-08-10T00:00:00.000Z")) {
    this.#now = now;
  }

  inspectFilesystem(
    path: string,
    kind: DiagnosticFilesystemKind,
  ): Promise<DiagnosticFilesystemResult> {
    this.filesystemRequests.push({ path, kind });
    const writable = !this.unwritable.has(kind);
    return Promise.resolve({
      kind,
      path,
      checkedPath: path,
      writable,
      availableBytes: this.filesystemBytes,
      minimumBytes: 20 * GIB,
      recommendedBytes: 40 * GIB,
      message: writable ? null : "fixture path is unwritable",
    });
  }

  inspectMemory(): Promise<DiagnosticMemoryResult> {
    return Promise.resolve({ ...this.memory });
  }

  inspectCache(path: string, thresholdBytes: number | null): Promise<DiagnosticCacheResult> {
    return Promise.resolve(
      this.cache ?? {
        path,
        thresholdBytes,
        measuredBytes: thresholdBytes === null ? null : 0,
        complete: thresholdBytes === null ? null : true,
        message: null,
      },
    );
  }

  readTextFile(): Promise<string> {
    return Promise.resolve(this.osRelease);
  }

  now(): Date {
    return new Date(this.#now);
  }
}

class PackageRunner extends FakeProcessRunner {
  readonly missing = new Set<string>();
  readonly metadata: Readonly<Record<string, boolean | string>>;

  constructor(prefix: string, metadata: Readonly<Record<string, boolean | string>>) {
    super(prefix);
    this.metadata = metadata;
  }

  override run(request: ProcessRequest): Promise<ProcessResult> {
    if (this.missing.has(request.executable)) {
      this.requests.push(copyRequest(request));
      return Promise.reject(new Deno.errors.NotFound("missing"));
    }
    if (request.executable === "/usr/bin/pacman") {
      this.requests.push(copyRequest(request));
      const packageName = request.args[1] ?? "";
      if (request.args[0] === "-Q") return Promise.resolve(processResult("", "not installed\n", 1));
      if (request.args[0] === "-Si" && this.metadata[packageName]) {
        const version = typeof this.metadata[packageName] === "string"
          ? this.metadata[packageName]
          : "3.31.6-1";
        return Promise.resolve(processResult(
          `Repository      : extra\nName            : ${packageName}\nVersion         : ${version}\n`,
        ));
      }
      return Promise.resolve(processResult("malformed metadata\n"));
    }
    return super.run(request);
  }
}

function copyRequest(request: ProcessRequest): ProcessRequest {
  return { ...request, args: [...request.args], env: { ...(request.env ?? {}) } };
}

function processResult(stdout = "", stderr = "", code = 0): ProcessResult {
  return {
    success: code === 0,
    code,
    signal: null,
    stdout,
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function managerForDoctor(
  root: string,
  sourceRef: FakeSourceRef,
  probe: DiagnosticProbe,
  configOverride: Partial<GlobalConfig> = {},
): ZigManager {
  const globalConfig: GlobalConfig = {
    zigRepository: "https://codeberg.org/ziglang/zig.git",
    build: {
      profile: "release",
      generator: "Ninja",
      jobs: null,
      cpu: "baseline",
      cmakePrefixPath: null,
    },
    tools: {
      cmake: null,
      cCompiler: null,
      cxxCompiler: null,
      llvmConfig: null,
      clang: null,
      lld: null,
      generatorTool: null,
    },
    warnings: { cacheBytes: null, movingSelectorMaxAgeHours: 24 },
    ...configOverride,
  };
  return new ZigManager({
    env: {
      HOME: root,
      PATH: join(root, "bin"),
      ZIG_MANAGER_HOME: join(root, "manager"),
    },
    home: root,
    cwd: root,
    platform: "linux",
    architecture: "x86_64",
    hostTarget: HOST_TARGET,
    sourceRef,
    runner: new FakeProcessRunner(join(root, "toolchain")),
    diagnosticProbe: probe,
    services: { configStore: { load: () => Promise.resolve(globalConfig) } },
  });
}

async function sourceManagerForDoctor(
  root: string,
  probe: DiagnosticProbe = new FakeDiagnosticProbe(),
): Promise<{
  readonly manager: ZigManager;
  readonly sourceRef: FakeSourceRef;
  readonly runner: FakeProcessRunner;
}> {
  const managerHome = join(root, "manager");
  const fallbackDir = join(root, "bin");
  await Deno.mkdir(fallbackDir, { recursive: true });
  await Deno.writeTextFile(join(fallbackDir, "zig"), "fixture\n", { mode: 0o755 });
  await Deno.chmod(join(fallbackDir, "zig"), 0o755);
  const prefix = await createDevelopmentFiles(root);
  const env = {
    HOME: root,
    PATH: fallbackDir,
    ZIG_MANAGER_HOME: managerHome,
  };
  const paths = new PlatformPaths({ env, home: root, platform: "linux" });
  const sourceRef = new FakeSourceRef(root, paths.sourcesDir);
  const runner = new FakeProcessRunner(prefix);
  const config: GlobalConfig = {
    zigRepository: "https://codeberg.org/ziglang/zig.git",
    build: {
      profile: "release",
      generator: "Ninja",
      jobs: null,
      cpu: "baseline",
      cmakePrefixPath: null,
    },
    tools: {
      cmake: join(root, "tools", "cmake"),
      cCompiler: join(root, "tools", "cc"),
      cxxCompiler: join(root, "tools", "c++"),
      llvmConfig: join(root, "tools", "llvm-config"),
      clang: join(root, "tools", "clang"),
      lld: join(root, "tools", "ld.lld"),
      generatorTool: join(root, "tools", "ninja"),
    },
    warnings: { cacheBytes: null, movingSelectorMaxAgeHours: 24 },
  };
  return {
    sourceRef,
    runner,
    manager: new ZigManager({
      env,
      home: root,
      cwd: root,
      platform: "linux",
      architecture: "x86_64",
      hostTarget: HOST_TARGET,
      sourceRef,
      runner,
      diagnosticProbe: probe,
      services: {
        configStore: { load: () => Promise.resolve(config) },
        hostSupport: () => {},
      },
    }),
  };
}
