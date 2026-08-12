import { fromFileUrl, join } from "@std/path";

const STARTUP_TIMEOUT_MS = 20_000;
const CDP_COMMAND_TIMEOUT_MS = 15_000;
const TOP_LEVEL_LOAD_TIMEOUT_MS = 90_000;
const AUTODOC_TIMEOUT_MS = 180_000;
const INTERACTION_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 50;
const FALLBACK_ZIG_VERSION = "0.0.0-e2e-fallback";
const FALLBACK_ZLS_VERSION = "0.0.0-e2e-zls-fallback";
const COMPATIBLE_RELEASE_SELECTOR = "0.16.0";
const SECOND_BUILD_PROFILE = "minsizerel";
const RESOLVER_BENCHMARK_RUNS = 20;

type JsonObject = Record<string, unknown>;
type CdpListener = (params: JsonObject) => void;

interface PendingCommand {
  readonly method: string;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly resolve: (value: JsonObject) => void;
  readonly reject: (reason: Error) => void;
}

interface BrowserProcessState {
  status?: Deno.CommandStatus;
  statusError?: unknown;
}

interface ViewState {
  readonly controlsReady: boolean;
  readonly languagePressed: string | null;
  readonly standardPressed: string | null;
  readonly languageActive: boolean;
  readonly standardActive: boolean;
  readonly languageVisible: boolean;
  readonly standardVisible: boolean;
}

interface AutodocState {
  readonly ready: boolean;
  readonly title: string;
  readonly status: string | null;
  readonly searchPlaceholder: string | null;
  readonly errorsVisible: boolean;
  readonly errors: string;
}

interface SearchItem {
  readonly text: string;
  readonly href: string | null;
}

interface SearchState {
  readonly query: string | null;
  readonly title: string;
  readonly resultsVisible: boolean;
  readonly noResultsVisible: boolean;
  readonly resultCount: number;
  readonly items: readonly SearchItem[];
}

interface SelectionState {
  readonly selectedCount: number;
  readonly selectedIndex: number;
  readonly text: string | null;
  readonly href: string | null;
}

interface PageDiagnostics {
  readonly assertHealthy: () => void;
  readonly dispose: () => void;
}

class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly listeners = new Map<string, Set<CdpListener>>();
  private closedReason: Error | undefined;

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => this.handleMessage(event));
    socket.addEventListener("error", () => {
      this.handleClosed(new Error("CDP WebSocket failed"));
    });
    socket.addEventListener("close", () => {
      this.handleClosed(new Error("CDP WebSocket closed"));
    });
  }

  static async connect(url: string, timeoutMs: number): Promise<CdpClient> {
    const client = new CdpClient(new WebSocket(url));
    try {
      await client.waitForOpen(timeoutMs);
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }

  get isOpen(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  async send(
    method: string,
    params: JsonObject = {},
    timeoutMs = CDP_COMMAND_TIMEOUT_MS,
  ): Promise<JsonObject> {
    if (!this.isOpen) {
      throw this.closedReason ?? new Error(`Cannot send ${method}: CDP WebSocket is not open`);
    }
    const id = this.nextId++;
    return await new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for CDP ${method}`));
      }, timeoutMs);
      this.pending.set(id, { method, timer, resolve, reject });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(toError(error));
      }
    });
  }

  on(method: string, listener: CdpListener): () => void {
    let listeners = this.listeners.get(method);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(method, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(method);
    };
  }

  close(): void {
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    ) {
      try {
        this.socket.close();
      } catch {
        // The browser may have already torn down the socket.
      }
    }
  }

  private async waitForOpen(timeoutMs: number): Promise<void> {
    if (this.isOpen) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out after ${timeoutMs}ms connecting to the CDP WebSocket`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.removeEventListener("open", onOpen);
        this.socket.removeEventListener("error", onError);
        this.socket.removeEventListener("close", onClose);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("CDP WebSocket failed while connecting"));
      };
      const onClose = () => {
        cleanup();
        reject(new Error("CDP WebSocket closed while connecting"));
      };
      this.socket.addEventListener("open", onOpen);
      this.socket.addEventListener("error", onError);
      this.socket.addEventListener("close", onClose);
    });
  }

  private handleMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") {
      this.handleClosed(new Error("CDP sent a non-text message"));
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(event.data) as unknown;
    } catch (error) {
      this.handleClosed(new Error(`CDP sent invalid JSON: ${errorMessage(error)}`));
      return;
    }
    const message = asObject(value);
    if (message === null) {
      this.handleClosed(new Error("CDP sent a non-object message"));
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (pending === undefined) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      const protocolError = asObject(message.error);
      if (protocolError !== null) {
        pending.reject(
          new Error(
            `CDP ${pending.method} failed: ${String(protocolError.message ?? "unknown error")}`,
          ),
        );
        return;
      }
      const result = asObject(message.result);
      if (result === null) {
        pending.reject(new Error(`CDP ${pending.method} returned a malformed result`));
        return;
      }
      pending.resolve(result);
      return;
    }
    if (typeof message.method !== "string") return;
    const params = asObject(message.params) ?? {};
    for (const listener of [...(this.listeners.get(message.method) ?? [])]) listener(params);
  }

  private handleClosed(reason: Error): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    for (const command of this.pending.values()) {
      clearTimeout(command.timer);
      command.reject(reason);
    }
    this.pending.clear();
  }
}

const VIEW_STATE_EXPRESSION = `(() => {
  const languageButton = document.getElementById("show-language");
  const standardButton = document.getElementById("show-standard");
  const language = document.getElementById("language");
  const standard = document.getElementById("standard");
  const visible = (element) => {
    if (element === null || getComputedStyle(element).display === "none") return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  };
  return {
    controlsReady: languageButton !== null && standardButton !== null &&
      language !== null && standard !== null,
    languagePressed: languageButton?.getAttribute("aria-pressed") ?? null,
    standardPressed: standardButton?.getAttribute("aria-pressed") ?? null,
    languageActive: language?.classList.contains("active") ?? false,
    standardActive: standard?.classList.contains("active") ?? false,
    languageVisible: visible(language),
    standardVisible: visible(standard),
  };
})()`;

const AUTODOC_STATE_EXPRESSION = `(() => {
  const frame = document.getElementById("standard");
  const win = frame?.contentWindow ?? null;
  const doc = frame?.contentDocument ?? null;
  const search = doc?.getElementById("search") ?? null;
  const status = doc?.getElementById("status") ?? null;
  const nav = doc?.getElementById("sectNav") ?? null;
  const errors = doc?.getElementById("errors") ?? null;
  return {
    ready: doc?.readyState === "complete" && search !== null &&
      Boolean(win?.wasm?.instance?.exports) && status?.classList.contains("hidden") === true &&
      nav?.classList.contains("hidden") === false,
    title: doc?.title ?? "",
    status: status?.textContent ?? null,
    searchPlaceholder: search?.getAttribute("placeholder") ?? null,
    errorsVisible: errors !== null && !errors.classList.contains("hidden"),
    errors: doc?.getElementById("errorsText")?.textContent ?? "",
  };
})()`;

const SEARCH_STATE_EXPRESSION = `(() => {
  const frame = document.getElementById("standard");
  const win = frame?.contentWindow ?? null;
  const doc = frame?.contentDocument ?? null;
  const input = doc?.getElementById("search") ?? null;
  const results = doc?.getElementById("sectSearchResults") ?? null;
  const noResults = doc?.getElementById("sectSearchNoResults") ?? null;
  const list = doc?.getElementById("listSearchResults") ?? null;
  const visible = (element) => win !== null && element !== null &&
    !element.classList.contains("hidden") &&
    win.getComputedStyle(element).display !== "none";
  const items = list === null ? [] : Array.from(list.children).slice(0, 10).map((item) => {
    const link = item.querySelector("a");
    return { text: link?.textContent?.trim() ?? "", href: link?.getAttribute("href") ?? null };
  });
  return {
    query: input?.value ?? null,
    title: doc?.title ?? "",
    resultsVisible: visible(results),
    noResultsVisible: visible(noResults),
    resultCount: list?.children.length ?? 0,
    items,
  };
})()`;

