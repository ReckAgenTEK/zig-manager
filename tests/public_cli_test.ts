import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import * as publicApi from "../src/mod.ts";
import {
  type CliManager,
  type CliSignalRuntime,
  runCli,
  runCliDetailed,
  runCliMain,
} from "../src/cli.ts";
import type {
  DiagnosticFinding,
  DoctorOptions,
  GcOptions,
  ProcessResult,
  RunOptions,
  ScopeOperationOptions,
  UseOptions,
  ZigInstallResult,
  ZigManagerDoctorResult,
  ZigManagerStatus,
  ZigUseResult,
} from "../src/types.ts";

const ID = "a".repeat(64);
const PROFILE = "b".repeat(64);
const COMMIT = "c".repeat(40);

Deno.test("public API exports the directory-scoped facade and stores", () => {
  assertEquals(typeof publicApi.ZigManager, "function");
  assertEquals(typeof publicApi.PlatformPaths, "function");
  assertEquals(typeof publicApi.ScopeResolver, "function");
  assertEquals(typeof publicApi.InstallStore, "function");
  assertEquals(typeof publicApi.ToolchainProfileStore, "function");
  assertEquals(typeof publicApi.SessionShimManager, "function");
  assertEquals(publicApi.BUILD_MANIFEST_SCHEMA_VERSION, 2);
  assertEquals(Object.keys(publicApi).includes("DenoProcessRunner"), false);
});

Deno.test("CLI import is inert, help names zm commands, and JSON errors are stable", async () => {
  const output = capture();
  assertEquals(await runCli(["help"], output.io), 0);
  for (
    const command of [
      "shell activate",
      "install",
      "use",
      "unuse",
      "sync",
      "update",
      "list",
      "current",
      "which",
      "run",
      "doctor",
      "uninstall",
      "gc",
      "repair",
      "purge",
    ]
  ) assertStringIncludes(output.stdout(), command);
  assertEquals(output.stderr(), "");

  output.reset();
  assertEquals(await runCli(["unknown", "--json"], output.io, () => new FakeCliManager()), 1);
  const document = JSON.parse(output.stdout());
  assertEquals(document.schemaVersion, 2);
  assertEquals(document.error.code, "ZIG_INVALID_ARGUMENT");
});

Deno.test("CLI parses use --installed and path without invoking source-oriented use", async () => {
  const fake = new FakeCliManager();
  const output = capture();
  assertEquals(
    await runCli(
      ["use", "--installed", ID, "--path", "/scope path", "--json"],
      output.io,
      () => fake,
    ),
    0,
  );
  assertEquals(fake.calls, [{ method: "useInstalled", id: ID, path: "/scope path" }]);
  const document = JSON.parse(output.stdout());
  assertEquals(document.command, "use");
  assertEquals(document.result.installationId, ID);
  assertEquals(output.stderr(), "");
});

Deno.test("CLI exposes exact installation uninstall with JSON output", async () => {
  const fake = new FakeCliManager();
  const output = capture();
  assertEquals(await runCli(["uninstall", ID, "--json"], output.io, () => fake), 0);
  assertEquals(fake.calls, [{ method: "uninstall", id: ID }]);
  const document = JSON.parse(output.stdout());
  assertEquals(document.command, "uninstall");
  assertEquals(document.result, {
    schemaVersion: 1,
    component: "zig",
    installationId: ID,
    version: "0.16.0",
    root: `/managed/installs/zig/${ID}`,
    removed: true,
  });
});

Deno.test("CLI parses build options and emits activation reminder only for human use", async () => {
  const fake = new FakeCliManager();
  const output = capture();
  await runCli(
    ["use", "latest", "--path", "/scope", "--profile", "debug", "--jobs", "7"],
    output.io,
    () => fake,
  );
  assertEquals(fake.calls, [{
    method: "use",
    selector: "latest",
    options: { path: "/scope", profile: "debug", jobs: 7 },
  }]);
  assertStringIncludes(output.stdout(), "/scope");
  assertStringIncludes(output.stderr(), 'eval "$(zm shell activate bash)"');
});

