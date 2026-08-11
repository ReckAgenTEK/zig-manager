import { SourceRefError } from "@zignado/source-ref";
import { CLI_JSON_SCHEMA_VERSION } from "./constants.ts";
import { ZigInvalidArgumentError, ZigManagerError } from "./errors.ts";
import { CatalogValidationError } from "./global_catalog.ts";
import { GlobalConfigValidationError } from "./global_config.ts";
import { GlobalOperationLockError } from "./global_operation_lock.ts";
import type {
  BuildOptions,
  DiagnosticFinding,
  ProcessStatus,
  ZigGcResult,
  ZigInstallResult,
  ZigManagerDoctorResult,
  ZigManagerStatus,
  ZigPurgeResult,
  ZigRepairResult,
  ZigShellStatus,
  ZigSyncResult,
  ZigUninstallResult,
  ZigUnuseResult,
  ZigUpdateResult,
  ZigUseResult,
} from "./types.ts";
import { ZigManager, type ZigManagerProgress } from "./zig_manager.ts";

export interface CliIo {
  readonly stdout: (text: string) => void | Promise<void>;
  readonly stderr: (text: string) => void | Promise<void>;
}

export interface CliExit extends ProcessStatus {}

export interface CliManager {
  versions(options?: { readonly signal?: AbortSignal }): ReturnType<ZigManager["versions"]>;
  list(options?: Parameters<ZigManager["list"]>[0]): ReturnType<ZigManager["list"]>;
  install(
    selector: string,
    options?: Parameters<ZigManager["install"]>[1],
  ): Promise<ZigInstallResult>;
  uninstall(
    installationId: string,
    options?: Parameters<ZigManager["uninstall"]>[1],
  ): Promise<ZigUninstallResult>;
  use(selector: string, options?: Parameters<ZigManager["use"]>[1]): Promise<ZigUseResult>;
  useInstalled(
    installationId: string,
    options?: Parameters<ZigManager["useInstalled"]>[1],
  ): Promise<ZigUseResult>;
  unuse(options?: Parameters<ZigManager["unuse"]>[0]): Promise<ZigUnuseResult>;
  sync(options?: Parameters<ZigManager["sync"]>[0]): Promise<ZigSyncResult>;
  update(options?: Parameters<ZigManager["update"]>[0]): Promise<ZigUpdateResult>;
  current(options?: Parameters<ZigManager["current"]>[0]): Promise<ZigManagerStatus>;
  status(options?: Parameters<ZigManager["status"]>[0]): Promise<ZigManagerStatus>;
  which(
    tool?: Parameters<ZigManager["which"]>[0],
    options?: Parameters<ZigManager["which"]>[1],
  ): Promise<string>;
  run(
    args: readonly string[],
    options?: Parameters<ZigManager["run"]>[1],
  ): ReturnType<ZigManager["run"]>;
  doctor(
    selector?: string,
    options?: Parameters<ZigManager["doctor"]>[1],
  ): Promise<ZigManagerDoctorResult>;
  shellActivate(shell: string): Promise<string>;
  shellDeactivate(shell: string): Promise<string>;
  shellStatus(options?: Parameters<ZigManager["shellStatus"]>[0]): Promise<ZigShellStatus>;
  gc(options?: Parameters<ZigManager["gc"]>[0]): Promise<ZigGcResult>;
  repair(options?: Parameters<ZigManager["repair"]>[0]): Promise<ZigRepairResult>;
  purge(options?: Parameters<ZigManager["purge"]>[0]): Promise<ZigPurgeResult>;
}

export interface CliManagerFactoryOptions {
  readonly progress: ZigManagerProgress;
}

export type CliManagerFactory = (options: CliManagerFactoryOptions) => CliManager;

