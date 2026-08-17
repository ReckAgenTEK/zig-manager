import { basename, dirname, join, relative, resolve } from "@std/path";
import { join as windowsJoin } from "@std/path/windows";
import { BUILD_MANIFEST_FILE } from "./constants.ts";
import {
  validateZigBuildRecipe,
  ZIG_DOCS_BUILD_CONTRACT_VERSION,
  type ZigBuildRecipeV1,
} from "./build_recipe.ts";
import {
  BuildManifestValidationError,
  ZigBinaryVerificationError,
  ZigBuildError,
  ZigOperationAbortedError,
} from "./errors.ts";
import {
  assertPathContained,
  canonicalJson,
  fileMetadata,
  pathExists,
  sha256Text,
} from "./filesystem.ts";
import { readBuildManifest, writeBuildManifest } from "./manifest.ts";
import { computeInstallationId } from "./install_store.ts";
import { buildManagedInstallDocs, verifyManagedInstallDocs } from "./docs.ts";
import { buildManagedSourceSnapshot, verifyManagedSourceSnapshot } from "./source_snapshot.ts";
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
  /** Optional global cache root; buildParent creates its builds/ child. */
  readonly buildRoot?: string;
  /** Durable command-log root, normally the manager cache logs directory. */
  readonly logRoot?: string;
  /** Transaction UUID shared with locks and later install/profile staging. */
  readonly operationId?: string;
  readonly recipe: ZigBuildRecipeV1;
  readonly installationId: string;
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

const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTALLATION_ID = /^[0-9a-f]{64}$/;

