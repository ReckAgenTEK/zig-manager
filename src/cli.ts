import { SourceRefError } from "@source-ref/source-ref";
import { CLI_JSON_SCHEMA_VERSION } from "./constants.ts";
import { ZigInvalidArgumentError, ZigManagerError } from "./errors.ts";
import type { BuildOptions, DocsOptions, ProcessStatus } from "./types.ts";
import { ZigManager } from "./zig_manager.ts";

export interface CliIo {
  readonly stdout: (text: string) => void | Promise<void>;
  readonly stderr: (text: string) => void | Promise<void>;
}

export interface CliExit extends ProcessStatus {}

const defaultIo: CliIo = {
  stdout: (text) => writeStream(Deno.stdout, text),
  stderr: (text) => writeStream(Deno.stderr, text),
};

export async function runCli(args: readonly string[], io: CliIo = defaultIo): Promise<number> {
  return (await runCliDetailed(args, io)).code;
}

export async function runCliDetailed(
  rawArgs: readonly string[],
  io: CliIo = defaultIo,
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
  const manager = new ZigManager({
    projectRoot: parsed.projectRoot,
    progress: (text) => io.stderr(text),
  });
  try {
    switch (command) {
      case "versions": {
        requireOnly(parsed.args.slice(1), ["--remote"]);
        const result = await manager.versions();
        await output(
          io,
          parsed.json,
          command,
          result,
          () => `${result.map((item) => item.text).join("\n")}\n`,
        );
        return successExit();
      }
      case "use": {
        const selector = requiredPositional(parsed.args.slice(1), "use requires one selector");
        const result = await manager.use(selector);
        await output(
          io,
          parsed.json,
          command,
          result,
          () => `${result.version.text} ${result.commit}\n`,
        );
        return successExit();
      }
      case "sync": {
        requireOnly(parsed.args.slice(1), []);
        const result = await manager.sync();
        await output(
          io,
          parsed.json,
          command,
          result,
          () => `${result.version.text} ${result.commit}\n`,
        );
        return successExit();
      }
      case "update": {
        const values = parsed.args.slice(1);
        if (values.length > 1 || values[0]?.startsWith("--")) {
          throw new ZigInvalidArgumentError("update accepts at most one selector");
        }
        const result = await manager.update(values[0]);
        await output(
          io,
          parsed.json,
          command,
          result,
          () => `${result.version.text} ${result.commit}\n`,
        );
        return successExit();
      }
      case "doctor": {
        requireOnly(parsed.args.slice(1), []);
        const result = await manager.doctor();
        await output(io, parsed.json, command, result, () => {
          if (result.ok) return "Zig build prerequisites are satisfied.\n";
          return `${
            result.issues.map((issue) => `${issue.component}: ${issue.message}`).join("\n")
          }\n`;
        });
        return { success: result.ok, code: result.ok ? 0 : 1, signal: null };
      }
      case "build": {
        const options = parseBuildOptions(parsed.args.slice(1));
        const result = await manager.build(options);
        await output(
          io,
          parsed.json,
          command,
          result,
          () => `${result.manifest.paths.executable}\n`,
        );
        return successExit();
      }
      case "docs": {
        const options = parseDocsOptions(parsed.args.slice(1));
        const result = await manager.docs(options);
        await output(io, parsed.json, command, result, () => `${result.manifest.outputPath}\n`);
        return successExit();
      }
      case "setup": {
        const options = parseSetupOptions(parsed.args.slice(1));
        const result = await manager.setup(options);
        await output(
          io,
          parsed.json,
          command,
          result,
          () => `${result.docs.manifest.outputPath}\n`,
        );
        return successExit();
      }
      case "path": {
        requireOnly(parsed.args.slice(1), []);
        const result = await manager.path();
        await output(io, parsed.json, command, result, () => `${result}\n`);
        return successExit();
      }
      case "run": {
        if (parsed.json) {
          throw new ZigInvalidArgumentError(
            "run does not support --json because child output is passed through",
          );
        }
        const separator = parsed.args.indexOf("--", 1);
        if (separator < 0 || separator !== 1) {
          throw new ZigInvalidArgumentError("run requires '--' before Zig arguments");
        }
        const stdoutDecoder = new TextDecoder();
        const stderrDecoder = new TextDecoder();
        const result = await manager.run(parsed.args.slice(separator + 1), {
          stdin: "inherit",
          onStdout: (chunk) => io.stdout(stdoutDecoder.decode(chunk, { stream: true })),
          onStderr: (chunk) => io.stderr(stderrDecoder.decode(chunk, { stream: true })),
        });
        const finalStdout = stdoutDecoder.decode();
        const finalStderr = stderrDecoder.decode();
        if (finalStdout) await io.stdout(finalStdout);
        if (finalStderr) await io.stderr(finalStderr);
        return { success: result.success, code: result.code, signal: result.signal };
      }
      case "env": {
        requireOnly(parsed.args.slice(1), []);
        const result = await manager.env();
        await output(io, parsed.json, command, result, () => {
          return `ZIG=${result.executable}\nPATH_PREPEND=${
            result.pathPrepend.join(pathSeparator())
          }\n`;
        });
        return successExit();
      }
      case "status": {
        requireOnly(parsed.args.slice(1), []);
        const result = await manager.status();
        await output(
          io,
          parsed.json,
          command,
          result,
          () => `${JSON.stringify(result, null, 2)}\n`,
        );
        return successExit();
      }
      default:
        throw new ZigInvalidArgumentError(`Unknown zig-manager command '${command}'`, { command });
    }
  } catch (cause) {
    return await outputError(io, parsed.json, cause);
  }
}