const SELECTION_STATE_EXPRESSION = `(() => {
  const doc = document.getElementById("standard")?.contentDocument ?? null;
  const list = doc?.getElementById("listSearchResults") ?? null;
  const selected = list === null ? [] : Array.from(list.children).filter((item) =>
    item.classList.contains("selected")
  );
  const item = selected[0] ?? null;
  const link = item?.querySelector("a") ?? null;
  return {
    selectedCount: selected.length,
    selectedIndex: item === null || list === null ? -1 : Array.from(list.children).indexOf(item),
    text: link?.textContent?.trim() ?? null,
    href: link?.getAttribute("href") ?? null,
  };
})()`;

Deno.test({
  name: "opt-in real Arch paired release and local/global workflow",
  ignore: Deno.env.get("ZIG_MANAGER_E2E") !== "1",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    assertCondition(
      Deno.build.os === "linux" && Deno.build.arch === "x86_64",
      "the real release gate requires Linux x86_64",
    );
    const archRelease = await Deno.stat("/etc/arch-release").catch(() => null);
    assertCondition(archRelease?.isFile, "the real release gate requires Arch Linux");

    const configuredSandbox = Deno.env.get("ZIG_MANAGER_E2E_SANDBOX");
    const resume = configuredSandbox !== undefined;
    const sandbox = configuredSandbox ??
      await Deno.makeTempDir({ prefix: "zig-manager-arch-e2e-" });
    if (resume) {
      const info = await Deno.lstat(sandbox);
      assertCondition(info.isDirectory && !info.isSymlink, "resume sandbox must be a directory");
      assertCondition(
        await Deno.realPath(sandbox) === sandbox,
        "resume sandbox must be an absolute normalized physical path",
      );
    }
    const keep = resume || Deno.env.get("ZIG_MANAGER_E2E_KEEP") === "1";
    try {
      await runArchReleaseGate(sandbox, resume);
    } catch (cause) {
      await logE2e(`failed; sandbox: ${sandbox}\n${errorMessage(cause)}\n`);
      throw cause;
    } finally {
      if (keep) {
        await logE2e(`preserved sandbox: ${sandbox}\n`);
      } else {
        await removeIfPresent(sandbox);
      }
    }
  },
});

interface E2eProcessResult {
  readonly success: boolean;
  readonly code: number;
  readonly signal: Deno.Signal | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface E2eProcessOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly inheritStderr?: boolean;
}

interface E2eComponentResult {
  readonly component: "zig" | "zls";
  readonly installationId: string;
  readonly version: string;
  readonly commit: string;
  readonly executable: string;
  readonly reused: boolean;
}

interface E2eInstallResult {
  readonly installationId: string;
  readonly version: string;
  readonly commit: string;
  readonly executable: string;
  readonly reused: boolean;
  readonly profileId: string;
  readonly zig: E2eComponentResult;
  readonly zls: E2eComponentResult;
}

interface E2eUseResult extends E2eInstallResult {
  readonly selection: "local" | "global";
  readonly scopeRoot: string | null;
  readonly pinPath: string;
}