Deno.test("shell code is the only activation stdout and JSON activation is rejected on stderr", async () => {
  const fake = new FakeCliManager();
  const output = capture();
  assertEquals(await runCli(["shell", "activate", "bash"], output.io, () => fake), 0);
  assertEquals(output.stdout(), "export ZM_SESSION_ACTIVE=1\n");
  assertEquals(output.stderr(), "");

  output.reset();
  assertEquals(
    await runCli(["shell", "activate", "bash", "--json"], output.io, () => fake),
    1,
  );
  assertEquals(output.stdout(), "");
  assertStringIncludes(output.stderr(), "support --json");
});

Deno.test("run forwards selector, arguments, child streams, exit, and signal exactly", async () => {
  const fake = new FakeCliManager();
  fake.runStatus = result(143, "SIGTERM");
  const output = capture();
  const status = await runCliDetailed(
    ["run", "latest", "--", "build", "--json", "value with spaces"],
    output.io,
    () => fake,
  );
  assertEquals(fake.calls, [{
    method: "run",
    args: ["build", "--json", "value with spaces"],
    selector: "latest",
  }]);
  assertEquals(output.stdout(), "child stdout\n");
  assertEquals(output.stderr(), "child stderr\n");
  assertEquals(status, { success: false, code: 143, signal: "SIGTERM" });

  output.reset();
  assertEquals(await runCli(["run", "--json", "--", "version"], output.io, () => fake), 1);
  assertEquals(JSON.parse(output.stdout()).error.code, "ZIG_INVALID_ARGUMENT");
});

Deno.test("CLI JSON result parsing covers current and gc flags", async () => {
  const fake = new FakeCliManager();
  const output = capture();
  assertEquals(
    await runCli(["current", "--path", "/scope", "--check", "--json"], output.io, () => fake),
    0,
  );
  assertEquals(fake.calls[0], { method: "current", path: "/scope", check: true });
  assertEquals(JSON.parse(output.stdout()).result.mode, "fallback");

  output.reset();
  assertEquals(
    await runCli(["gc", "--dry-run", "--sources", "--profiles", "--json"], output.io, () => fake),
    0,
  );
  assertEquals(fake.calls[1], {
    method: "gc",
    options: { dryRun: true, sources: true, buildCache: false, profiles: true },
  });
});

Deno.test("doctor prints every finding and strict affects only its exit policy", async () => {
  const fake = new FakeCliManager();
  fake.doctorFindings = [{
    severity: "warning",
    code: "ZIG_MEMORY_LOW",
    component: "system memory",
    summary: "memory is below recommendation",
    required: 16,
    found: 8,
    checkedPaths: [],
    remediation: "reduce build parallelism",
    packageHints: [],
    details: {},
  }];
  const output = capture();
  assertEquals(await runCli(["doctor"], output.io, () => fake), 0);
  assertStringIncludes(output.stdout(), "warning ZIG_MEMORY_LOW");
  assertStringIncludes(output.stdout(), "remediation: reduce build parallelism");

  output.reset();
  assertEquals(await runCli(["doctor", "--strict", "--json"], output.io, () => fake), 1);
  const document = JSON.parse(output.stdout());
  assertEquals(document.result.buildReady, true);
  assertEquals(document.result.ok, false);
  assertEquals(document.result.findings[0].remediation, "reduce build parallelism");

  for (
    const args of [
      ["doctor", "0.16.0", "--host", "--json"],
      ["doctor", "--host", "--verify", "--json"],
      ["doctor", "0.16.0", "--verify", "--json"],
    ]
  ) {
    output.reset();
    assertEquals(await runCli(args, output.io, () => fake), 1);
    assertEquals(JSON.parse(output.stdout()).error.code, "ZIG_INVALID_ARGUMENT");
  }
});

