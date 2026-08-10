import { basename, join, relative, resolve } from "@std/path";
import { join as windowsJoin } from "@std/path/windows";
import { BUILD_MANIFEST_FILE } from "./constants.ts";
import {
  BuildManifestValidationError,
  ZigBinaryVerificationError,
  ZigBuildError,
  ZigOperationAbortedError,
} from "./errors.ts";
import {
  assertPathContained,
  atomicReplaceDirectory,
  canonicalJson,
  fileMetadata,
  pathExists,
  removeIfPresent,
  sha256Text,
} from "./filesystem.ts";
import { readBuildManifest, toolIdentity, writeBuildManifest } from "./manifest.ts";
import type { ReleaseAdapter } from "./release_adapter.ts";
import type {
  BuildArtifactPaths,
  BuildIdentityInput,
  BuildManifest,
  BuildOptions,
  BuildResult,
  CommandRecord,
  ProcessRunner,
  SourceSelectionState,
  ZigDoctorResult,
} from "./types.ts";

export interface ManagedBuildContext {
  readonly repositoryHome: string;
  readonly source: SourceSelectionState;
  readonly doctor: ZigDoctorResult;
  readonly adapter: ReleaseAdapter;
  readonly runner: ProcessRunner;
  readonly hostTarget: string;
  readonly platform: "linux" | "darwin" | "windows";
  readonly config: Parameters<ReleaseAdapter["normalizeBuildOptions"]>[0];
  readonly options: BuildOptions;
  readonly progress: (message: string) => void | Promise<void>;
}

export async function buildManagedZig(context: ManagedBuildContext): Promise<BuildResult> {
  const version = context.source.version;
  const normalized = context.adapter.normalizeBuildOptions(
    context.config,
    context.options.profile,
    context.options.jobs,
    context.doctor.toolchain.cmakePrefixPath,
  );
  const identityInput: BuildIdentityInput = {
    sourceCommit: context.source.commit,
    hostTarget: context.hostTarget,
    options: normalized,
    tools: {
      cmake: toolIdentity(context.doctor.toolchain.cmake),
      cCompiler: toolIdentity(context.doctor.toolchain.cCompiler),
      cxxCompiler: toolIdentity(context.doctor.toolchain.cxxCompiler),
      llvmConfig: toolIdentity(context.doctor.toolchain.llvmConfig),
      clang: toolIdentity(context.doctor.toolchain.clang),
      lld: toolIdentity(context.doctor.toolchain.lld),
      generatorTool: context.doctor.toolchain.generatorTool === null
        ? null
        : toolIdentity(context.doctor.toolchain.generatorTool),
    },
  };
  const identity = await computeBuildIdentity(identityInput);
  const parent = buildParent(
    context.repositoryHome,
    context.source.commit,
    context.hostTarget,
    normalized.profile,
  );
  const finalRoot = join(parent, identity);
  const finalManifestPath = join(finalRoot, BUILD_MANIFEST_FILE);
  if (await pathExists(finalManifestPath)) {
    const manifest = await readBuildManifest(finalManifestPath);
    await verifyBuildManifest(
      manifest,
      context.runner,
      context.adapter,
      context.platform,
      identity,
      context.options.signal,
    );
    return { manifest, reused: true };
  }

  await Deno.mkdir(parent, { recursive: true });
  const stagingRoot = join(parent, `.${identity}.staging`);
  try {
    await Deno.mkdir(stagingRoot);
  } catch (cause) {
    throw new ZigBuildError(
      "A deterministic build staging directory already exists",
      { stagingRoot },
      { cause },
    );
  }
  const stagingPaths = createBuildPaths(stagingRoot, context.platform);
  const finalPaths = createBuildPaths(finalRoot, context.platform);
  try {
    await Promise.all([
      Deno.mkdir(stagingPaths.cmakeBuild, { recursive: true }),
      Deno.mkdir(stagingPaths.install, { recursive: true }),
      Deno.mkdir(stagingPaths.cache, { recursive: true }),
      Deno.mkdir(stagingPaths.logs, { recursive: true }),
    ]);
    const commands = context.adapter.createBuildCommands({
      platform: context.platform,
      sourcePath: context.source.checkoutPath,
      version,
      paths: stagingPaths,
      options: normalized,
      toolchain: context.doctor.toolchain,
    });
    for (let index = 0; index < commands.length; index++) {
      await executeLoggedCommand(
        context.runner,
        commands[index],
        stagingPaths.logs,
        index === 0 ? "configure" : "build",
        context.progress,
        context.options.signal,
      );
    }
    const stagedExecutable = await locateExecutable(
      context.adapter,
      stagingPaths.install,
      context.platform,
    );
    const verified = await verifyExecutable(
      stagedExecutable,
      stagingPaths.install,
      version.text,
      context.runner,
      context.options.signal,
    );
    const finalExecutable = relocate(stagedExecutable, stagingRoot, finalRoot);
    const finalLib = relocate(verified.lib, stagingRoot, finalRoot);
    const metadata = await fileMetadata(stagedExecutable);
    const manifest: BuildManifest = {
      schemaVersion: 2,
      identity,
      source: {
        selector: context.source.selector,
        version,
        commit: context.source.commit,
      },
      hostTarget: context.hostTarget,
      configuration: identityInput,
      paths: { ...finalPaths, executable: finalExecutable, lib: finalLib },
      commands,
      compiler: { version: verified.version, sha256: metadata.sha256, size: metadata.size },
      verified: true,
    };
    await writeBuildManifest(join(stagingRoot, BUILD_MANIFEST_FILE), manifest);
    await atomicReplaceDirectory(stagingRoot, finalRoot);
    return { manifest, reused: false };
  } catch (cause) {
    await removeIfPresent(stagingRoot, true);
    if (context.options.signal?.aborted) throw new ZigOperationAbortedError("build");
    if (
      cause instanceof ZigBuildError || cause instanceof ZigBinaryVerificationError ||
      cause instanceof ZigOperationAbortedError
    ) throw cause;
    throw new ZigBuildError("Managed Zig build failed", { stagingRoot }, { cause });
  }
}