async function runArchReleaseGate(sandbox: string, resume: boolean): Promise<void> {
  const packageRoot = fromFileUrl(new URL("../", import.meta.url));
  const localCli = fromFileUrl(new URL("../src/cli.ts", import.meta.url));
  const managerHome = join(sandbox, "manager-home");
  const installRoot = join(sandbox, "deno install");
  const projectRoot = join(sandbox, "project root");
  const childRoot = join(projectRoot, "nested child");
  const outsideRoot = join(sandbox, "outside");
  const fallbackBin = join(sandbox, "fallback bin");
  const fallbackZig = join(fallbackBin, "zig");
  const fallbackZls = join(fallbackBin, "zls");
  const zm = join(installRoot, "bin", "zm");
  const persistentZig = join(installRoot, "bin", "zig");
  const persistentZls = join(installRoot, "bin", "zls");
  const shimZig = join(managerHome, "data", "shims", "zig");
  for (const path of [managerHome, projectRoot, childRoot, outsideRoot, fallbackBin]) {
    await Deno.mkdir(path, { recursive: true });
  }
  await Deno.writeTextFile(
    fallbackZig,
    `#!/bin/sh\nif [ "\${1-}" = version ]; then\n  printf '%s\\n' '${FALLBACK_ZIG_VERSION}'\n  exit 0\nfi\nprintf 'fake fallback zig only supports version\\n' >&2\nexit 64\n`,
    { mode: 0o755 },
  );
  await Deno.chmod(fallbackZig, 0o755);
  await Deno.writeTextFile(
    fallbackZls,
    `#!/bin/sh\nif [ "\${1-}" = --version ]; then\n  printf '%s\\n' '${FALLBACK_ZLS_VERSION}'\n  exit 0\nfi\nprintf 'fake fallback zls only supports --version\\n' >&2\nexit 64\n`,
    { mode: 0o755 },
  );
  await Deno.chmod(fallbackZls, 0o755);

  const env = isolatedE2eEnvironment(managerHome, installRoot, fallbackBin);

  // 1-2. Install a local non-compiled Deno launcher and execute it by name.
  if (!resume || !(await isExecutableFile(zm))) {
    const install = await runProcess(
      Deno.execPath(),
      [
        "install",
        "--global",
        "--name",
        "zm",
        "--allow-env",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        "--allow-sys",
        "--config",
        join(packageRoot, "deno.json"),
        localCli,
      ],
      { cwd: packageRoot, env },
    );
    assertProcessSuccess(install, "install the isolated zm launcher");
  }
  const launcher = await Deno.readTextFile(zm);
  assertCondition(launcher.startsWith("#!"), "the installed zm launcher is not a script");
  assertCondition(
    launcher.includes("deno") && launcher.includes("run"),
    "zm is not a Deno launcher",
  );
  assertCondition(!launcher.includes("--compile"), "zm launcher unexpectedly uses compilation");
  const help = await runProcess("zm", ["help"], { cwd: projectRoot, env });
  assertProcessSuccess(help, "run the installed zm launcher");
  assertCondition(help.stdout.includes("paired Zig and ZLS"), "installed zm help is unexpected");

  // 3. Activation is applied only by evaluating generated Bash output.
  const activation = await runBash(
    `set -euo pipefail
eval "$("$ZM" shell activate bash)"
cd "$OUTSIDE"
printf 'active=%s\n' "$ZM_SESSION_ACTIVE"
printf 'version=%s\n' "$(zig version)"
`,
    outsideRoot,
    { ...env, ZM: zm, OUTSIDE: outsideRoot },
  );
  assertProcessSuccess(activation, "activate the initial Bash session");
  const activationValues = parseKeyValues(activation.stdout);
  assertCondition(activationValues.active === "1", "Bash activation did not mark the session");
  assertCondition(
    activationValues.version === FALLBACK_ZIG_VERSION,
    "activation changed Zig outside every pin",
  );

  // 4-6. Build a compatible stable pair and pin only the temporary project root.
  const initialStarted = performance.now();
  const initial = parseUseResult(
    await runZmSuccess(
      zm,
      ["use", COMPATIBLE_RELEASE_SELECTOR, "--path", projectRoot, "--json"],
      {
        cwd: projectRoot,
        env,
        inheritStderr: true,
      },
    ),
  );
  const initialBuildMs = performance.now() - initialStarted;
  if (!resume) {
    assertCondition(
      !initial.reused,
      "isolated compatible release unexpectedly reused an existing installation",
    );
  }
  assertCondition(/^[0-9a-f]{40}$/.test(initial.commit), "release did not resolve an exact commit");
  assertCondition(await isExecutableFile(initial.executable), "release executable is not runnable");
  assertCondition(await isExecutableFile(initial.zls.executable), "release ZLS is not runnable");
  assertCondition(await isExecutableFile(persistentZig), "persistent Zig resolver is absent");
  assertCondition(await isExecutableFile(persistentZls), "persistent ZLS resolver is absent");
  const initialAdapter = await installAdapterId(managerHome, initial.installationId);
  assertCondition(
    initialAdapter === "zig-cmake-llvm21-autodoc-v1",
    `compatible release selected unexpected adapter ${initialAdapter}`,
  );
  await logE2e(
    `release commit=${initial.commit} adapter=${initialAdapter} installation=${initial.installationId}\n`,
  );

  const verified = await runZmSuccess(
    zm,
    ["doctor", "--verify", "--path", projectRoot, "--json"],
    { cwd: projectRoot, env, inheritStderr: true },
  );
  assertCondition(verified.mode === "pin" && verified.ok === true, "paired doctor did not pass");
  const verification = requiredObject(verified.verification, "paired doctor verification");
  assertCondition(
    verification.level === "full-install" && verification.ok === true &&
      verification.compilesAndRuns === true,
    "paired doctor omitted full Zig/ZLS verification",
  );
  const verificationDetails = requiredObject(verification.details, "paired doctor details");
  assertCondition(
    verificationDetails.profileId === initial.profileId &&
      verificationDetails.zigInstallationId === initial.zig.installationId &&
      verificationDetails.zlsInstallationId === initial.zls.installationId,
    "paired doctor verified unexpected component identities",
  );

  // 7-10. Activated and ordinary shells switch by directory through persistent pair resolvers.
  const activated = await activatedDirectoryProbe(zm, env, projectRoot, childRoot, outsideRoot);
  assertCondition(activated.root === initial.version, "managed Zig is not active at the pin root");
  assertCondition(
    activated.child === initial.version,
    "managed Zig is not inherited below the pin",
  );
  assertCondition(
    activated.outside === FALLBACK_ZIG_VERSION,
    "the activated shell did not restore fallback Zig outside the pin",
  );
  const outsideStatus = await runZmSuccess(
    zm,
    ["current", "--path", outsideRoot, "--json"],
    { cwd: outsideRoot, env },
  );
  assertCondition(outsideStatus.mode === "fallback", "outside current mode is not fallback");
  assertCondition(
    outsideStatus.executable === fallbackZig,
    "outside fallback does not preserve the exact pre-activation Zig path",
  );

  const unactivated = await runBash(
    `set -euo pipefail
cd "$ROOT"
printf 'path=%s\n' "$(command -v zig)"
printf 'version=%s\n' "$(zig version)"
`,
    projectRoot,
    { ...env, ROOT: projectRoot },
  );
  assertProcessSuccess(unactivated, "probe an unactivated shell inside the pin");
  const unactivatedValues = parseKeyValues(unactivated.stdout);
  assertCondition(
    unactivatedValues.path === persistentZig,
    "persistent Zig resolver is not on PATH",
  );
  assertCondition(
    unactivatedValues.version === initial.version,
    "unactivated shell did not use managed Zig",
  );

  const global = parseUseResult(
    await runZmSuccess(zm, ["use", "--installed", initial.profileId, "--global", "--json"], {
      cwd: outsideRoot,
      env,
    }),
  );
  assertCondition(
    global.selection === "global" && global.scopeRoot === null,
    "global use was local",
  );
  const freshGlobal = await runBash(
    `set -euo pipefail
cd "$OUTSIDE"
printf 'zig_path=%s\n' "$(command -v zig)"
printf 'zig=%s\n' "$(zig version)"
printf 'zls_path=%s\n' "$(command -v zls)"
printf 'zls=%s\n' "$(zls --version)"
`,
    outsideRoot,
    { ...env, OUTSIDE: outsideRoot },
  );
  assertProcessSuccess(freshGlobal, "probe global pair in an ordinary shell");
  const globalValues = parseKeyValues(freshGlobal.stdout);
  assertCondition(globalValues.zig_path === persistentZig, "global Zig did not use its resolver");
  assertCondition(globalValues.zig === initial.version, "global Zig version is wrong");
  assertCondition(globalValues.zls_path === persistentZls, "global ZLS did not use its resolver");
  assertCondition(globalValues.zls === initial.zls.version, "global ZLS version is wrong");
  await runZmSuccess(zm, ["unuse", "--global", "--json"], { cwd: outsideRoot, env });
  const restoredFallback = await runBash(
    `set -euo pipefail
cd "$OUTSIDE"
printf 'zig=%s\n' "$(zig version)"
printf 'zls=%s\n' "$(zls --version)"
`,
    outsideRoot,
    { ...env, OUTSIDE: outsideRoot },
  );
  assertProcessSuccess(restoredFallback, "restore external Zig and ZLS after global unuse");
  const restoredValues = parseKeyValues(restoredFallback.stdout);
  assertCondition(restoredValues.zig === FALLBACK_ZIG_VERSION, "external Zig was not restored");
  assertCondition(restoredValues.zls === FALLBACK_ZLS_VERSION, "external ZLS was not restored");
  const future = await activatedDirectoryProbe(zm, env, projectRoot, childRoot, outsideRoot);
  assertCondition(
    future.root === initial.version,
    "a future activated shell lost the persistent pin",
  );

  // 11. Compile and run a real program through the directory-aware resolver.
  const source = join(projectRoot, "hello-e2e.zig");
  const program = join(projectRoot, "hello-e2e");
  await Deno.writeTextFile(source, "pub fn main() void {}\n");
  const compile = await runBash(
    `set -euo pipefail
eval "$("$ZM" shell activate bash)"
cd "$ROOT"
zig build-exe "$SOURCE" "-femit-bin=$PROGRAM"
"$PROGRAM"
printf 'compiled=ok\n'
`,
    projectRoot,
    { ...env, ZM: zm, ROOT: projectRoot, SOURCE: source, PROGRAM: program },
  );
  assertProcessSuccess(compile, "compile and run through the managed resolver");
  assertCondition(parseKeyValues(compile.stdout).compiled === "ok", "managed program did not run");

  // Measure resolver overhead against the same compiler invoked directly.
  const resolverEnv = {
    ...env,
    PATH: `${join(managerHome, "data", "shims")}:${env.PATH}`,
    ZM_SESSION_ACTIVE: "1",
    ZM_BASE_PATH: env.PATH,
    ZM_DATA_DIR: join(managerHome, "data"),
    ZM_SHIM_DIR: join(managerHome, "data", "shims"),
    ZM_PROFILES_DIR: join(managerHome, "data", "profiles"),
  };
  await runVersionOnce(shimZig, projectRoot, resolverEnv);
  await runVersionOnce(initial.executable, projectRoot, env);
  const resolverAverageMs = await benchmarkVersion(shimZig, projectRoot, resolverEnv);
  const directAverageMs = await benchmarkVersion(initial.executable, projectRoot, env);

  // 12. A second exact release observation must resolve to the same recipe and skip the build.
  const reuseStarted = performance.now();
  const reused = parseUseResult(
    await runZmSuccess(
      zm,
      ["use", COMPATIBLE_RELEASE_SELECTOR, "--path", projectRoot, "--json"],
      {
        cwd: projectRoot,
        env,
        inheritStderr: true,
      },
    ),
  );
  const reuseMs = performance.now() - reuseStarted;
  assertCondition(reused.reused, "unchanged release did not reuse its exact recipe");
  assertCondition(
    reused.commit === initial.commit,
    "exact release resolved a different commit",
  );
  assertCondition(
    reused.installationId === initial.installationId && reused.profileId === initial.profileId,
    "unchanged release produced a different install or profile",
  );

  // 13. Build a second exact Zig once, then publish it to a nested scope without rebuilding.
  const secondSelector = `commit:${initial.commit}`;
  const secondStarted = performance.now();
  const second = parseInstallResult(
    await runZmSuccess(
      zm,
      ["install", secondSelector, "--profile", SECOND_BUILD_PROFILE, "--json"],
      {
        cwd: projectRoot,
        env,
        inheritStderr: true,
      },
    ),
  );
  const secondBuildMs = performance.now() - secondStarted;
  assertCondition(
    second.installationId !== initial.installationId,
    "the second selector did not produce a distinct Zig installation",
  );
  const nested = parseUseResult(
    await runZmSuccess(
      zm,
      ["use", "--installed", second.installationId, "--path", childRoot, "--json"],
      { cwd: childRoot, env, inheritStderr: true },
    ),
  );
  assertCondition(nested.reused, "nested use --installed unexpectedly rebuilt Zig");
  const rootStatus = await runZmSuccess(
    zm,
    ["current", "--path", projectRoot, "--json"],
    { cwd: projectRoot, env },
  );
  const childStatus = await runZmSuccess(
    zm,
    ["current", "--path", childRoot, "--json"],
    { cwd: childRoot, env },
  );
  assertCondition(
    rootStatus.installationId === initial.installationId,
    "nested publication changed the parent pin",
  );
  assertCondition(
    childStatus.installationId === second.installationId,
    "the nearest nested pin did not win",
  );

  const distinctGlobal = parseUseResult(
    await runZmSuccess(zm, ["use", "--installed", second.profileId, "--global", "--json"], {
      cwd: outsideRoot,
      env,
    }),
  );
  assertCondition(
    distinctGlobal.selection === "global" && distinctGlobal.profileId === second.profileId,
    "the second profile was not selected globally",
  );
  const parentWithGlobal = await runZmSuccess(
    zm,
    ["current", "--path", projectRoot, "--json"],
    { cwd: projectRoot, env },
  );
  const nestedWithGlobal = await runZmSuccess(
    zm,
    ["current", "--path", childRoot, "--json"],
    { cwd: childRoot, env },
  );
  const outsideWithGlobal = await runZmSuccess(
    zm,
    ["current", "--path", outsideRoot, "--json"],
    { cwd: outsideRoot, env },
  );
  assertCondition(
    parentWithGlobal.selection === "local" && parentWithGlobal.profileId === initial.profileId,
    "the global profile overrode the parent local profile",
  );
  assertCondition(
    nestedWithGlobal.selection === "local" && nestedWithGlobal.profileId === second.profileId,
    "the nested local profile did not retain precedence",
  );
  assertCondition(
    outsideWithGlobal.selection === "global" && outsideWithGlobal.profileId === second.profileId,
    "the distinct global profile did not win outside local scopes",
  );
  const outsideZig = requiredObject(outsideWithGlobal.zig, "outside global Zig");
  const outsideZls = requiredObject(outsideWithGlobal.zls, "outside global ZLS");
  assertCondition(
    outsideZig.installationId === second.zig.installationId &&
      outsideZls.installationId === second.zls.installationId,
    "global resolution mixed components from different profiles",
  );
  await runZmSuccess(zm, ["unuse", "--global", "--json"], { cwd: outsideRoot, env });
  const secondAdapter = await installAdapterId(managerHome, second.installationId);
  await logE2e(
    `second commit=${second.commit} adapter=${secondAdapter} installation=${second.installationId}\n`,
  );

  const storage = {
    sources: await directoryBytes(join(managerHome, "cache", "sources")),
    builds: await directoryBytes(join(managerHome, "cache", "builds")),
    logs: await directoryBytes(join(managerHome, "cache", "logs")),
    installs: await directoryBytes(join(managerHome, "data", "installs")),
    profiles: await directoryBytes(join(managerHome, "data", "profiles")),
  };

  // 14. Hide make in an isolated PATH and verify real Arch diagnostics block pre-configure.
  const parentPin = join(projectRoot, ".zig-manager", "toolchain");
  const pinBeforeFailure = await Deno.readTextFile(parentPin);
  const buildsBeforeFailure = await relativeTree(join(managerHome, "cache", "builds"));
  const restrictedPath = join(sandbox, "restricted tool path");
  if (!resume) {
    await Deno.mkdir(restrictedPath);
    for (
      const [name, target] of [
        ["deno", Deno.execPath()],
        ["git", "/usr/bin/git"],
        ["cmake", "/usr/bin/cmake"],
      ] as const
    ) {
      await Deno.symlink(target, join(restrictedPath, name));
    }
  }
  const failed = await runZmFailure(
    zm,
    ["use", COMPATIBLE_RELEASE_SELECTOR, "--path", projectRoot, "--json"],
    {
      cwd: projectRoot,
      env: {
        ...env,
        PATH: restrictedPath,
        ZIG_MANAGER_BUILD_GENERATOR: "Unix Makefiles",
      },
    },
  );
  assertCondition(
    failed.code === "ZIG_BUILD_PREREQUISITE_MISSING",
    `missing make returned unexpected error ${String(failed.code)}`,
  );
  const failedDetails = requiredObject(failed.details, "failed use details");
  const findings = failedDetails.findings;
  assertCondition(Array.isArray(findings), "failed use omitted prerequisite findings");
  const generatorFinding = findings.map((item) => asObject(item)).find((item) =>
    item?.code === "ZIG_GENERATOR_UNAVAILABLE"
  );
  assertCondition(
    generatorFinding !== undefined && generatorFinding !== null,
    "missing make did not report its generator error",
  );
  assertCondition(
    typeof generatorFinding.remediation === "string" && generatorFinding.remediation.length > 0,
    "missing make diagnostic is not actionable",
  );
  const packageHints = generatorFinding.packageHints;
  assertCondition(Array.isArray(packageHints), "generator package hints are absent");
  const makeHint = packageHints.map((item) => asObject(item)).find((item) =>
    item?.manager === "pacman" && item.name === "make" && item.verified === true
  );
  assertCondition(makeHint !== undefined, "real pacman metadata did not verify the make package");
  assertCondition(
    await Deno.readTextFile(parentPin) === pinBeforeFailure,
    "prerequisite failure changed the old parent pin",
  );
  assertCondition(
    JSON.stringify(await relativeTree(join(managerHome, "cache", "builds"))) ===
      JSON.stringify(buildsBeforeFailure),
    "prerequisite failure created or changed build paths before configure",
  );
  const afterFailure = await activatedDirectoryProbe(
    zm,
    env,
    projectRoot,
    childRoot,
    outsideRoot,
  );
  assertCondition(afterFailure.root === initial.version, "failure changed the parent managed Zig");
  assertCondition(afterFailure.child === second.version, "failure changed the nested managed Zig");
  assertCondition(
    afterFailure.outside === FALLBACK_ZIG_VERSION,
    "failure changed fallback Zig outside the pins",
  );

  // 15. Source, build, and log caches are replaceable; immutable installs remain runnable.
  for (const name of ["sources", "builds", "logs"]) {
    await removeIfPresent(join(managerHome, "cache", name));
  }
  const afterCacheDeletion = await activatedDirectoryProbe(
    zm,
    env,
    projectRoot,
    childRoot,
    outsideRoot,
  );
  assertCondition(
    afterCacheDeletion.root === initial.version && afterCacheDeletion.child === second.version,
    "cache deletion broke a pinned immutable Zig",
  );
  assertCondition(
    afterCacheDeletion.outside === FALLBACK_ZIG_VERSION,
    "cache deletion changed fallback behavior",
  );

  await logE2e(`${
    JSON.stringify({
      initial: {
        resumed: resume,
        selector: COMPATIBLE_RELEASE_SELECTOR,
        commit: initial.commit,
        adapter: initialAdapter,
        installationId: initial.installationId,
        buildMs: Math.round(initialBuildMs),
        reuseMs: Math.round(reuseMs),
      },
      second: {
        selector: secondSelector,
        profile: SECOND_BUILD_PROFILE,
        commit: second.commit,
        adapter: secondAdapter,
        installationId: second.installationId,
        buildMs: Math.round(secondBuildMs),
      },
      resolver: {
        runs: RESOLVER_BENCHMARK_RUNS,
        resolverAverageMs,
        directAverageMs,
        estimatedOverheadMs: resolverAverageMs - directAverageMs,
      },
      storageBytes: storage,
      archDiagnosticPackage: makeHint,
    })
  }\n`);
}