Deno.test("build prerequisite errors expose only errors and print finding remediation", async () => {
  const fake = new FakeCliManager();
  const warning: DiagnosticFinding = {
    severity: "warning",
    code: "ZIG_MEMORY_LOW",
    component: "memory",
    summary: "low",
    required: 16,
    found: 8,
    checkedPaths: [],
    remediation: "optional memory remediation",
    packageHints: [],
    details: {},
  };
  const error: DiagnosticFinding = {
    severity: "error",
    code: "ZIG_TOOL_MISSING",
    component: "cmake",
    summary: "cmake missing",
    required: ">=3.15.0",
    found: null,
    checkedPaths: ["cmake"],
    remediation: "install verified cmake",
    packageHints: [],
    details: {},
  };
  fake.installError = new publicApi.BuildPrerequisiteError([warning, error]);
  const output = capture();
  assertEquals(await runCli(["install", "0.16.0"], output.io, () => fake), 1);
  assertStringIncludes(output.stderr(), "ZIG_TOOL_MISSING");
  assertStringIncludes(output.stderr(), "remediation: install verified cmake");
  assertEquals(output.stderr().includes("optional memory remediation"), false);

  output.reset();
  assertEquals(await runCli(["install", "0.16.0", "--json"], output.io, () => fake), 1);
  const document = JSON.parse(output.stdout());
  assertEquals(document.error.details.findings.length, 1);
  assertEquals(document.error.details.findings[0].severity, "error");
  assertEquals(typeof document.error.remediation, "string");
});

Deno.test("one CLI invocation signal is forwarded unchanged to every cancellable command", async () => {
  const controller = new AbortController();
  const seen: Array<{ readonly method: string; readonly signal: AbortSignal | undefined }> = [];
  const target = new FakeCliManager();
  const manager = new Proxy(target, {
    get(value, property, receiver) {
      const member = Reflect.get(value, property, receiver);
      if (typeof member !== "function") return member;
      return (...args: unknown[]) => {
        const options = args.find((argument) =>
          argument !== null && typeof argument === "object" && "signal" in argument
        ) as { readonly signal?: AbortSignal } | undefined;
        seen.push({ method: String(property), signal: options?.signal });
        return Reflect.apply(member, value, args);
      };
    },
  }) as CliManager;
  const commands: readonly (readonly string[])[] = [
    ["install", "0.16.0"],
    ["use", "0.16.0"],
    ["use", "--installed", ID],
    ["unuse"],
    ["sync"],
    ["update"],
    ["list", "--remote"],
    ["current", "--check"],
    ["status", "--check"],
    ["which", "zig"],
    ["run", "--", "version"],
    ["doctor"],
    ["shell", "status"],
    ["gc", "--dry-run"],
    ["repair"],
    ["purge", "--dry-run"],
    ["uninstall", ID],
  ];
  for (const command of commands) {
    const output = capture();
    await runCli(command, output.io, () => manager, controller.signal);
  }
  assertEquals(seen.map((entry) => entry.method), [
    "install",
    "use",
    "useInstalled",
    "unuse",
    "sync",
    "update",
    "list",
    "current",
    "status",
    "which",
    "run",
    "doctor",
    "shellStatus",
    "gc",
    "repair",
    "purge",
    "uninstall",
  ]);
  assert(seen.every((entry) => entry.signal === controller.signal));
});

Deno.test("CLI main bridges the first signal to abort and re-raises only after cleanup", async () => {
  const manager = new SignalWaitingCliManager();
  const runtime = new FakeSignalRuntime();
  const output = capture();
  const pending = runCliMain(["install", "0.16.0"], output.io, () => manager, runtime);
  await manager.started;
  runtime.emit("SIGINT");
  assertEquals(manager.abortReason, "SIGINT");
  runtime.emit("SIGTERM");
  assertEquals(runtime.raised, ["SIGTERM"]);
  const status = await pending;
  assertEquals(status, { success: false, code: 130, signal: "SIGINT" });
  assertEquals(runtime.raised, ["SIGTERM", "SIGINT"]);
  assertEquals(runtime.listeners.size, 0);
  assertEquals(runtime.events.slice(-3), ["remove:SIGINT", "raise:SIGTERM", "raise:SIGINT"]);
  assert(manager.signal instanceof AbortSignal);
});