export async function computeBuildIdentity(input: BuildIdentityInput): Promise<string> {
  return await sha256Text(canonicalJson(input));
}

export function buildParent(
  repositoryHome: string,
  commit: string,
  hostTarget: string,
  profile: string,
): string {
  for (
    const [name, value] of [["commit", commit], ["host target", hostTarget], ["profile", profile]]
  ) {
    if (!/^[A-Za-z0-9._-]+$/.test(value)) {
      throw new TypeError(`${name} is not safe for a build path`);
    }
  }
  return join(repositoryHome, "builds", commit, hostTarget, profile);
}

export function createBuildPaths(
  root: string,
  platform: "linux" | "darwin" | "windows",
): BuildArtifactPaths {
  const executableName = platform === "windows" ? "zig.exe" : "zig";
  const pathJoin = platform === "windows" ? windowsJoin : join;
  return {
    root,
    cmakeBuild: pathJoin(root, "cmake-build"),
    install: pathJoin(root, "install"),
    cache: pathJoin(root, "cache"),
    logs: pathJoin(root, "logs"),
    executable: pathJoin(root, "install", "bin", executableName),
    lib: pathJoin(root, "install", "lib", "zig"),
  };
}

export async function verifyBuildManifest(
  manifest: BuildManifest,
  runner: ProcessRunner,
  adapter: ReleaseAdapter,
  platform: "linux" | "darwin" | "windows",
  expectedIdentity?: string,
  signal?: AbortSignal,
): Promise<void> {
  if (expectedIdentity !== undefined && manifest.identity !== expectedIdentity) {
    throw new BuildManifestValidationError(
      manifest.paths.root,
      "build identity does not match requested configuration",
    );
  }
  const computedIdentity = await computeBuildIdentity(manifest.configuration);
  if (computedIdentity !== manifest.identity) {
    throw new BuildManifestValidationError(
      manifest.paths.root,
      "build identity does not match the normalized configuration",
    );
  }
  if (
    manifest.configuration.sourceCommit !== manifest.source.commit ||
    manifest.configuration.hostTarget !== manifest.hostTarget
  ) {
    throw new BuildManifestValidationError(
      manifest.paths.root,
      "manifest source or host does not match its normalized configuration",
    );
  }
  for (
    const path of [
      manifest.paths.cmakeBuild,
      manifest.paths.install,
      manifest.paths.cache,
      manifest.paths.logs,
      manifest.paths.executable,
      manifest.paths.lib,
    ]
  ) assertPathContained(manifest.paths.root, path);
  assertPathContained(manifest.paths.install, manifest.paths.executable);
  assertPathContained(manifest.paths.install, manifest.paths.lib);
  const metadata = await fileMetadata(manifest.paths.executable);
  if (metadata.sha256 !== manifest.compiler.sha256 || metadata.size !== manifest.compiler.size) {
    throw new ZigBinaryVerificationError("compiler hash or size differs from its manifest", {
      executable: manifest.paths.executable,
    });
  }
  const verified = await verifyExecutable(
    manifest.paths.executable,
    manifest.paths.install,
    manifest.source.version.text,
    runner,
    signal,
  );
  if (
    verified.version !== manifest.compiler.version ||
    resolve(verified.lib) !== resolve(manifest.paths.lib)
  ) {
    throw new ZigBinaryVerificationError("compiler runtime metadata differs from its manifest");
  }
  const candidates = adapter.executableCandidates(manifest.paths.install, platform).map((path) =>
    resolve(path)
  );
  if (!candidates.includes(resolve(manifest.paths.executable))) {
    throw new ZigBinaryVerificationError("compiler path is not valid for the release adapter");
  }
}