export async function buildManagedZig(context: ManagedBuildContext): Promise<BuildResult> {
  throwIfAborted(context.options.signal, "build managed Zig");
  const operationId = operationUuid(context.operationId ?? crypto.randomUUID());
  const version = context.source.version;
  const recipe = validateZigBuildRecipe(context.recipe);
  const installationId = await computeInstallationId(recipe);
  if (installationId !== context.installationId) {
    throw new TypeError("build installation ID must equal the canonical recipe hash");
  }
  if (
    recipe.component !== "zig" || recipe.source.commit !== context.source.commit ||
    canonicalJson(recipe.source.version) !== canonicalJson(version) ||
    recipe.adapter.id !== context.adapter.id
  ) throw new TypeError("build context does not match its canonical recipe");
  const identityInput = buildIdentityFromRecipe(recipe);
  const identity = installationId;
  const buildRoot = resolve(context.buildRoot ?? join(context.repositoryHome, "builds"));
  const parent = join(buildRoot, "zig");
  const stagingParent = buildStagingRoot(buildRoot);
  const finalRoot = join(parent, identity);
  const finalManifestPath = join(finalRoot, BUILD_MANIFEST_FILE);
  const operationRoot = join(stagingParent, operationId);
  const stagingRoot = join(operationRoot, identity);
  const logsBase = resolve(context.logRoot ?? join(dirname(buildRoot), "logs"));
  const logRoot = join(logsBase, operationId, "zig", identity);
  assertBuildStagingOwnership(stagingParent, operationRoot, stagingRoot, operationId, identity);
  assertLogOwnership(logsBase, logRoot, operationId, identity);
  await ensurePhysicalBuildParent(parent);
  throwIfAborted(context.options.signal, "build managed Zig");
  if (await pathExists(finalRoot)) {
    try {
      const manifest = await readBuildManifest(finalManifestPath);
      await verifyBuildManifest(
        manifest,
        context.runner,
        context.adapter,
        context.platform,
        identity,
        context.options.signal,
      );
      throwIfAborted(context.options.signal, "reuse managed Zig build");
      return { manifest, reused: true };
    } catch (cause) {
      if (context.options.signal?.aborted || cause instanceof ZigOperationAbortedError) throw cause;
      await removeReplaceableBuildObject(parent, finalRoot, context.options.signal);
    }
  }

  await ensurePhysicalBuildParent(stagingParent);
  let operationRootCreated = false;
  try {
    await Deno.mkdir(operationRoot);
    operationRootCreated = true;
    await Deno.mkdir(stagingRoot);
  } catch (cause) {
    if (operationRootCreated) await removeEmptyDirectory(operationRoot);
    throw new ZigBuildError(
      "A deterministic build staging directory already exists",
      { stagingRoot, operationId, logRoot },
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
      Deno.mkdir(join(stagingRoot, "home"), { recursive: true }),
      Deno.mkdir(join(stagingRoot, "tmp"), { recursive: true }),
      Deno.mkdir(join(stagingPaths.cache, "xdg"), { recursive: true }),
      Deno.mkdir(join(stagingPaths.cache, "zig-global"), { recursive: true }),
      Deno.mkdir(join(stagingPaths.cache, "zig-local"), { recursive: true }),
    ]);
    throwIfAborted(context.options.signal, "prepare managed Zig build staging");
    await createDurableLogRoot(logsBase, logRoot, operationId, identity);
    await context.progress(`Build logs: ${logRoot}\n`);
    const commands = instantiateRecipeCommands(recipe, context.source.checkoutPath, stagingPaths);
    for (let index = 0; index < commands.length; index++) {
      await executeLoggedCommand(
        context.runner,
        commands[index],
        logRoot,
        index === 0 ? "configure" : "build",
        context.progress,
        context.options.signal,
      );
      throwIfAborted(context.options.signal, "build managed Zig");
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
    await buildManagedInstallDocs({
      adapter: context.adapter,
      platform: context.platform,
      executable: stagedExecutable,
      checkoutPath: context.source.checkoutPath,
      installPath: stagingPaths.install,
      cachePath: stagingPaths.cache,
      logsPath: stagingPaths.logs,
      llvmConfigPath: context.doctor.toolchain.llvmConfig.executable,
      selector: context.source.selector,
      version,
      commit: context.source.commit,
      runner: context.runner,
      progress: context.progress,
      signal: context.options.signal,
    });
    await verifyManagedInstallDocs(
      stagingPaths.install,
      version.text,
      context.source.commit,
      context.options.signal,
    );
    await buildManagedSourceSnapshot({
      checkoutPath: context.source.checkoutPath,
      installPath: stagingPaths.install,
      selector: context.source.selector,
      version: version.text,
      commit: context.source.commit,
      signal: context.options.signal,
    });
    await verifyManagedSourceSnapshot(
      stagingPaths.install,
      version.text,
      context.source.commit,
      context.options.signal,
    );
    const finalExecutable = relocate(stagedExecutable, stagingRoot, finalRoot);
    const finalLib = relocate(verified.lib, stagingRoot, finalRoot);
    const metadata = await fileMetadata(stagedExecutable, context.options.signal);
    const manifest: BuildManifest = {
      schemaVersion: 2,
      identity,
      recipe,
      source: {
        selector: context.source.selector,
        version,
        commit: context.source.commit,
      },
      hostTarget: context.hostTarget,
      configuration: identityInput,
      paths: { ...finalPaths, executable: finalExecutable, lib: finalLib },
      commands: relocateCommandRecords(commands, stagingRoot, finalRoot),
      compiler: { version: verified.version, sha256: metadata.sha256, size: metadata.size },
      verified: true,
    };
    await writeBuildManifest(join(stagingRoot, BUILD_MANIFEST_FILE), manifest);
    throwIfAborted(context.options.signal, "promote managed Zig build");
    await Deno.rename(stagingRoot, finalRoot);
    await removeEmptyDirectory(operationRoot);
    return { manifest, reused: false };
  } catch (cause) {
    await cleanupOwnedBuildStaging(
      stagingParent,
      operationRoot,
      stagingRoot,
      operationId,
      identity,
      cause,
    );
    try {
      await context.progress(`Build logs retained at ${logRoot}\n`);
    } catch {
      // Progress reporting must not replace the build failure.
    }
    throw buildFailureWithLogs(cause, context.options.signal, stagingRoot, logRoot);
  }
}