export interface CliSignalRuntime {
  addSignalListener(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  removeSignalListener(signal: "SIGINT" | "SIGTERM", listener: () => void): void;
  raiseSignal(signal: Deno.Signal): void;
}

const defaultIo: CliIo = {
  stdout: (text) => writeStream(Deno.stdout, text),
  stderr: (text) => writeStream(Deno.stderr, text),
};

const defaultManagerFactory: CliManagerFactory = (options) => new ZigManager(options);

export async function runCli(
  args: readonly string[],
  io: CliIo = defaultIo,
  managerFactory: CliManagerFactory = defaultManagerFactory,
  signal?: AbortSignal,
): Promise<number> {
  return (await runCliDetailed(args, io, managerFactory, signal)).code;
}

export async function runCliDetailed(
  rawArgs: readonly string[],
  io: CliIo = defaultIo,
  managerFactory: CliManagerFactory = defaultManagerFactory,
  signal?: AbortSignal,
): Promise<CliExit> {
  let parsed: ParsedGlobalOptions;
  try {
    parsed = parseGlobalOptions(rawArgs);
  } catch (cause) {
    return await outputError(io, rawArgs.includes("--json"), cause);
  }
  const command = parsed.args[0];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    await io.stdout(help());
    return successExit();
  }

  const shellCodeCommand = command === "shell" &&
    (parsed.args[1] === "activate" || parsed.args[1] === "deactivate");
  try {
    if (shellCodeCommand && parsed.json) {
      throw new ZigInvalidArgumentError("shell activation and deactivation do not support --json");
    }
    const manager = managerFactory({ progress: (text) => io.stderr(text) });
    switch (command) {
      case "shell":
        return await shellCommand(manager, parsed.args.slice(1), parsed.json, io, signal);
      case "install": {
        const values = parseOptions(parsed.args.slice(1), ["--profile", "--jobs"], []);
        const selector = exactlyOne(values.positionals, "install requires one selector");
        const result = await manager.install(selector, buildOptions(values, signal));
        await output(io, parsed.json, command, result, () => `${result.installationId}\n`);
        return successExit();
      }
      case "use": {
        const values = parseOptions(
          parsed.args.slice(1),
          ["--installed", "--path", "--profile", "--jobs"],
          [],
        );
        const path = value(values, "--path");
        const installed = value(values, "--installed");
        let result: ZigUseResult;
        if (installed !== undefined) {
          if (values.positionals.length !== 0 || hasBuildOptions(values)) {
            throw new ZigInvalidArgumentError(
              "use --installed accepts only an installation ID and optional --path",
            );
          }
          result = await manager.useInstalled(installed, { path, ...signalOptions(signal) });
        } else {
          const selector = exactlyOne(values.positionals, "use requires one selector");
          result = await manager.use(selector, { ...buildOptions(values, signal), path });
        }
        await output(
          io,
          parsed.json,
          command,
          result,
          () => `${result.scopeRoot}: ${result.version} (${result.profileId})\n`,
        );
        if (!parsed.json && result.activationRequired) {
          await io.stderr('Activate this shell with: eval "$(zm shell activate bash)"\n');
        }
        return successExit();
      }
      case "unuse": {
        const values = parseOptions(parsed.args.slice(1), ["--path"], []);
        requireNoPositionals(values, "unuse accepts no positional arguments");
        const result = await manager.unuse({
          path: value(values, "--path"),
          ...signalOptions(signal),
        });
        await output(io, parsed.json, command, result, () => `${result.scopeRoot}\n`);
        return successExit();
      }
      case "sync": {
        const values = parseOptions(
          parsed.args.slice(1),
          ["--path", "--profile", "--jobs"],
          [],
        );
        requireNoPositionals(values, "sync accepts no positional arguments");
        const result = await manager.sync({
          ...buildOptions(values, signal),
          path: value(values, "--path"),
        });
        await output(io, parsed.json, command, result, () => `${result.executable}\n`);
        return successExit();
      }
      case "update": {
        const values = parseOptions(
          parsed.args.slice(1),
          ["--path", "--profile", "--jobs"],
          [],
        );
        requireNoPositionals(values, "update advances the selector stored in the current profile");
        const result = await manager.update({
          ...buildOptions(values, signal),
          path: value(values, "--path"),
        });
        await output(
          io,
          parsed.json,
          command,
          result,
          () =>
            `${result.scopeRoot}: ${result.version}${
              result.changed ? " (updated)" : " (unchanged)"
            }\n`,
        );
        return successExit();
      }
      case "list": {
        const values = parseOptions(parsed.args.slice(1), [], ["--remote"]);
        requireNoPositionals(values, "list accepts no positional arguments");
        const result = await manager.list({
          remote: values.flags.has("--remote"),
          ...signalOptions(signal),
        });
        await output(io, parsed.json, command, result, () => {
          const local = result.installations.map((item) =>
            `${item.installationId} ${item.version} ${item.commit}`
          );
          const remote = result.remote?.map((item) => `remote ${item.text}`) ?? [];
          return [...local, ...remote].join("\n") + (local.length + remote.length > 0 ? "\n" : "");
        });
        return successExit();
      }
      case "current":
      case "status": {
        const values = parseOptions(parsed.args.slice(1), ["--path"], ["--check"]);
        requireNoPositionals(values, `${command} accepts no positional arguments`);
        const result = command === "current"
          ? await manager.current({
            path: value(values, "--path"),
            check: values.flags.has("--check"),
            ...signalOptions(signal),
          })
          : await manager.status({
            path: value(values, "--path"),
            check: values.flags.has("--check"),
            ...signalOptions(signal),
          });
        await output(io, parsed.json, command, result, () => currentText(result));
        return successExit();
      }
      case "which": {
        const values = parseOptions(parsed.args.slice(1), ["--path"], []);
        if (values.positionals.length > 1) {
          throw new ZigInvalidArgumentError("which accepts at most one tool name");
        }
        const tool = values.positionals[0] ?? "zig";
        if (tool !== "zig" && tool !== "zls") {
          throw new ZigInvalidArgumentError("which tool must be zig or zls");
        }
        const result = await manager.which(tool, {
          path: value(values, "--path"),
          ...signalOptions(signal),
        });
        await output(io, parsed.json, command, result, () => `${result}\n`);
        return successExit();
      }
      case "run":
        return await runCommand(manager, parsed.args.slice(1), parsed.json, io, signal);
      case "doctor": {
        const values = parseOptions(
          parsed.args.slice(1),
          ["--path"],
          ["--host", "--verify", "--strict"],
        );
        if (values.positionals.length > 1) {
          throw new ZigInvalidArgumentError("doctor accepts at most one selector");
        }
        const selector = values.positionals[0];
        const host = values.flags.has("--host");
        const verify = values.flags.has("--verify");
        if (selector !== undefined && host) {
          throw new ZigInvalidArgumentError("doctor does not accept a selector with --host");
        }
        if (host && verify) {
          throw new ZigInvalidArgumentError("doctor does not accept --host with --verify");
        }
        if (selector !== undefined && verify) {
          throw new ZigInvalidArgumentError("doctor does not accept a selector with --verify");
        }
        const result = await manager.doctor(selector, {
          path: value(values, "--path"),
          host,
          verify,
          strict: values.flags.has("--strict"),
          ...signalOptions(signal),
        });
        await output(
          io,
          parsed.json,
          command,
          result,
          () => doctorText(result),
        );
        return { success: result.ok, code: result.ok ? 0 : 1, signal: null };
      }
      case "uninstall": {
        const values = parseOptions(parsed.args.slice(1), [], []);
        const installationId = exactlyOne(
          values.positionals,
          "uninstall requires one installation ID",
        );
        const result = await manager.uninstall(installationId, signalOptions(signal));
        await output(
          io,
          parsed.json,
          command,
          result,
          () => `Removed ${result.component} installation ${result.installationId}.\n`,
        );
        return successExit();
      }
      case "gc": {
        const values = parseOptions(
          parsed.args.slice(1),
          [],
          ["--dry-run", "--sources", "--build-cache", "--profiles"],
        );
        requireNoPositionals(values, "gc accepts no positional arguments");
        const result = await manager.gc({
          dryRun: values.flags.has("--dry-run"),
          sources: values.flags.has("--sources"),
          buildCache: values.flags.has("--build-cache"),
          profiles: values.flags.has("--profiles"),
          ...signalOptions(signal),
        });
        await output(io, parsed.json, command, result, () => cleanupText(result));
        return successExit();
      }
      case "repair": {
        const values = parseOptions(parsed.args.slice(1), ["--path", "--unlock"], []);
        requireNoPositionals(values, "repair accepts no positional arguments");
        const result = await manager.repair({
          path: value(values, "--path"),
          unlock: value(values, "--unlock"),
          ...signalOptions(signal),
        });
        await output(io, parsed.json, command, result, () => repairText(result));
        return successExit();
      }
      case "purge": {
        const values = parseOptions(parsed.args.slice(1), [], ["--dry-run", "--yes"]);
        requireNoPositionals(values, "purge accepts no positional arguments");
        if (values.flags.has("--dry-run") && values.flags.has("--yes")) {
          throw new ZigInvalidArgumentError("purge accepts only one of --dry-run or --yes");
        }
        const result = await manager.purge({
          dryRun: values.flags.has("--dry-run"),
          confirm: values.flags.has("--yes"),
          ...signalOptions(signal),
        });
        await output(
          io,
          parsed.json,
          command,
          result,
          () => purgeText(result),
        );
        return successExit();
      }
      default:
        throw new ZigInvalidArgumentError(`Unknown zm command '${command}'`, { command });
    }
  } catch (cause) {
    return await outputError(io, parsed.json && !shellCodeCommand, cause);
  }
}