function isolatedE2eEnvironment(
  managerHome: string,
  installRoot: string,
  fallbackBin: string,
): Record<string, string> {
  const env = Deno.env.toObject();
  for (const key of Object.keys(env)) {
    if (key.startsWith("ZIG_MANAGER_") || key.startsWith("ZM_")) delete env[key];
  }
  const originalPath = env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/bin";
  env.ZIG_MANAGER_HOME = managerHome;
  env.DENO_INSTALL_ROOT = installRoot;
  env.DENO_NO_UPDATE_CHECK = "1";
  env.NO_COLOR = "1";
  env.PATH = `${join(installRoot, "bin")}:${fallbackBin}:${originalPath}`;
  return env;
}

async function activatedDirectoryProbe(
  zm: string,
  env: Readonly<Record<string, string>>,
  projectRoot: string,
  childRoot: string,
  outsideRoot: string,
): Promise<Readonly<Record<"root" | "child" | "outside", string>>> {
  const output = await runBash(
    `set -euo pipefail
eval "$("$ZM" shell activate bash)"
cd "$ROOT"
printf 'root=%s\n' "$(zig version)"
cd "$CHILD"
printf 'child=%s\n' "$(zig version)"
cd "$OUTSIDE"
printf 'outside=%s\n' "$(zig version)"
`,
    projectRoot,
    { ...env, ZM: zm, ROOT: projectRoot, CHILD: childRoot, OUTSIDE: outsideRoot },
  );
  assertProcessSuccess(output, "probe activated directory behavior");
  const values = parseKeyValues(output.stdout);
  assertCondition(values.root !== undefined, "activated probe omitted root version");
  assertCondition(values.child !== undefined, "activated probe omitted child version");
  assertCondition(values.outside !== undefined, "activated probe omitted outside version");
  return { root: values.root, child: values.child, outside: values.outside };
}