export function buildStagingRoot(buildRoot: string): string {
  return join(resolve(buildRoot), "zig", ".staging");
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
  throwIfAborted(signal, "verify managed Zig build");
  if (expectedIdentity !== undefined && manifest.identity !== expectedIdentity) {
    throw new BuildManifestValidationError(
      manifest.paths.root,
      "build identity does not match requested configuration",
    );
  }
  const computedIdentity = await computeInstallationId(manifest.recipe);
  throwIfAborted(signal, "verify managed Zig build");
  if (computedIdentity !== manifest.identity) {
    throw new BuildManifestValidationError(
      manifest.paths.root,
      "build identity does not match the canonical recipe",
    );
  }
  if (
    manifest.recipe.adapter.id !== adapter.id ||
    manifest.recipe.adapter.buildContractVersion !== adapter.buildContractVersion ||
    manifest.recipe.adapter.verifierContractVersion !== adapter.verifierContractVersion
  ) {
    throw new BuildManifestValidationError(
      manifest.paths.root,
      "build recipe adapter contract does not match the selected adapter",
    );
  }
  if (
    manifest.configuration.sourceCommit !== manifest.source.commit ||
    manifest.configuration.hostTarget !== manifest.hostTarget ||
    manifest.recipe.source.commit !== manifest.source.commit ||
    manifest.recipe.host.denoTarget !== manifest.hostTarget
  ) {
    throw new BuildManifestValidationError(
      manifest.paths.root,
      "manifest source or host does not match its normalized configuration",
    );
  }
  if (
    canonicalJson(manifest.configuration) !==
      canonicalJson(buildIdentityFromRecipe(manifest.recipe))
  ) {
    throw new BuildManifestValidationError(
      manifest.paths.root,
      "build configuration does not match the canonical recipe",
    );
  }
  const commandSource = manifest.commands[0]?.cwd;
  if (
    commandSource === undefined ||
    canonicalJson(manifest.commands) !==
      canonicalJson(instantiateRecipeCommands(manifest.recipe, commandSource, manifest.paths))
  ) {
    throw new BuildManifestValidationError(
      manifest.paths.root,
      "build commands do not match the canonical recipe and final cache paths",
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
  const metadata = await fileMetadata(manifest.paths.executable, signal);
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
  if (manifest.recipe.adapter.buildContractVersion >= ZIG_DOCS_BUILD_CONTRACT_VERSION) {
    await verifyManagedInstallDocs(
      manifest.paths.install,
      manifest.source.version.text,
      manifest.source.commit,
      signal,
    );
    await verifyManagedSourceSnapshot(
      manifest.paths.install,
      manifest.source.version.text,
      manifest.source.commit,
      signal,
    );
  }
  throwIfAborted(signal, "verify managed Zig build");
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
  throwIfAborted(signal, `build ${name}`);
  await writeSyncedTextFile(commandPath, `${canonicalJson(command, 2)}\n`);
  const stdout = await Deno.open(stdoutPath, { createNew: true, write: true });
  let stderr: Deno.FsFile;
  try {
    stderr = await Deno.open(stderrPath, { createNew: true, write: true });
  } catch (cause) {
    stdout.close();
    throw cause;
  }
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();
  let failed = false;
  let failure: unknown;
  try {
    await progress(`Running ${basename(command.executable)} ${name}...\n`);
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
    throwIfAborted(signal, `build ${name}`);
    if (signal?.aborted || result.signal !== null) {
      throw new ZigOperationAbortedError(`build ${name}`, { logRoot: logs }, {
        cause: signal?.reason ?? result.signal,
      });
    }
    if (!result.success) {
      throw new ZigBuildError(`CMake ${name} failed`, {
        executable: command.executable,
        args: command.args,
        exitCode: result.code,
        stderr: result.stderr,
        stderrTruncated: result.stderrTruncated,
        logRoot: logs,
      });
    }
  } catch (cause) {
    failed = true;
    failure = cause;
  } finally {
    const sync = await Promise.allSettled([stdout.sync(), stderr.sync()]);
    stdout.close();
    stderr.close();
    if (!failed) {
      const rejected = sync.find((result) => result.status === "rejected");
      if (rejected?.status === "rejected") {
        failed = true;
        failure = new ZigBuildError("Build logs could not be flushed", { logRoot: logs }, {
          cause: rejected.reason,
        });
      }
    }
  }
  if (failed) throw failure;
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
  throwIfAborted(signal, "verify built Zig executable");
  const verifyRoot = join(dirname(install), "cache", "build-verification");
  await Deno.mkdir(verifyRoot, { recursive: true });
  const verificationEnv = {
    LANG: "C",
    LC_ALL: "C",
    PATH: dirname(executable),
    HOME: join(verifyRoot, "home"),
    TMPDIR: join(verifyRoot, "tmp"),
    ZIG_LOCAL_CACHE_DIR: join(verifyRoot, "local"),
    ZIG_GLOBAL_CACHE_DIR: join(verifyRoot, "global"),
  };
  await Promise.all(
    Object.values(verificationEnv).slice(3).map((path) => Deno.mkdir(path, { recursive: true })),
  );
  const versionResult = await runner.run({
    executable,
    args: ["version"],
    clearEnv: true,
    env: verificationEnv,
    signal,
  });
  throwIfAborted(signal, "verify built Zig executable");
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
  const envResult = await runner.run({
    executable,
    args: ["env"],
    clearEnv: true,
    env: verificationEnv,
    signal,
  });
  throwIfAborted(signal, "verify built Zig executable");
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

function instantiateRecipeCommands(
  recipe: ZigBuildRecipeV1,
  sourcePath: string,
  paths: BuildArtifactPaths,
): readonly CommandRecord[] {
  const replace = (value: string) =>
    value
      .replaceAll("$SOURCE", sourcePath)
      .replaceAll("$BUILD", paths.root);
  const environment: Record<string, string> = {};
  for (const key of Object.keys(recipe.environment.variables).sort()) {
    environment[key] = replace(recipe.environment.variables[key]);
  }
  return [recipe.cmake.configureArguments, recipe.cmake.buildArguments].map((args) => ({
    executable: recipe.tools.cmake.path,
    args: args.map(replace),
    cwd: sourcePath,
    env: environment,
    clearEnv: true as const,
  }));
}

function relocateCommandRecords(
  commands: readonly CommandRecord[],
  stagingRoot: string,
  finalRoot: string,
): readonly CommandRecord[] {
  const relocateText = (value: string) => value.replaceAll(stagingRoot, finalRoot);
  return commands.map((command) => ({
    executable: command.executable,
    args: command.args.map(relocateText),
    cwd: relocateText(command.cwd),
    env: Object.fromEntries(
      Object.entries(command.env).map(([key, value]) => [key, relocateText(value)]),
    ),
    clearEnv: true,
  }));
}

function recipeToolIdentity(
  tool: ZigBuildRecipeV1["tools"]["cmake"],
): { readonly path: string; readonly version: string } {
  return { path: tool.path, version: tool.version };
}

function buildIdentityFromRecipe(recipe: ZigBuildRecipeV1): BuildIdentityInput {
  return {
    sourceCommit: recipe.source.commit,
    hostTarget: recipe.host.denoTarget,
    options: recipe.build,
    tools: {
      cmake: recipeToolIdentity(recipe.tools.cmake),
      cCompiler: recipeToolIdentity(recipe.tools.cCompiler),
      cxxCompiler: recipeToolIdentity(recipe.tools.cxxCompiler),
      llvmConfig: recipeToolIdentity(recipe.tools.llvmConfig),
      clang: recipeToolIdentity(recipe.tools.clang),
      lld: recipeToolIdentity(recipe.tools.lld),
      generatorTool: recipeToolIdentity(recipe.tools.generatorTool),
    },
  };
}

async function ensurePhysicalBuildParent(parent: string): Promise<void> {
  await Deno.mkdir(parent, { recursive: true });
  const info = await Deno.lstat(parent);
  if (
    !info.isDirectory || info.isSymlink || resolve(await Deno.realPath(parent)) !== resolve(parent)
  ) {
    throw new ZigBuildError("Build cache parent is not a physical directory", { parent });
  }
}

/** Remove only the exact replaceable cache object and never follow a symbolic link. */
async function removeReplaceableBuildObject(
  parent: string,
  target: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal, "remove corrupt build cache");
  if (dirname(resolve(target)) !== resolve(parent)) {
    throw new ZigBuildError("Refused to remove a build object outside its canonical parent", {
      parent,
      target,
    });
  }
  const info = await Deno.lstat(target);
  if (info.isSymlink || !info.isDirectory) {
    throwIfAborted(signal, "remove corrupt build cache");
    await Deno.remove(target);
    return;
  }
  const pending: Array<{ readonly path: string; readonly visited: boolean }> = [{
    path: target,
    visited: false,
  }];
  while (pending.length > 0) {
    throwIfAborted(signal, "remove corrupt build cache");
    const current = pending.pop()!;
    const currentInfo = await Deno.lstat(current.path);
    if (!currentInfo.isDirectory || currentInfo.isSymlink) {
      throwIfAborted(signal, "remove corrupt build cache");
      await Deno.remove(current.path);
      continue;
    }
    if (current.visited) {
      throwIfAborted(signal, "remove corrupt build cache");
      await Deno.remove(current.path);
      continue;
    }
    pending.push({ path: current.path, visited: true });
    const entries: Deno.DirEntry[] = [];
    for await (const entry of Deno.readDir(current.path)) entries.push(entry);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (let index = entries.length - 1; index >= 0; index--) {
      pending.push({ path: join(current.path, entries[index].name), visited: false });
    }
  }
}

async function writeAll(file: Deno.FsFile, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) offset += await file.write(chunk.subarray(offset));
}

async function writeSyncedTextFile(path: string, text: string): Promise<void> {
  const file = await Deno.open(path, { createNew: true, write: true, mode: 0o600 });
  try {
    await writeAll(file, new TextEncoder().encode(text));
    await file.sync();
  } finally {
    file.close();
  }
}

async function createDurableLogRoot(
  logsBase: string,
  logRoot: string,
  operationId: string,
  installationId: string,
): Promise<void> {
  assertLogOwnership(logsBase, logRoot, operationId, installationId);
  await ensurePhysicalBuildParent(logsBase);
  const operationRoot = join(logsBase, operationId);
  try {
    await Deno.mkdir(operationRoot);
    await Deno.mkdir(logRoot, { recursive: true });
  } catch (cause) {
    throw new ZigBuildError("Durable build log staging could not be created", {
      operationId,
      logRoot,
    }, { cause });
  }
  const info = await Deno.lstat(logRoot);
  if (!info.isDirectory || info.isSymlink || resolve(await Deno.realPath(logRoot)) !== logRoot) {
    throw new ZigBuildError("Durable build log root is not a physical directory", { logRoot });
  }
}

function assertBuildStagingOwnership(
  stagingParent: string,
  operationRoot: string,
  stagingRoot: string,
  operationId: string,
  installationId: string,
): void {
  operationUuid(operationId);
  if (!INSTALLATION_ID.test(installationId)) {
    throw new TypeError("installationId must be a lowercase SHA-256 digest");
  }
  const expectedOperation = join(resolve(stagingParent), operationId);
  const expectedStaging = join(expectedOperation, installationId);
  if (
    resolve(operationRoot) !== expectedOperation || resolve(stagingRoot) !== expectedStaging ||
    dirname(expectedOperation) !== resolve(stagingParent) ||
    dirname(expectedStaging) !== expectedOperation
  ) throw new TypeError("build staging does not match its operation UUID and installation ID");
}

function assertLogOwnership(
  logsBase: string,
  logRoot: string,
  operationId: string,
  installationId: string,
): void {
  operationUuid(operationId);
  if (!INSTALLATION_ID.test(installationId)) {
    throw new TypeError("installationId must be a lowercase SHA-256 digest");
  }
  const expected = join(resolve(logsBase), operationId, "zig", installationId);
  if (resolve(logRoot) !== expected) {
    throw new TypeError("build log root does not match its operation UUID and installation ID");
  }
}

async function cleanupOwnedBuildStaging(
  stagingParent: string,
  operationRoot: string,
  stagingRoot: string,
  operationId: string,
  installationId: string,
  operationCause: unknown,
): Promise<void> {
  try {
    assertBuildStagingOwnership(
      stagingParent,
      operationRoot,
      stagingRoot,
      operationId,
      installationId,
    );
    try {
      const info = await Deno.lstat(stagingRoot);
      await Deno.remove(stagingRoot, { recursive: info.isDirectory && !info.isSymlink });
    } catch (cause) {
      if (!(cause instanceof Deno.errors.NotFound)) throw cause;
    }
    await removeEmptyDirectory(operationRoot);
  } catch (cause) {
    throw new AggregateError(
      [operationCause, cause],
      "Managed Zig build failed and its exact owned staging could not be removed",
    );
  }
}

async function removeEmptyDirectory(path: string): Promise<void> {
  try {
    for await (const _entry of Deno.readDir(path)) return;
    await Deno.remove(path);
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound)) throw cause;
  }
}

function buildFailureWithLogs(
  cause: unknown,
  signal: AbortSignal | undefined,
  stagingRoot: string,
  logRoot: string,
): Error {
  if (signal?.aborted) {
    return new ZigOperationAbortedError("build", { logRoot }, { cause: signal.reason });
  }
  if (cause instanceof ZigOperationAbortedError) {
    return new ZigOperationAbortedError(
      String(cause.details.operation ?? "build"),
      { ...cause.details, logRoot },
      { cause },
    );
  }
  if (cause instanceof ZigBuildError) {
    return new ZigBuildError(cause.message, { ...cause.details, logRoot }, { cause });
  }
  if (cause instanceof ZigBinaryVerificationError) {
    const reason = typeof cause.details.reason === "string" ? cause.details.reason : cause.message;
    return new ZigBinaryVerificationError(reason, { ...cause.details, logRoot });
  }
  return new ZigBuildError("Managed Zig build failed", { stagingRoot, logRoot }, { cause });
}

function operationUuid(value: string): string {
  if (!OPERATION_ID.test(value)) throw new TypeError("operationId must be a canonical UUID");
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted) {
    throw new ZigOperationAbortedError(operation, {}, { cause: signal.reason });
  }
}