async function shellCommand(
  manager: CliManager,
  args: readonly string[],
  json: boolean,
  io: CliIo,
  signal?: AbortSignal,
): Promise<CliExit> {
  const action = args[0];
  if (action === "activate" || action === "deactivate") {
    if (args.length !== 2) {
      throw new ZigInvalidArgumentError(`shell ${action} requires one shell name`);
    }
    const code = action === "activate"
      ? await manager.shellActivate(args[1])
      : await manager.shellDeactivate(args[1]);
    await io.stdout(code);
    return successExit();
  }
  if (action === "status") {
    if (args.length !== 1) throw new ZigInvalidArgumentError("shell status accepts no arguments");
    const result = await manager.shellStatus(signalOptions(signal));
    await output(
      io,
      json,
      "shell status",
      result,
      () => `${result.active ? "active" : "inactive"}\n${currentText(result.current)}`,
    );
    return successExit();
  }
  throw new ZigInvalidArgumentError("shell command must be activate, deactivate, or status");
}

async function runCommand(
  manager: CliManager,
  args: readonly string[],
  json: boolean,
  io: CliIo,
  signal?: AbortSignal,
): Promise<CliExit> {
  if (json) {
    throw new ZigInvalidArgumentError(
      "run does not support --json because child streams pass through",
    );
  }
  const separator = args.indexOf("--");
  if (separator < 0) throw new ZigInvalidArgumentError("run requires '--' before Zig arguments");
  const before = args.slice(0, separator);
  if (before.length > 1 || before[0]?.startsWith("--")) {
    throw new ZigInvalidArgumentError(
      "run accepts at most one selector or installation ID before '--'",
    );
  }
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();
  const result = await manager.run(args.slice(separator + 1), {
    selector: before[0],
    ...signalOptions(signal),
    stdin: "inherit",
    onStdout: (chunk) => io.stdout(stdoutDecoder.decode(chunk, { stream: true })),
    onStderr: (chunk) => io.stderr(stderrDecoder.decode(chunk, { stream: true })),
  });
  const stdout = stdoutDecoder.decode();
  const stderr = stderrDecoder.decode();
  if (stdout) await io.stdout(stdout);
  if (stderr) await io.stderr(stderr);
  return { success: result.success, code: result.code, signal: result.signal };
}