interface ParsedGlobalOptions {
  readonly args: string[];
  readonly json: boolean;
  readonly projectRoot: string | undefined;
}

function parseGlobalOptions(rawArgs: readonly string[]): ParsedGlobalOptions {
  const args: string[] = [];
  let json = false;
  let projectRoot: string | undefined;
  let afterSeparator = false;
  for (let index = 0; index < rawArgs.length; index++) {
    const value = rawArgs[index];
    if (value === "--") {
      afterSeparator = true;
      args.push(value);
      continue;
    }
    if (!afterSeparator && value === "--json") {
      json = true;
      continue;
    }
    if (!afterSeparator && value === "--project-root") {
      const next = rawArgs[++index];
      if (!next) throw new ZigInvalidArgumentError("--project-root requires a path");
      projectRoot = next;
      continue;
    }
    args.push(value);
  }
  return { args, json, projectRoot };
}

function parseBuildOptions(args: readonly string[]): BuildOptions {
  const result: { profile?: BuildOptions["profile"]; jobs?: number } = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--profile") {
      const value = args[++index];
      if (!isProfile(value)) {
        throw new ZigInvalidArgumentError(`Invalid build profile '${value ?? ""}'`);
      }
      result.profile = value;
    } else if (args[index] === "--jobs") {
      const value = Number(args[++index]);
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new ZigInvalidArgumentError("--jobs requires a positive integer");
      }
      result.jobs = value;
    } else {
      throw new ZigInvalidArgumentError(`Unknown build option '${args[index]}'`);
    }
  }
  return result;
}

function parseDocsOptions(args: readonly string[]): DocsOptions {
  let mega: boolean | undefined;
  for (const arg of args) {
    if (arg === "--mega") mega = true;
    else if (arg === "--no-mega") mega = false;
    else throw new ZigInvalidArgumentError(`Unknown docs option '${arg}'`);
  }
  return mega === undefined ? {} : { mega };
}

function parseSetupOptions(args: readonly string[]): BuildOptions & DocsOptions {
  const buildArgs: string[] = [];
  const docsArgs: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--mega" || args[index] === "--no-mega") docsArgs.push(args[index]);
    else {
      buildArgs.push(args[index]);
      if (args[index] === "--profile" || args[index] === "--jobs") {
        const value = args[++index];
        if (value === undefined) {
          throw new ZigInvalidArgumentError(`${args[index - 1]} requires a value`);
        }
        buildArgs.push(value);
      }
    }
  }
  return { ...parseBuildOptions(buildArgs), ...parseDocsOptions(docsArgs) };
}

function requiredPositional(args: readonly string[], message: string): string {
  if (args.length !== 1 || args[0].startsWith("--")) throw new ZigInvalidArgumentError(message);
  return args[0];
}

function requireOnly(args: readonly string[], allowed: readonly string[]): void {
  for (const arg of args) {
    if (!allowed.includes(arg)) throw new ZigInvalidArgumentError(`Unknown option '${arg}'`);
  }
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

function cliError(cause: unknown): {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
} {
  if (cause instanceof ZigManagerError || cause instanceof SourceRefError) {
    return { code: cause.code, message: cause.message, details: cause.details };
  }
  if (cause instanceof Error) {
    return { code: "UNEXPECTED_ERROR", message: cause.message, details: {} };
  }
  return { code: "UNEXPECTED_ERROR", message: String(cause), details: {} };
}

async function outputError(io: CliIo, json: boolean, cause: unknown): Promise<CliExit> {
  const error = cliError(cause);
  if (json) {
    await io.stdout(`${JSON.stringify({ schemaVersion: CLI_JSON_SCHEMA_VERSION, error })}\n`);
  } else {
    await io.stderr(`${error.code}: ${error.message}\n`);
  }
  return { success: false, code: 1, signal: null };
}

function isProfile(value: string | undefined): value is NonNullable<BuildOptions["profile"]> {
  return value === "debug" || value === "release" || value === "relwithdebinfo" ||
    value === "minsizerel";
}

function successExit(): CliExit {
  return { success: true, code: 0, signal: null };
}

function pathSeparator(): string {
  return Deno.build.os === "windows" ? ";" : ":";
}

function help(): string {
  return `zig-manager - source-built managed Zig toolchains

Usage:
  zig-manager versions [--remote] [--json]
  zig-manager use <selector> [--json]
  zig-manager sync [--json]
  zig-manager update [selector] [--json]
  zig-manager doctor [--json]
  zig-manager build [--profile <profile>] [--jobs <count>] [--json]
  zig-manager docs [--mega|--no-mega] [--json]
  zig-manager setup [build/docs options] [--json]
  zig-manager path [--json]
  zig-manager run -- <zig arguments>
  zig-manager env [--json]
  zig-manager status [--json]

Global options:
  --project-root <path>  Project containing zig-manager.json
  --json                 Stable schema-versioned JSON output
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

if (import.meta.main) {
  const status = await runCliDetailed(Deno.args);
  if (status.signal !== null) {
    try {
      Deno.kill(Deno.pid, status.signal);
    } catch {
      Deno.exit(status.code);
    }
  } else {
    Deno.exit(status.code);
  }
}