async function executeLoggedCommand(
  runner: ProcessRunner,
  command: CommandRecord,
  logs: string,
  name: string,
  progress: (message: string) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const stdoutPath = join(logs, `${name}.stdout.log`);
  const stderrPath = join(logs, `${name}.stderr.log`);
  const commandPath = join(logs, `${name}.command.json`);
  await Deno.writeTextFile(commandPath, `${canonicalJson(command, 2)}\n`, { createNew: true });
  const stdout = await Deno.open(stdoutPath, { createNew: true, write: true });
  const stderr = await Deno.open(stderrPath, { createNew: true, write: true });
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();
  await progress(`Running ${basename(command.executable)} ${name}...\n`);
  try {
    const result = await runner.run({
      ...command,
      signal,
      onStdout: async (chunk) => {
        await writeAll(stdout, chunk);
        const text = stdoutDecoder.decode(chunk, { stream: true });
        if (text.length > 0) await progress(text);
      },
      onStderr: async (chunk) => {
        await writeAll(stderr, chunk);
        const text = stderrDecoder.decode(chunk, { stream: true });
        if (text.length > 0) await progress(text);
      },
    });
    await Promise.all([stdout.sync(), stderr.sync()]);
    if (signal?.aborted || result.signal !== null) {
      throw new ZigOperationAbortedError(`build ${name}`);
    }
    if (!result.success) {
      throw new ZigBuildError(`CMake ${name} failed`, {
        executable: command.executable,
        args: command.args,
        exitCode: result.code,
        stderr: result.stderr,
        stderrTruncated: result.stderrTruncated,
      });
    }
  } finally {
    stdout.close();
    stderr.close();
  }
}

async function locateExecutable(
  adapter: ReleaseAdapter,
  install: string,
  platform: "linux" | "darwin" | "windows",
): Promise<string> {
  for (const candidate of adapter.executableCandidates(install, platform)) {
    if (await pathExists(candidate)) return candidate;
  }
  throw new ZigBinaryVerificationError("built Zig executable was not found", {
    candidates: adapter.executableCandidates(install, platform),
  });
}