interface ParsedGlobalOptions {
  readonly args: string[];
  readonly json: boolean;
}

function parseGlobalOptions(rawArgs: readonly string[]): ParsedGlobalOptions {
  const args: string[] = [];
  let json = false;
  let afterSeparator = false;
  for (const arg of rawArgs) {
    if (arg === "--") {
      afterSeparator = true;
      args.push(arg);
    } else if (!afterSeparator && arg === "--json") {
      if (json) throw new ZigInvalidArgumentError("--json may be specified only once");
      json = true;
    } else {
      args.push(arg);
    }
  }
  return { args, json };
}

interface ParsedOptions {
  readonly positionals: string[];
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
}

function parseOptions(
  args: readonly string[],
  valueOptions: readonly string[],
  booleanOptions: readonly string[],
): ParsedOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (valueOptions.includes(arg)) {
      if (values.has(arg)) throw new ZigInvalidArgumentError(`${arg} may be specified only once`);
      const next = args[++index];
      if (next === undefined || next.startsWith("--")) {
        throw new ZigInvalidArgumentError(`${arg} requires a value`);
      }
      values.set(arg, next);
    } else if (booleanOptions.includes(arg)) {
      if (flags.has(arg)) throw new ZigInvalidArgumentError(`${arg} may be specified only once`);
      flags.add(arg);
    } else if (arg.startsWith("--")) {
      throw new ZigInvalidArgumentError(`Unknown option '${arg}'`);
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, values, flags };
}

