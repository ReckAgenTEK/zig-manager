import { ZigManager } from "../src/mod.ts";

const STARTUP_TIMEOUT_MS = 20_000;
const CDP_COMMAND_TIMEOUT_MS = 15_000;
const TOP_LEVEL_LOAD_TIMEOUT_MS = 90_000;
const AUTODOC_TIMEOUT_MS = 180_000;
const INTERACTION_TIMEOUT_MS = 30_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 50;

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
  name: "opt-in real network/build/docs end-to-end workflow",
  ignore: Deno.env.get("ZIG_MANAGER_E2E") !== "1",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const projectRoot = Deno.env.get("ZIG_MANAGER_E2E_PROJECT_ROOT");
    if (!projectRoot) {
      throw new Error("ZIG_MANAGER_E2E_PROJECT_ROOT is required for the opt-in E2E test");
    }
    await new ZigManager({ projectRoot }).setup();
  },
});

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