async function runZmSuccess(
  zm: string,
  args: readonly string[],
  options: E2eProcessOptions,
): Promise<JsonObject> {
  const result = await runProcess(zm, args, options);
  assertProcessSuccess(result, `zm ${args.join(" ")}`);
  const document = parseCliDocument(result.stdout);
  return requiredObject(document.result, "CLI success result");
}

async function runZmFailure(
  zm: string,
  args: readonly string[],
  options: E2eProcessOptions,
): Promise<JsonObject> {
  const result = await runProcess(zm, args, options);
  assertCondition(!result.success, `zm ${args.join(" ")} unexpectedly succeeded`);
  const document = parseCliDocument(result.stdout);
  return requiredObject(document.error, "CLI error result");
}

function parseCliDocument(stdout: string): JsonObject {
  const text = stdout.trim();
  assertCondition(text.length > 0, "CLI emitted no JSON document");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new Error(`CLI emitted invalid JSON: ${errorMessage(cause)}\n${text}`);
  }
  return requiredObject(value, "CLI document");
}

function parseInstallResult(value: JsonObject): E2eInstallResult {
  const installationId = requiredString(value.installationId, "installationId");
  assertCondition(/^[0-9a-f]{64}$/.test(installationId), "installationId is not SHA-256");
  const commit = requiredString(value.commit, "commit");
  assertCondition(/^[0-9a-f]{40}$/.test(commit), "commit is not a canonical object ID");
  const zig = parseComponentResult(requiredObject(value.zig, "zig"), "zig");
  const zls = parseComponentResult(requiredObject(value.zls, "zls"), "zls");
  const result = {
    installationId,
    version: requiredString(value.version, "version"),
    commit,
    executable: requiredString(value.executable, "executable"),
    reused: requiredBoolean(value.reused, "reused"),
    profileId: requiredString(value.profileId, "profileId"),
    zig,
    zls,
  };
  assertCondition(result.installationId === zig.installationId, "top-level Zig ID alias changed");
  assertCondition(result.version === zig.version, "top-level Zig version alias changed");
  assertCondition(result.commit === zig.commit, "top-level Zig commit alias changed");
  assertCondition(result.executable === zig.executable, "top-level Zig executable alias changed");
  return result;
}

function parseUseResult(value: JsonObject): E2eUseResult {
  const scopeRoot = value.scopeRoot;
  assertCondition(scopeRoot === null || typeof scopeRoot === "string", "scopeRoot is invalid");
  const selection = requiredString(value.selection, "selection");
  assertCondition(selection === "local" || selection === "global", "selection is invalid");
  return {
    ...parseInstallResult(value),
    selection,
    scopeRoot,
    pinPath: requiredString(value.pinPath, "pinPath"),
  };
}

function parseComponentResult(
  value: JsonObject,
  expected: "zig" | "zls",
): E2eComponentResult {
  const component = requiredString(value.component, `${expected}.component`);
  assertCondition(component === expected, `${expected}.component is wrong`);
  const installationId = requiredString(value.installationId, `${expected}.installationId`);
  assertCondition(/^[0-9a-f]{64}$/.test(installationId), `${expected} ID is not SHA-256`);
  const commit = requiredString(value.commit, `${expected}.commit`);
  assertCondition(/^[0-9a-f]{40}$/.test(commit), `${expected} commit is not canonical`);
  return {
    component,
    installationId,
    version: requiredString(value.version, `${expected}.version`),
    commit,
    executable: requiredString(value.executable, `${expected}.executable`),
    reused: requiredBoolean(value.reused, `${expected}.reused`),
  };
}

async function installAdapterId(managerHome: string, installationId: string): Promise<string> {
  const manifestPath = join(
    managerHome,
    "data",
    "installs",
    "zig",
    installationId,
    "install-manifest.json",
  );
  const manifest = parseCliDocument(await Deno.readTextFile(manifestPath));
  const identity = requiredObject(manifest.identity, "install identity");
  const adapter = requiredObject(identity.adapter, "install adapter");
  return requiredString(adapter.id, "install adapter ID");
}

async function runBash(
  script: string,
  cwd: string,
  env: Readonly<Record<string, string>>,
): Promise<E2eProcessResult> {
  return await runProcess("/usr/bin/bash", ["--noprofile", "--norc", "-c", script], {
    cwd,
    env,
  });
}