async function verifyExecutable(
  executable: string,
  install: string,
  expectedVersion: string,
  runner: ProcessRunner,
  signal?: AbortSignal,
): Promise<{ version: string; lib: string }> {
  const versionResult = await runner.run({ executable, args: ["version"], signal });
  if (!versionResult.success) {
    throw new ZigBinaryVerificationError("'zig version' failed", {
      executable,
      exitCode: versionResult.code,
      stderr: versionResult.stderr,
    });
  }
  const version = versionResult.stdout.trim();
  if (version !== expectedVersion) {
    throw new ZigBinaryVerificationError("compiler version does not match selected source", {
      expectedVersion,
      actualVersion: version,
    });
  }
  const envResult = await runner.run({ executable, args: ["env"], signal });
  if (!envResult.success) {
    throw new ZigBinaryVerificationError("'zig env' failed", {
      executable,
      exitCode: envResult.code,
      stderr: envResult.stderr,
    });
  }
  const lib = parseZigEnvLibDir(envResult.stdout);
  assertPathContained(install, lib);
  try {
    if (!(await Deno.stat(lib)).isDirectory) throw new Error("not a directory");
    if (!(await Deno.stat(join(lib, "std", "std.zig"))).isFile) {
      throw new Error("std/std.zig is missing");
    }
  } catch (cause) {
    throw new ZigBinaryVerificationError("managed Zig lib directory is missing", {
      lib,
      cause: String(cause),
    });
  }
  return { version, lib: resolve(lib) };
}

/** Parse the JSON used by older Zig releases and the ZON emitted by Zig 0.16. */
export function parseZigEnvLibDir(output: string): string {
  try {
    const value: unknown = JSON.parse(output);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const lib = (value as Record<string, unknown>).lib_dir;
      if (typeof lib === "string" && lib.length > 0) return lib;
    }
  } catch {
    // Zig 0.16 intentionally emits ZON rather than JSON.
  }

  const matches = [...output.matchAll(/(?:^|\n)\s*\.lib_dir\s*=\s*"((?:\\.|[^"\\])*)"\s*,?/g)];
  if (matches.length !== 1) {
    throw new ZigBinaryVerificationError("'zig env' did not report exactly one lib_dir");
  }
  try {
    const decoded = decodeZigString(matches[0][1]);
    if (decoded.length === 0) throw new Error("lib_dir is empty");
    return decoded;
  } catch (cause) {
    throw new ZigBinaryVerificationError("'zig env' reported an invalid ZON lib_dir", {
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

function decodeZigString(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character !== "\\") {
      result += character;
      continue;
    }
    const escape = value[++index];
    if (escape === undefined) throw new Error("incomplete escape");
    if (escape === "n") result += "\n";
    else if (escape === "r") result += "\r";
    else if (escape === "t") result += "\t";
    else if (escape === "\\" || escape === '"' || escape === "'") result += escape;
    else if (escape === "x") {
      const digits = value.slice(index + 1, index + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(digits)) throw new Error("invalid hexadecimal escape");
      result += String.fromCharCode(Number.parseInt(digits, 16));
      index += 2;
    } else if (escape === "u" && value[index + 1] === "{") {
      const end = value.indexOf("}", index + 2);
      if (end < 0) throw new Error("unterminated Unicode escape");
      const digits = value.slice(index + 2, end);
      if (!/^[0-9a-fA-F]{1,6}$/.test(digits)) throw new Error("invalid Unicode escape");
      const codePoint = Number.parseInt(digits, 16);
      if (codePoint > 0x10ffff || codePoint >= 0xd800 && codePoint <= 0xdfff) {
        throw new Error("invalid Unicode code point");
      }
      result += String.fromCodePoint(codePoint);
      index = end;
    } else {
      throw new Error(`unsupported escape \\${escape}`);
    }
  }
  return result;
}

function relocate(path: string, fromRoot: string, toRoot: string): string {
  const rel = relative(resolve(fromRoot), resolve(path));
  if (rel === ".." || rel.startsWith(`..${Deno.build.os === "windows" ? "\\" : "/"}`)) {
    throw new ZigBinaryVerificationError("verified build path escapes staging root", {
      path,
      fromRoot,
    });
  }
  return join(toRoot, rel);
}

async function writeAll(file: Deno.FsFile, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) offset += await file.write(chunk.subarray(offset));
}