function value(options: ParsedOptions, name: string): string | undefined {
  return options.values.get(name);
}

function buildOptions(options: ParsedOptions, signal?: AbortSignal): BuildOptions {
  const profileValue = value(options, "--profile");
  if (profileValue !== undefined && !isProfile(profileValue)) {
    throw new ZigInvalidArgumentError(`Invalid build profile '${profileValue}'`);
  }
  const jobsValue = value(options, "--jobs");
  let jobs: number | undefined;
  if (jobsValue !== undefined) {
    jobs = Number(jobsValue);
    if (!Number.isSafeInteger(jobs) || jobs < 1 || String(jobs) !== jobsValue) {
      throw new ZigInvalidArgumentError("--jobs requires a canonical positive integer");
    }
  }
  return {
    ...(profileValue === undefined ? {} : { profile: profileValue }),
    ...(jobs === undefined ? {} : { jobs }),
    ...signalOptions(signal),
  };
}

function signalOptions(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

function hasBuildOptions(options: ParsedOptions): boolean {
  return options.values.has("--profile") || options.values.has("--jobs");
}

function exactlyOne(values: readonly string[], message: string): string {
  if (values.length !== 1) throw new ZigInvalidArgumentError(message);
  return values[0];
}

function requireNoPositionals(options: ParsedOptions, message: string): void {
  if (options.positionals.length !== 0) throw new ZigInvalidArgumentError(message);
}

async function output(
  io: CliIo,
  json: boolean,
  command: string,
  result: unknown,
  human: () => string,
): Promise<void> {
  await io.stdout(
    json
      ? `${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, command, result })}\n`
      : human(),
  );
}

function currentText(result: ZigManagerStatus): string {
  return result.mode === "managed"
    ? `${result.version} ${result.commit}\n${result.executable}\nscope: ${result.scopeRoot}\n`
    : `fallback${result.executable === null ? " (not found)" : `: ${result.executable}`}\n`;
}

function doctorText(result: ZigManagerDoctorResult): string {
  const heading = result.ok
    ? result.findings.length === 0
      ? "Zig manager checks passed."
      : "Zig manager checks passed with diagnostics."
    : "Zig manager checks failed.";
  const lines = [
    heading,
    `errors: ${result.counts.errors}, warnings: ${result.counts.warnings}, info: ${result.counts.info}`,
  ];
  for (const finding of result.findings) {
    lines.push(...findingTextLines(finding));
  }
  return `${lines.join("\n")}\n`;
}

function diagnosticValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function shellDisplayArgument(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function findingTextLines(finding: DiagnosticFinding): string[] {
  const lines = [
    `[${finding.severity} ${finding.code}] ${finding.component}: ${finding.summary}`,
    `required: ${diagnosticValue(finding.required)}`,
    `found: ${diagnosticValue(finding.found)}`,
  ];
  if (finding.checkedPaths.length > 0) {
    lines.push(`checked: ${finding.checkedPaths.join(", ")}`);
  }
  lines.push(`remediation: ${finding.remediation}`);
  if (finding.packageHints.length > 0) {
    lines.push(
      `verified Arch packages: ${
        finding.packageHints.map((hint) => `${hint.name} ${hint.version}`).join(", ")
      }`,
    );
  }
  if (finding.command !== undefined) {
    lines.push(
      `display-only command: ${
        [finding.command.executable, ...finding.command.args].map(shellDisplayArgument).join(" ")
      }`,
      `warning: ${finding.command.warning}`,
    );
  }
  return lines;
}

function cleanupText(result: ZigGcResult): string {
  const lines = [
    ...result.removed.map((path) => `${result.dryRun ? "would remove" : "removed"}: ${path}`),
    ...result.retained.map((reason) => `retained: ${reason}`),
  ];
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

function repairText(result: ZigRepairResult): string {
  const lines = [
    "Manager metadata repaired.",
    `scope registry: ${result.registry.state}`,
  ];
  if (result.registry.reconciled !== null) {
    lines.push(`reconciled scope: ${result.registry.reconciled.scopeRoot}`);
  }
  if (result.registry.reason !== null) lines.push(`registry detail: ${result.registry.reason}`);
  return `${lines.join("\n")}\n`;
}

function purgeText(result: ZigPurgeResult): string {
  const verb = result.dryRun ? "would remove" : "removed";
  const lines = result.roots.map((root) => `${verb}: ${root}`);
  for (const pin of result.danglingPins) lines.push(`dangling external pin: ${pin.pinPath}`);
  if (result.registry.reason !== null) lines.push(`registry detail: ${result.registry.reason}`);
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

function cliError(cause: unknown): {
  readonly code: string;
  readonly message: string;
  readonly remediation: string | null;
  readonly details: Readonly<Record<string, unknown>>;
} {
  if (cause instanceof ZigManagerError || cause instanceof SourceRefError) {
    return {
      code: cause.code,
      message: cause.message,
      remediation: cause instanceof ZigManagerError ? cause.remediation : null,
      details: cause.details,
    };
  }
  if (cause instanceof GlobalConfigValidationError) {
    return {
      code: "ZIG_CONFIG_INVALID",
      message: cause.message,
      remediation: "Repair or remove the invalid global configuration file.",
      details: { path: cause.configPath, reason: cause.reason },
    };
  }
  if (cause instanceof CatalogValidationError) {
    return {
      code: "ZIG_STATE_INVALID",
      message: cause.message,
      remediation: null,
      details: { path: cause.path },
    };
  }
  if (cause instanceof GlobalOperationLockError) {
    return {
      code: publicLockCode(cause),
      message: cause.message,
      remediation: null,
      details: { lockPath: cause.lockPath, owner: cause.owner },
    };
  }
  if (cause !== null && typeof cause === "object") {
    const value = cause as {
      readonly code?: unknown;
      readonly message?: unknown;
      readonly remediation?: unknown;
      readonly details?: unknown;
    };
    if (typeof value.code === "string" && typeof value.message === "string") {
      return {
        code: normalizeLowLevelCode(value.code),
        message: value.message,
        remediation: typeof value.remediation === "string" ? value.remediation : null,
        details: isRecord(value.details) ? value.details : {},
      };
    }
  }
  if (cause instanceof Error) {
    return {
      code: "UNEXPECTED_ERROR",
      message: cause.message,
      remediation: null,
      details: {},
    };
  }
  return { code: "UNEXPECTED_ERROR", message: String(cause), remediation: null, details: {} };
}

function publicLockCode(error: GlobalOperationLockError): string {
  if (error.code !== "LOCK_BUSY" && error.code !== "LOCK_WAIT_TIMEOUT") return error.code;
  if (error.lockPath.includes("/scopes/")) return "ZIG_SCOPE_LOCKED";
  if (error.lockPath.includes("/installs/")) return "ZIG_INSTALL_LOCKED";
  return error.code;
}

async function outputError(io: CliIo, json: boolean, cause: unknown): Promise<CliExit> {
  const error = cliError(cause);
  if (json) {
    await io.stdout(`${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, error })}\n`);
  } else {
    await io.stderr(`${error.code}: ${error.message}\n`);
    const findings = error.details.findings;
    if (Array.isArray(findings)) {
      for (const finding of findings) {
        if (isDiagnosticFinding(finding)) {
          await io.stderr(`${findingTextLines(finding).join("\n")}\n`);
        }
      }
    }
    if (error.remediation !== null) await io.stderr(`Remediation: ${error.remediation}\n`);
  }
  return { success: false, code: 1, signal: null };
}

function normalizeLowLevelCode(code: string): string {
  const codes: Readonly<Record<string, string>> = {
    PROFILE_NOT_FOUND: "ZIG_PROFILE_NOT_FOUND",
    PROFILE_INVALID: "ZIG_PROFILE_INVALID",
    INSTALL_NOT_FOUND: "ZIG_INSTALL_NOT_FOUND",
    INSTALL_INVALID: "ZIG_INSTALL_CORRUPT",
    INSTALL_CORRUPT: "ZIG_INSTALL_CORRUPT",
  };
  return codes[code] ?? code;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDiagnosticFinding(value: unknown): value is DiagnosticFinding {
  if (!isRecord(value)) return false;
  const command = value.command;
  return (value.severity === "error" || value.severity === "warning" ||
    value.severity === "info") &&
    typeof value.code === "string" && typeof value.component === "string" &&
    typeof value.summary === "string" && Array.isArray(value.checkedPaths) &&
    value.checkedPaths.every((path) => typeof path === "string") &&
    typeof value.remediation === "string" && Array.isArray(value.packageHints) &&
    value.packageHints.every((hint) =>
      isRecord(hint) && typeof hint.name === "string" && typeof hint.version === "string"
    ) &&
    (command === undefined || isRecord(command) && command.displayOnly === true &&
        typeof command.executable === "string" && Array.isArray(command.args) &&
        command.args.every((argument) => typeof argument === "string") &&
        typeof command.warning === "string") &&
    isRecord(value.details);
}

function isProfile(value: string): value is NonNullable<BuildOptions["profile"]> {
  return value === "debug" || value === "release" || value === "relwithdebinfo" ||
    value === "minsizerel";
}

function successExit(): CliExit {
  return { success: true, code: 0, signal: null };
}

function help(): string {
  return `zm - directory-scoped source-built Zig toolchains

Usage:
  zm shell activate bash
  zm shell deactivate bash
  zm shell status [--json]
  zm install <selector> [--profile <profile>] [--jobs <count>] [--json]
  zm use <selector> [--path <directory>] [build options] [--json]
  zm use --installed <installation-id> [--path <directory>] [--json]
  zm unuse [--path <directory>] [--json]
  zm sync [--path <directory>] [build options] [--json]
  zm update [--path <directory>] [build options] [--json]
  zm list [--remote] [--json]
  zm current|status [--path <directory>] [--check] [--json]
  zm which [zig|zls] [--path <directory>] [--json]
  zm run [<selector-or-installation-id>] -- <zig arguments>
  zm doctor [selector] [--path <directory>] [--host] [--verify] [--strict] [--json]
  zm uninstall <installation-id> [--json]
  zm gc [--dry-run] [--sources] [--build-cache] [--profiles] [--json]
  zm repair [--path <directory>] [--unlock <target>] [--json]
  zm purge (--dry-run|--yes) [--json]
`;
}

async function writeStream(
  stream: { write(data: Uint8Array): Promise<number> },
  text: string,
): Promise<void> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  while (offset < bytes.length) offset += await stream.write(bytes.subarray(offset));
}

const defaultSignalRuntime: CliSignalRuntime = {
  addSignalListener: (signal, listener) => Deno.addSignalListener(signal, listener),
  removeSignalListener: (signal, listener) => Deno.removeSignalListener(signal, listener),
  raiseSignal: (signal) => Deno.kill(Deno.pid, signal),
};

/** Run one CLI invocation with process signals bridged to one shared abort signal. */
export async function runCliMain(
  args: readonly string[],
  io: CliIo = defaultIo,
  managerFactory: CliManagerFactory = defaultManagerFactory,
  runtime: CliSignalRuntime = defaultSignalRuntime,
): Promise<CliExit> {
  const controller = new AbortController();
  let recordedSignal: "SIGINT" | "SIGTERM" | null = null;
  const registered: Array<"SIGINT" | "SIGTERM"> = [];
  let removeRegisteredListeners = () => {};
  const onSignal = (signal: "SIGINT" | "SIGTERM") => {
    if (recordedSignal === null) {
      recordedSignal = signal;
      controller.abort(signal);
      return;
    }
    removeRegisteredListeners();
    runtime.raiseSignal(signal);
  };
  const listeners = {
    SIGINT: () => onSignal("SIGINT"),
    SIGTERM: () => onSignal("SIGTERM"),
  } as const;
  removeRegisteredListeners = () => {
    for (const signal of registered.splice(0).reverse()) {
      runtime.removeSignalListener(signal, listeners[signal]);
    }
  };
  let status: CliExit | undefined;
  let failed = false;
  let failure: unknown;
  try {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      runtime.addSignalListener(signal, listeners[signal]);
      registered.push(signal);
    }
    status = await runCliDetailed(args, io, managerFactory, controller.signal);
  } catch (cause) {
    failed = true;
    failure = cause;
  } finally {
    removeRegisteredListeners();
  }

  if (recordedSignal !== null) {
    runtime.raiseSignal(recordedSignal);
    return {
      success: false,
      code: recordedSignal === "SIGINT" ? 130 : 143,
      signal: recordedSignal,
    };
  }
  if (failed) throw failure;
  const completed = status!;
  if (completed.signal !== null) runtime.raiseSignal(completed.signal);
  return completed;
}

if (import.meta.main) {
  const status = await runCliMain(Deno.args);
  Deno.exit(status.code);
}