async function runProcess(
  executable: string,
  args: readonly string[],
  options: E2eProcessOptions,
): Promise<E2eProcessResult> {
  const process = new Deno.Command(executable, {
    args: [...args],
    cwd: options.cwd,
    env: { ...options.env },
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: options.inheritStderr ? "inherit" : "piped",
  }).spawn();
  const stdout = new Response(process.stdout).text();
  const stderr = options.inheritStderr ? Promise.resolve("") : new Response(process.stderr).text();
  const [status, stdoutText, stderrText] = await Promise.all([process.status, stdout, stderr]);
  return { ...status, stdout: stdoutText, stderr: stderrText };
}

function assertProcessSuccess(result: E2eProcessResult, operation: string): void {
  assertCondition(
    result.success,
    `${operation} failed with ${
      result.signal ?? result.code
    }\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function parseKeyValues(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.trim().split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator > 0) result[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return result;
}

function requiredObject(value: unknown, label: string): JsonObject {
  const result = asObject(value);
  assertCondition(result !== null, `${label} must be an object`);
  return result;
}

function requiredString(value: unknown, label: string): string {
  assertCondition(typeof value === "string" && value.length > 0, `${label} must be text`);
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  assertCondition(typeof value === "boolean", `${label} must be boolean`);
  return value;
}

async function isExecutableFile(path: string): Promise<boolean> {
  const info = await Deno.stat(path).catch(() => null);
  return info?.isFile === true && (info.mode === null || (info.mode & 0o111) !== 0);
}

async function runVersionOnce(
  executable: string,
  cwd: string,
  env: Readonly<Record<string, string>>,
): Promise<void> {
  const result = await new Deno.Command(executable, {
    args: ["version"],
    cwd,
    env: { ...env },
    clearEnv: true,
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).output();
  assertCondition(result.success, `${executable} version failed during resolver benchmark`);
}

async function benchmarkVersion(
  executable: string,
  cwd: string,
  env: Readonly<Record<string, string>>,
): Promise<number> {
  const started = performance.now();
  for (let index = 0; index < RESOLVER_BENCHMARK_RUNS; index++) {
    await runVersionOnce(executable, cwd, env);
  }
  return (performance.now() - started) / RESOLVER_BENCHMARK_RUNS;
}

async function directoryBytes(path: string): Promise<number> {
  const info = await Deno.lstat(path).catch((cause) => {
    if (cause instanceof Deno.errors.NotFound) return null;
    throw cause;
  });
  if (info === null) return 0;
  if (!info.isDirectory) return info.size;
  let total = 0;
  for await (const entry of Deno.readDir(path)) {
    total += await directoryBytes(join(path, entry.name));
  }
  return total;
}

async function relativeTree(root: string): Promise<string[]> {
  const result: string[] = [];
  await appendRelativeTree(root, "", result);
  return result.sort();
}

async function appendRelativeTree(root: string, relative: string, result: string[]): Promise<void> {
  const path = relative.length === 0 ? root : join(root, relative);
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const entry of Deno.readDir(path)) entries.push(entry);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return;
    throw cause;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const child = relative.length === 0 ? entry.name : join(relative, entry.name);
    result.push(`${entry.isDirectory ? "d" : entry.isSymlink ? "l" : "f"}:${child}`);
    if (entry.isDirectory) await appendRelativeTree(root, child, result);
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound)) throw cause;
  }
}

async function logE2e(text: string): Promise<void> {
  const bytes = new TextEncoder().encode(`[zig-manager e2e] ${text}`);
  let offset = 0;
  while (offset < bytes.length) offset += await Deno.stderr.write(bytes.subarray(offset));
}

// The separate opt-in invocation requires --allow-net=127.0.0.1 for CDP.
Deno.test({
  name: "opt-in real CDP browser integration for a generated mega document",
  ignore: Deno.env.get("ZIG_MANAGER_BROWSER_E2E") !== "1",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const browser = Deno.env.get("ZIG_MANAGER_E2E_BROWSER");
    const megaPath = Deno.env.get("ZIG_MANAGER_E2E_MEGA_PATH");
    if (!browser) {
      throw new Error("ZIG_MANAGER_E2E_BROWSER is required for browser E2E");
    }
    if (!megaPath) {
      throw new Error("ZIG_MANAGER_E2E_MEGA_PATH is required for browser E2E");
    }
    await runBrowserIntegration(browser, megaPath);
  },
});

async function runBrowserIntegration(browser: string, megaPath: string): Promise<void> {
  const resolvedMegaPath = await Deno.realPath(megaPath);
  const megaFile = await Deno.stat(resolvedMegaPath);
  assertCondition(megaFile.isFile, `Mega document is not a file: ${resolvedMegaPath}`);

  const profile = await Deno.makeTempDir({ prefix: "zig-manager-browser-e2e-" });
  const failures: unknown[] = [];
  const processState: BrowserProcessState = {};
  let child: Deno.ChildProcess | undefined;
  let statusPromise: Promise<Deno.CommandStatus> | undefined;
  let stderrPromise: Promise<string> | undefined;
  let client: CdpClient | undefined;
  let diagnostics: PageDiagnostics | undefined;
  let stderr = "";

  try {
    child = new Deno.Command(browser, {
      args: [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--allow-file-access-from-files",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      stdin: "null",
      stdout: "null",
      stderr: "piped",
    }).spawn();
    statusPromise = child.status;
    stderrPromise = new Response(child.stderr).text();
    void statusPromise.then(
      (status) => {
        processState.status = status;
      },
      (error) => {
        processState.statusError = error;
      },
    );

    const port = await waitForDevToolsPort(profile, processState);
    const websocketUrl = await waitForPageTarget(port, processState);
    client = await CdpClient.connect(websocketUrl, STARTUP_TIMEOUT_MS);
    diagnostics = observePage(client, processState);

    await Promise.all([
      client.send("Page.enable"),
      client.send("Runtime.enable"),
      client.send("Network.enable"),
    ]);
    diagnostics.assertHealthy();

    const megaUrl = toFileUrl(resolvedMegaPath);
    await navigateAndWaitForLoad(client, diagnostics, megaUrl);

    const initialView = await waitForEvaluation<ViewState>(
      client,
      diagnostics,
      "initial Language Reference view",
      INTERACTION_TIMEOUT_MS,
      VIEW_STATE_EXPRESSION,
      (state) => viewMatches(state, "language"),
    );
    assertViewState(initialView, "language");

    const autodoc = await waitForEvaluation<AutodocState>(
      client,
      diagnostics,
      "embedded standard-library autodoc runtime",
      AUTODOC_TIMEOUT_MS,
      AUTODOC_STATE_EXPRESSION,
      (state) => {
        if (state.errorsVisible) {
          throw new Error(`Autodoc reported an error while loading: ${state.errors.trim()}`);
        }
        return state.ready;
      },
    );
    assertCondition(
      autodoc.searchPlaceholder !== null,
      `Autodoc search input is not usable: ${describe(autodoc)}`,
    );

    await clickTopLevelControl(client, diagnostics, "show-standard");
    const standardView = await waitForEvaluation<ViewState>(
      client,
      diagnostics,
      "Standard Library view",
      INTERACTION_TIMEOUT_MS,
      VIEW_STATE_EXPRESSION,
      (state) => viewMatches(state, "standard"),
    );
    assertViewState(standardView, "standard");

    const query = "ArrayList";
    await enterAutodocSearch(client, diagnostics, query);
    const search = await waitForEvaluation<SearchState>(
      client,
      diagnostics,
      `autodoc results for ${query}`,
      INTERACTION_TIMEOUT_MS,
      SEARCH_STATE_EXPRESSION,
      (state) =>
        state.query === query && state.resultsVisible && !state.noResultsVisible &&
        state.resultCount > 0 && state.title.includes(`${query} - Search`),
    );
    assertSearchResults(search, query);

    await pressAutodocArrowDown(client, diagnostics);
    const selection = await waitForEvaluation<SelectionState>(
      client,
      diagnostics,
      "autodoc keyboard result selection",
      INTERACTION_TIMEOUT_MS,
      SELECTION_STATE_EXPRESSION,
      (state) => state.selectedCount === 1 && state.selectedIndex === 0,
    );
    assertCondition(
      selection.text !== null && selection.text.length > 0 &&
        selection.href?.startsWith("#") === true,
      `Autodoc selected an invalid search result: ${describe(selection)}`,
    );

    await clickTopLevelControl(client, diagnostics, "show-language");
    const finalView = await waitForEvaluation<ViewState>(
      client,
      diagnostics,
      "restored Language Reference view",
      INTERACTION_TIMEOUT_MS,
      VIEW_STATE_EXPRESSION,
      (state) => viewMatches(state, "language"),
    );
    assertViewState(finalView, "language");

    await evaluate<boolean>(client, "true");
    diagnostics.assertHealthy();
  } catch (error) {
    failures.push(error);
  } finally {
    diagnostics?.dispose();
    if (child !== undefined && statusPromise !== undefined) {
      try {
        await shutdownBrowser(client, child, statusPromise, processState);
      } catch (error) {
        failures.push(error);
      }
    } else {
      client?.close();
    }
    if (stderrPromise !== undefined) {
      try {
        stderr = await withTimeout(stderrPromise, SHUTDOWN_TIMEOUT_MS, "browser stderr to close");
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await Deno.remove(profile, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) failures.push(error);
    }
  }

  if (failures.length === 0) return;
  const failure = failures.length === 1
    ? failures[0]
    : new AggregateError(failures, "Browser integration and cleanup failed");
  if (stderr.trim().length === 0) throw failure;
  const stderrTail = stderr.trim().slice(-4_000);
  throw new Error(`${errorMessage(failure)}\nBrowser stderr:\n${stderrTail}`, { cause: failure });
}

async function waitForDevToolsPort(
  profile: string,
  processState: BrowserProcessState,
): Promise<number> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  const activePortPath = `${profile}/DevToolsActivePort`;
  let lastValue = "file not created";
  while (Date.now() < deadline) {
    assertBrowserRunning(processState);
    try {
      const text = await Deno.readTextFile(activePortPath);
      const firstLine = text.split(/\r?\n/, 1)[0];
      const port = Number(firstLine);
      if (Number.isInteger(port) && port > 0 && port <= 65_535) return port;
      lastValue = `invalid contents ${describe(text)}`;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) lastValue = errorMessage(error);
    }
    await pollDelay(deadline);
  }
  assertBrowserRunning(processState);
  throw new Error(
    `Timed out after ${STARTUP_TIMEOUT_MS}ms waiting for Chromium DevToolsActivePort; ${lastValue}`,
  );
}

async function waitForPageTarget(
  port: number,
  processState: BrowserProcessState,
): Promise<string> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError = "CDP target endpoint not ready";
  while (Date.now() < deadline) {
    assertBrowserRunning(processState);
    try {
      const remaining = Math.max(1, Math.min(1_000, deadline - Date.now()));
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(remaining),
      });
      if (!response.ok) throw new Error(`CDP target endpoint returned HTTP ${response.status}`);
      const targets: unknown = await response.json();
      if (!Array.isArray(targets)) throw new Error("CDP target endpoint returned a non-array");
      const page = targets.map(asObject).find((target) =>
        target !== null && target.type === "page" &&
        typeof target.webSocketDebuggerUrl === "string"
      );
      if (page !== undefined && page !== null && typeof page.webSocketDebuggerUrl === "string") {
        const url = new URL(page.webSocketDebuggerUrl);
        assertCondition(url.protocol === "ws:", `Unexpected CDP WebSocket URL: ${url.href}`);
        url.hostname = "127.0.0.1";
        return url.href;
      }
      lastError = "no page target was available";
    } catch (error) {
      lastError = errorMessage(error);
    }
    await pollDelay(deadline);
  }
  assertBrowserRunning(processState);
  throw new Error(
    `Timed out after ${STARTUP_TIMEOUT_MS}ms waiting for a CDP page target; ${lastError}`,
  );
}

function observePage(client: CdpClient, processState: BrowserProcessState): PageDiagnostics {
  const externalRequests = new Set<string>();
  const runtimeErrors: string[] = [];
  const unsubscribe = [
    client.on("Network.requestWillBeSent", (params) => {
      const request = asObject(params.request);
      const url = request?.url;
      if (typeof url === "string" && /^https?:\/\//i.test(url)) {
        externalRequests.add(redactUrl(url));
      }
    }),
    client.on("Runtime.exceptionThrown", (params) => {
      runtimeErrors.push(formatRuntimeException(params));
    }),
    client.on("Runtime.consoleAPICalled", (params) => {
      if (params.type !== "error") return;
      const args = Array.isArray(params.args) ? params.args.map(formatRemoteObject) : [];
      runtimeErrors.push(`console.error: ${args.join(" ") || "(no arguments)"}`);
    }),
  ];
  return {
    assertHealthy: () => {
      assertBrowserRunning(processState);
      if (externalRequests.size > 0) {
        throw new Error(
          `Mega document made forbidden HTTP(S) request(s): ${[...externalRequests].join(", ")}`,
        );
      }
      if (runtimeErrors.length > 0) {
        throw new Error(`Mega document reported runtime error(s):\n${runtimeErrors.join("\n")}`);
      }
    },
    dispose: () => {
      for (const remove of unsubscribe) remove();
    },
  };
}

async function navigateAndWaitForLoad(
  client: CdpClient,
  diagnostics: PageDiagnostics,
  url: string,
): Promise<void> {
  let targetFrameNavigated = false;
  let resolveLoaded: (() => void) | undefined;
  const loaded = new Promise<void>((resolve) => {
    resolveLoaded = resolve;
  });
  const removeFrameListener = client.on("Page.frameNavigated", (params) => {
    const frame = asObject(params.frame);
    if (
      frame !== null && frame.parentId === undefined && typeof frame.url === "string" &&
      sameUrl(frame.url, url)
    ) {
      targetFrameNavigated = true;
    }
  });
  const removeLoadListener = client.on("Page.loadEventFired", () => {
    if (targetFrameNavigated) resolveLoaded?.();
  });
  try {
    const result = await client.send("Page.navigate", { url }, TOP_LEVEL_LOAD_TIMEOUT_MS);
    if (typeof result.errorText === "string" && result.errorText.length > 0) {
      throw new Error(`Chromium could not navigate to the mega document: ${result.errorText}`);
    }
    try {
      await withTimeout(loaded, TOP_LEVEL_LOAD_TIMEOUT_MS, "top-level mega document load");
    } catch (error) {
      diagnostics.assertHealthy();
      throw error;
    }
    diagnostics.assertHealthy();
  } finally {
    removeFrameListener();
    removeLoadListener();
  }
}

async function waitForEvaluation<T>(
  client: CdpClient,
  diagnostics: PageDiagnostics,
  description: string,
  timeoutMs: number,
  expression: string,
  ready: (value: T) => boolean,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;
  while (Date.now() < deadline) {
    diagnostics.assertHealthy();
    lastValue = await evaluate<T>(client, expression);
    diagnostics.assertHealthy();
    if (ready(lastValue)) return lastValue;
    await pollDelay(deadline);
  }
  diagnostics.assertHealthy();
  throw new Error(
    `Timed out after ${timeoutMs}ms waiting for ${description}; last state: ${describe(lastValue)}`,
  );
}

async function evaluate<T>(client: CdpClient, expression: string): Promise<T> {
  const response = await client.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails !== undefined) {
    throw new Error(
      `Runtime.evaluate failed: ${formatExceptionDetails(response.exceptionDetails)}`,
    );
  }
  const result = asObject(response.result);
  if (result === null || !("value" in result)) {
    throw new Error(`Runtime.evaluate returned no serializable value: ${describe(result)}`);
  }
  return result.value as T;
}

async function clickTopLevelControl(
  client: CdpClient,
  diagnostics: PageDiagnostics,
  id: "show-language" | "show-standard",
): Promise<void> {
  const clicked = await evaluate<boolean>(
    client,
    `(() => {
      const button = document.getElementById(${JSON.stringify(id)});
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`,
  );
  assertCondition(clicked, `Top-level control #${id} was not available`);
  diagnostics.assertHealthy();
}

async function enterAutodocSearch(
  client: CdpClient,
  diagnostics: PageDiagnostics,
  query: string,
): Promise<void> {
  const state = await evaluate<{ dispatched: boolean; focused: boolean; value: string | null }>(
    client,
    `(() => {
      const frame = document.getElementById("standard");
      const win = frame?.contentWindow ?? null;
      const doc = frame?.contentDocument ?? null;
      const input = doc?.getElementById("search") ?? null;
      if (win === null || input === null) {
        return { dispatched: false, focused: false, value: null };
      }
      input.focus();
      input.value = ${JSON.stringify(query)};
      input.dispatchEvent(new win.InputEvent("input", {
        bubbles: true,
        inputType: "insertText",
        data: ${JSON.stringify(query)},
      }));
      return { dispatched: true, focused: doc.activeElement === input, value: input.value };
    })()`,
  );
  assertCondition(
    state.dispatched && state.focused && state.value === query,
    `Could not interact with the official autodoc search input: ${describe(state)}`,
  );
  diagnostics.assertHealthy();
}

async function pressAutodocArrowDown(
  client: CdpClient,
  diagnostics: PageDiagnostics,
): Promise<void> {
  const dispatched = await evaluate<boolean>(
    client,
    `(() => {
      const frame = document.getElementById("standard");
      const win = frame?.contentWindow ?? null;
      const input = frame?.contentDocument?.getElementById("search") ?? null;
      if (win === null || input === null) return false;
      input.dispatchEvent(new win.KeyboardEvent("keydown", {
        key: "ArrowDown",
        code: "ArrowDown",
        bubbles: true,
        cancelable: true,
      }));
      return true;
    })()`,
  );
  assertCondition(dispatched, "Could not dispatch ArrowDown to the autodoc search input");
  diagnostics.assertHealthy();
}

function assertSearchResults(state: SearchState, query: string): void {
  const details = describe(state);
  assertCondition(state.query === query, `Autodoc search did not retain its query: ${details}`);
  assertCondition(state.resultsVisible, `Autodoc search results are not visible: ${details}`);
  assertCondition(!state.noResultsVisible, `Autodoc displayed its no-results UI: ${details}`);
  assertCondition(state.resultCount > 0, `Autodoc returned no search results: ${details}`);
  assertCondition(
    state.title.includes(`${query} - Search`),
    `Autodoc did not update its title for search: ${details}`,
  );
  assertCondition(
    state.items.length > 0 &&
      state.items.every((item) => item.text.length > 0 && item.href?.startsWith("#")),
    `Autodoc rendered invalid result links: ${details}`,
  );
  assertCondition(
    state.items.some((item) => item.text.toLowerCase().includes(query.toLowerCase())),
    `Autodoc results do not contain the search term: ${details}`,
  );
}

function viewMatches(state: ViewState, selected: "language" | "standard"): boolean {
  const language = selected === "language";
  return state.controlsReady && state.languagePressed === String(language) &&
    state.standardPressed === String(!language) && state.languageActive === language &&
    state.standardActive === !language && state.languageVisible === language &&
    state.standardVisible === !language;
}

function assertViewState(state: ViewState, selected: "language" | "standard"): void {
  assertCondition(
    viewMatches(state, selected),
    `Expected ${selected} iframe and ARIA state; received ${describe(state)}`,
  );
}

async function shutdownBrowser(
  client: CdpClient | undefined,
  child: Deno.ChildProcess,
  statusPromise: Promise<Deno.CommandStatus>,
  processState: BrowserProcessState,
): Promise<void> {
  let closeRequested = false;
  if (client?.isOpen) {
    try {
      await client.send("Browser.close", {}, 2_000);
      closeRequested = true;
    } catch {
      // Browser.close commonly closes the WebSocket before sending its response.
    }
  }
  client?.close();
  if (!closeRequested && processState.status === undefined) {
    try {
      child.kill();
    } catch {
      // A racing process exit is confirmed by awaiting status below.
    }
  }
  try {
    await withTimeout(statusPromise, SHUTDOWN_TIMEOUT_MS, "browser process to exit");
    return;
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // A racing process exit is confirmed by the final status wait.
    }
  }
  await withTimeout(statusPromise, SHUTDOWN_TIMEOUT_MS, "browser process to exit after SIGKILL");
}

function assertBrowserRunning(state: BrowserProcessState): void {
  if (state.statusError !== undefined) {
    throw new Error(`Could not observe browser process status: ${errorMessage(state.statusError)}`);
  }
  if (state.status !== undefined) {
    const signal = state.status.signal === null ? "" : `, signal ${state.status.signal}`;
    throw new Error(`Browser exited unexpectedly with code ${state.status.code}${signal}`);
  }
}

function formatRuntimeException(params: JsonObject): string {
  return `exception: ${formatExceptionDetails(params.exceptionDetails)}`;
}

function formatExceptionDetails(value: unknown): string {
  const details = asObject(value);
  if (details === null) return describe(value);
  const exception = asObject(details.exception);
  const description = exception?.description ?? exception?.value ?? details.text ??
    "unknown exception";
  const location = typeof details.url === "string"
    ? ` at ${details.url}:${Number(details.lineNumber ?? 0) + 1}:${
      Number(details.columnNumber ?? 0) + 1
    }`
    : "";
  return `${String(description)}${location}`;
}

function formatRemoteObject(value: unknown): string {
  const object = asObject(value);
  if (object === null) return describe(value);
  if ("value" in object) return describe(object.value);
  if (typeof object.unserializableValue === "string") return object.unserializableValue;
  if (typeof object.description === "string") return object.description;
  return String(object.type ?? "unknown");
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return "unparseable HTTP(S) URL";
  }
}

function sameUrl(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    leftUrl.hash = "";
    rightUrl.hash = "";
    return leftUrl.href === rightUrl.href;
  } catch {
    return left === right;
  }
}

function toFileUrl(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("//")) {
    const [host, ...parts] = normalized.slice(2).split("/");
    assertCondition(host.length > 0, `Invalid UNC path: ${path}`);
    return `file://${host}/${parts.map(encodeURIComponent).join("/")}`;
  }
  const pathname = /^[A-Za-z]:\//.test(normalized) ? `/${normalized}` : normalized;
  assertCondition(pathname.startsWith("/"), `File path is not absolute: ${path}`);
  const encoded = pathname.split("/").map((part, index) =>
    index === 1 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)
  ).join("/");
  return `file://${encoded}`;
}

async function pollDelay(deadline: number): Promise<void> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function describe(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