Deno.test("all published JSON schemas are strict JSON documents", async () => {
  const schemaRoot = new URL("../schema/", import.meta.url);
  for (
    const name of [
      "zig-manager-global.schema.json",
      "catalog-v3.schema.json",
      "install-manifest-v3.schema.json",
      "build-recipe-v1.schema.json",
      "toolchain-profile.schema.json",
      "scopes-v1.schema.json",
      "build-manifest.schema.json",
      "docs-manifest.schema.json",
      "zig-manager.schema.json",
      "state.schema.json",
    ]
  ) {
    const schema = JSON.parse(await Deno.readTextFile(new URL(name, schemaRoot)));
    assertEquals(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assertEquals(schema.additionalProperties, false);
  }
});

Deno.test("package metadata publishes the inert CLI entrypoint and documents non-compiled zm", async () => {
  const deno = JSON.parse(
    await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
  );
  assertEquals(deno.exports["./cli"], "./src/cli.ts");
  assertEquals(publicApi.ZIG_MANAGER_VERSION, deno.version);
  assertStringIncludes(deno.tasks.zm, "src/cli.ts");
  assertEquals(deno.publish.include.includes("schema"), true);
  assertEquals(deno.publish.include.includes("docs"), true);
  assertStringIncludes(deno.tasks["test:e2e:arch"], "ZIG_MANAGER_E2E=1");

  const readme = await Deno.readTextFile(new URL("../README.md", import.meta.url));
  assertStringIncludes(readme, "deno install --global --name zm");
  assertStringIncludes(readme, `jsr:@zignado/zig-manager@${deno.version}/cli`);
  assertStringIncludes(readme, "deno install --global --force --name zm");
  assertStringIncludes(readme, "deno uninstall --global zm");
  assertEquals(readme.includes("--compile"), false);
});

class FakeCliManager implements CliManager {
  readonly calls: unknown[] = [];
  runStatus: ProcessResult = result(0, null);
  doctorFindings: DiagnosticFinding[] = [];
  installError: Error | null = null;

  versions() {
    return Promise.resolve([]);
  }

  list() {
    return Promise.resolve({
      schemaVersion: 1 as const,
      installations: [],
      profiles: [],
      remote: null,
    });
  }

  install(selector: string): Promise<ZigInstallResult> {
    this.calls.push({ method: "install", selector });
    if (this.installError !== null) return Promise.reject(this.installError);
    return Promise.resolve(installResult(selector));
  }

  uninstall(id: string) {
    this.calls.push({ method: "uninstall", id });
    return Promise.resolve({
      schemaVersion: 1 as const,
      component: "zig" as const,
      installationId: id,
      version: "0.16.0",
      root: `/managed/installs/zig/${id}`,
      removed: true as const,
    });
  }

  use(selector: string, options: UseOptions = {}): Promise<ZigUseResult> {
    this.calls.push({ method: "use", selector, options });
    return Promise.resolve(useResult(selector, options.path ?? "/scope"));
  }

  useInstalled(id: string, options: ScopeOperationOptions = {}): Promise<ZigUseResult> {
    this.calls.push({ method: "useInstalled", id, path: options.path });
    return Promise.resolve(useResult("0.16.0", options.path ?? "/scope"));
  }

  unuse(options: ScopeOperationOptions = {}) {
    this.calls.push({ method: "unuse", path: options.path });
    return Promise.resolve({
      schemaVersion: 1 as const,
      scopeRoot: options.path ?? "/scope",
      pinPath: "/scope/.zig-manager/toolchain",
      removed: true as const,
    });
  }

  sync() {
    return Promise.resolve({
      schemaVersion: 1 as const,
      scopeRoot: "/scope",
      profileId: PROFILE,
      installationId: ID,
      executable: "/managed/zig",
      rebuilt: false,
    });
  }

  update() {
    return Promise.resolve({
      ...useResult("latest", "/scope"),
      previousProfileId: PROFILE,
      changed: false,
      immutable: false,
    });
  }

  current(options: { readonly path?: string; readonly check?: boolean } = {}) {
    this.calls.push({ method: "current", path: options.path, check: options.check });
    return Promise.resolve(fallbackStatus(options.path ?? "/cwd"));
  }

  status(options: { readonly path?: string; readonly check?: boolean } = {}) {
    return this.current(options);
  }

  which() {
    return Promise.resolve("/managed/zig");
  }

  async run(args: readonly string[], options: RunOptions = {}): Promise<ProcessResult> {
    this.calls.push({ method: "run", args: [...args], selector: options.selector });
    await options.onStdout?.(new TextEncoder().encode("child stdout\n"));
    await options.onStderr?.(new TextEncoder().encode("child stderr\n"));
    return this.runStatus;
  }

  doctor(
    _selector?: string,
    options: DoctorOptions = {},
  ): Promise<ZigManagerDoctorResult> {
    const errors = this.doctorFindings.filter((finding) => finding.severity === "error").length;
    const warnings = this.doctorFindings.filter((finding) => finding.severity === "warning").length;
    const info = this.doctorFindings.filter((finding) => finding.severity === "info").length;
    const strict = options.strict === true;
    return Promise.resolve({
      schemaVersion: 2,
      mode: "host",
      strict,
      ok: errors === 0 && (!strict || warnings === 0),
      buildReady: errors === 0,
      counts: { errors, warnings, info },
      errors,
      warnings,
      info,
      host: {
        os: "linux",
        architecture: "x86_64",
        abi: "gnu",
        denoTarget: HOST_TARGET,
        supported: true,
        distributionId: "arch",
        required: {
          os: "linux",
          architecture: "x86_64",
          abi: "gnu",
          denoTarget: HOST_TARGET,
          distributionId: "arch",
        },
        checkedPaths: ["/etc/os-release"],
      },
      selector: null,
      source: null,
      adapter: null,
      toolchain: null,
      resources: {
        filesystems: [],
        memory: {
          totalBytes: 32 * 1024 ** 3,
          availableBytes: 32 * 1024 ** 3,
          recommendedBytes: 16 * 1024 ** 3,
          message: null,
        },
        cache: {
          path: "/cache",
          thresholdBytes: null,
          measuredBytes: null,
          complete: null,
          message: null,
        },
      },
      session: {
        active: false,
        pinRelevant: false,
        expectedShimDirectory: "/shims",
        configuredShimDirectory: null,
        basePath: null,
        pathStartsWithShim: false,
        coherent: true,
        fallback: {
          path: "/usr/bin/zig",
          version: "0.16.0",
          usable: true,
          arguments: ["version"],
          message: null,
        },
        precedence: "path",
      },
      sourceRef: sourceDoctor(),
      effectiveConfig: {
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
      },
      verification: null,
      findings: [...this.doctorFindings],
    });
  }

  shellActivate() {
    return Promise.resolve("export ZM_SESSION_ACTIVE=1\n");
  }

  shellDeactivate() {
    return Promise.resolve("unset ZM_SESSION_ACTIVE\n");
  }

  shellStatus() {
    return Promise.resolve({
      schemaVersion: 2 as const,
      active: false,
      shimDirectory: "/shims",
      basePath: null,
      fallbackZig: null,
      fallbackVersion: null,
      fallbackUsable: false,
      current: fallbackStatus("/cwd"),
    });
  }

  gc(options: GcOptions = {}) {
    this.calls.push({ method: "gc", options });
    return Promise.resolve({
      schemaVersion: 1 as const,
      dryRun: true,
      removed: [],
      retained: [],
      registry: null,
    });
  }

  repair() {
    return Promise.resolve({
      schemaVersion: 1 as const,
      catalogRebuilt: true,
      shimsReinstalled: true,
      scopeValid: null,
      unlocked: null,
      registry: {
        path: "/state/scopes.json",
        state: "missing" as const,
        entryCount: null,
        profilePruningSafe: false,
        reason: "missing",
        reconciled: null,
      },
    });
  }

  purge() {
    return Promise.resolve({
      schemaVersion: 1 as const,
      dryRun: true,
      roots: [],
      registry: {
        path: "/state/scopes.json",
        state: "missing" as const,
        entryCount: null,
        profilePruningSafe: false,
        reason: "missing",
      },
      danglingPins: [],
    });
  }
}

class SignalWaitingCliManager extends FakeCliManager {
  readonly started: Promise<void>;
  signal: AbortSignal | undefined;
  abortReason: unknown;
  #start!: () => void;

  constructor() {
    super();
    this.started = new Promise((resolve) => this.#start = resolve);
  }

  override install(
    selector: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<ZigInstallResult> {
    this.signal = options.signal;
    this.#start();
    return new Promise((_resolve, reject) => {
      const abort = () => {
        this.abortReason = options.signal?.reason;
        reject(new Error(`aborted ${selector}`));
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
    });
  }
}

class FakeSignalRuntime implements CliSignalRuntime {
  readonly listeners = new Map<Deno.Signal, () => void>();
  readonly raised: Deno.Signal[] = [];
  readonly events: string[] = [];

  addSignalListener(signal: "SIGINT" | "SIGTERM", listener: () => void): void {
    this.events.push(`add:${signal}`);
    this.listeners.set(signal, listener);
  }

  removeSignalListener(signal: "SIGINT" | "SIGTERM", listener: () => void): void {
    this.events.push(`remove:${signal}`);
    if (this.listeners.get(signal) === listener) this.listeners.delete(signal);
  }

  raiseSignal(signal: Deno.Signal): void {
    this.events.push(`raise:${signal}`);
    this.raised.push(signal);
  }

  emit(signal: "SIGINT" | "SIGTERM"): void {
    const listener = this.listeners.get(signal);
    if (listener === undefined) throw new Error(`no listener for ${signal}`);
    listener();
  }
}

function installResult(selector: string): ZigInstallResult {
  return {
    schemaVersion: 1,
    selector,
    installationId: ID,
    version: "0.16.0",
    commit: COMMIT,
    executable: "/managed/zig",
    reused: true,
  };
}

function useResult(selector: string, scopeRoot: string): ZigUseResult {
  return {
    ...installResult(selector),
    profileId: PROFILE,
    scopeRoot,
    pinPath: `${scopeRoot}/.zig-manager/toolchain`,
    activationRequired: true,
  };
}

function fallbackStatus(lookupPath: string): ZigManagerStatus {
  return {
    schemaVersion: 1,
    lookupPath,
    mode: "fallback",
    scopeRoot: null,
    pinPath: null,
    profileId: null,
    installationId: null,
    selector: null,
    version: null,
    commit: null,
    executable: "/usr/bin/zig",
    update: { checked: false, moving: false, available: null, resolvedCommit: null },
  };
}

function result(code: number, signal: Deno.Signal | null): ProcessResult {
  return {
    success: code === 0 && signal === null,
    code,
    signal,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function sourceDoctor() {
  return {
    schemaVersion: 1 as const,
    ok: true,
    git: {
      available: true,
      version: "2.50.0",
      minimumVersion: "2.20.0",
      supported: true,
      message: null,
    },
    projectRoot: "/manager",
    root: "/manager/sources",
    lockFile: "/manager/source-ref.lock.json",
  };
}

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
    reset: () => {
      stdout = "";
      stderr = "";
    },
  };
}

const HOST_TARGET = "x86_64-unknown-linux-gnu";
