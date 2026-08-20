import { basename, dirname, isAbsolute, join, resolve } from "@std/path";
import {
  type BuildRecipeHost,
  createZlsBuildArguments,
  validateZlsBuildRecipe,
  ZLS_BUILD_CONTRACT_VERSION,
  ZLS_BUILD_RECIPE_ADAPTER_ID,
  ZLS_INSTALL_VERIFIER_CONTRACT_VERSION,
  type ZlsBuildProfile,
  type ZlsBuildRecipeV1,
  zlsOptimizeForProfile,
  type ZlsOptimizeMode,
  type ZlsZigExecutableFingerprint,
} from "./build_recipe.ts";
import { ZigOperationAbortedError } from "./errors.ts";
import {
  assertPathContained,
  atomicWriteJson,
  canonicalJson,
  fileMetadata,
  pathExists,
} from "./filesystem.ts";
import {
  computeInstallationId,
  type InstallCommandRecord,
  type InstalledObject,
} from "./install_store.ts";
import type { ProcessResult, ProcessRunner } from "./types.ts";
import { type ResolvedZlsSource, validateResolvedZlsSource } from "./zls_source_workspace.ts";

const MAX_BUILD_DIAGNOSTIC_BYTES = 1024 * 1024;
const MAX_VERSION_OUTPUT_BYTES = 16 * 1024;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTALLATION_ID = /^[0-9a-f]{64}$/;

export const ZLS_BUILD_MANIFEST_SCHEMA_VERSION = 1 as const;
export const ZLS_BUILD_MANIFEST_FILE = "zls-build-manifest.json" as const;

export interface CreateZlsBuildRecipeInput {
  readonly source: ResolvedZlsSource;
  readonly host: BuildRecipeHost;
  readonly zigInstallationId: string;
  readonly zigExecutable: ZlsZigExecutableFingerprint;
  readonly profile?: ZlsBuildProfile;
  readonly optimize?: ZlsOptimizeMode;
  readonly jobs?: number | null;
  readonly adapter?: {
    readonly id: string;
    readonly buildContractVersion: number;
    readonly verifierContractVersion: number;
  };
}

export interface PrepareZlsBuildRecipeInput {
  readonly source: ResolvedZlsSource;
  readonly host: BuildRecipeHost;
  readonly zig: InstalledObject;
  readonly profile?: ZlsBuildProfile;
  readonly optimize?: ZlsOptimizeMode;
  readonly jobs?: number | null;
  readonly signal?: AbortSignal;
}

export interface PreparedZlsBuildRecipe {
  readonly recipe: ZlsBuildRecipeV1;
  readonly installationId: string;
  readonly zig: InstalledObject;
}

export interface ZlsBuildPaths {
  readonly root: string;
  readonly install: string;
  readonly cache: string;
  readonly executable: string;
}

export interface ZlsBuildManifestV1 {
  readonly schemaVersion: 1;
  readonly installationId: string;
  readonly recipe: ZlsBuildRecipeV1;
  readonly source: ResolvedZlsSource;
  readonly hostTarget: string;
  readonly paths: ZlsBuildPaths;
  readonly command: InstallCommandRecord;
  readonly executable: {
    readonly version: string;
    readonly size: number;
    readonly sha256: string;
  };
  readonly verified: true;
}

export interface BuildManagedZlsInput {
  readonly recipe: ZlsBuildRecipeV1;
  readonly installationId: string;
  readonly sourcePath: string;
  readonly zig: InstalledObject;
  readonly runner: ProcessRunner;
  readonly buildRoot: string;
  readonly logRoot: string;
  readonly operationId?: string;
  readonly progress?: (message: string) => void | Promise<void>;
  readonly clean?: boolean;
  readonly signal?: AbortSignal;
}

export interface BuildManagedZlsResult {
  readonly manifest: ZlsBuildManifestV1;
  readonly reused: boolean;
}

export class ZlsBuildError extends Error {
  readonly code = "ZLS_BUILD_FAILED";
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ZlsBuildError";
    this.details = details;
  }
}

/** Construct the canonical recipe from already trusted, path-independent Zig metadata. */
export function createZlsBuildRecipe(input: CreateZlsBuildRecipeInput): ZlsBuildRecipeV1 {
  const source = validateResolvedZlsSource(input.source);
  const profile = input.profile ?? "release-safe";
  const optimize = input.optimize ?? zlsOptimizeForProfile(profile);
  const jobs = input.jobs ?? null;
  const adapter = input.adapter ?? {
    id: ZLS_BUILD_RECIPE_ADAPTER_ID,
    buildContractVersion: ZLS_BUILD_CONTRACT_VERSION,
    verifierContractVersion: ZLS_INSTALL_VERIFIER_CONTRACT_VERSION,
  };
  const variables = {
    CFLAGS: "",
    CXXFLAGS: "",
    CPPFLAGS: "",
    LDFLAGS: "",
    CPATH: "",
    C_INCLUDE_PATH: "",
    CPLUS_INCLUDE_PATH: "",
    LIBRARY_PATH: "",
    CMAKE_PREFIX_PATH: "",
    PKG_CONFIG_PATH: "",
    LANG: "C",
    LC_ALL: "C",
    PATH: "$ZIG_BIN",
    HOME: "$BUILD/home",
    TMPDIR: "$BUILD/tmp",
    XDG_CACHE_HOME: "$BUILD/cache/xdg",
    ZIG_GLOBAL_CACHE_DIR: "$BUILD/cache/zig-global",
    ZIG_LOCAL_CACHE_DIR: "$BUILD/cache/zig-local",
  };
  return validateZlsBuildRecipe({
    schemaVersion: 1,
    component: "zls",
    source: {
      repository: source.repository,
      commit: source.commit,
      version: source.versionMetadata,
      resolved: source,
    },
    adapter,
    host: input.host,
    build: {
      strategy: "zig",
      profile,
      optimize,
      jobs,
      arguments: createZlsBuildArguments({
        versionString: source.versionMetadata.versionString,
        optimize,
        jobs,
      }),
    },
    environment: { clearEnv: true, inherited: [], variables },
    zig: { executable: input.zigExecutable },
    dependencies: [{ component: "zig", installationId: input.zigInstallationId }],
  });
}

/** Fingerprint the exact immutable Zig dependency before creating a recipe. */
export async function prepareZlsBuildRecipe(
  input: PrepareZlsBuildRecipeInput,
): Promise<PreparedZlsBuildRecipe> {
  throwIfAborted(input.signal, "prepare ZLS build recipe");
  const fingerprint = await validateZigDependency(input.zig, input.signal);
  const recipe = createZlsBuildRecipe({
    source: input.source,
    host: input.host,
    zigInstallationId: input.zig.manifest.installationId,
    zigExecutable: fingerprint,
    ...(input.profile === undefined ? {} : { profile: input.profile }),
    ...(input.optimize === undefined ? {} : { optimize: input.optimize }),
    ...(input.jobs === undefined ? {} : { jobs: input.jobs }),
  });
  throwIfAborted(input.signal, "prepare ZLS build recipe");
  return {
    recipe,
    installationId: await computeInstallationId(recipe),
    zig: input.zig,
  };
}

/** Build one exact ZLS recipe through the exact immutable Zig executable dependency. */
export async function buildManagedZls(
  input: BuildManagedZlsInput,
): Promise<BuildManagedZlsResult> {
  throwIfAborted(input.signal, "build managed ZLS");
  const recipe = validateZlsBuildRecipe(input.recipe);
  assertCurrentContracts(recipe);
  const installationId = await computeInstallationId(recipe);
  if (installationId !== installationDigest(input.installationId)) {
    throw new TypeError("ZLS build installation ID must equal the canonical recipe hash");
  }
  const zigFingerprint = await validateZigDependency(input.zig, input.signal);
  assertRecipeDependency(recipe, input.zig, zigFingerprint);

  const sourcePath = normalizedAbsolute(input.sourcePath, "ZLS source path");
  await assertPhysicalDirectory(sourcePath, "ZLS source path");
  const buildRoot = normalizedAbsolute(input.buildRoot, "ZLS build root");
  const logBase = normalizedAbsolute(input.logRoot, "ZLS log root");
  const operationId = operationUuid(input.operationId ?? crypto.randomUUID());
  const componentRoot = join(buildRoot, "zls");
  const finalRoot = join(componentRoot, installationId);
  const finalPaths = buildPaths(finalRoot);
  const finalManifestPath = join(finalRoot, ZLS_BUILD_MANIFEST_FILE);
  const stagingParent = join(componentRoot, ".staging");
  const operationRoot = join(stagingParent, operationId);
  const stagingRoot = join(operationRoot, installationId);
  const stagingPaths = buildPaths(stagingRoot);
  const logRoot = join(logBase, operationId, "zls", installationId);
  assertOwnedStaging(stagingParent, operationRoot, stagingRoot, operationId, installationId);
  assertOwnedLog(logBase, logRoot, operationId, installationId);
  await ensurePhysicalDirectory(componentRoot);

  if (input.clean === true && await pathExists(finalRoot)) {
    await removeReplaceableCacheObject(componentRoot, finalRoot);
  }
  if (await pathExists(finalRoot)) {
    try {
      const manifest = await readZlsBuildManifest(finalManifestPath);
      await verifyCachedBuild(manifest, recipe, finalPaths, input.runner, input.signal);
      return { manifest, reused: true };
    } catch (cause) {
      if (input.signal?.aborted || cause instanceof ZigOperationAbortedError) throw cause;
      await removeReplaceableCacheObject(componentRoot, finalRoot);
    }
  }

  await ensurePhysicalDirectory(stagingParent);
  let operationCreated = false;
  try {
    await Deno.mkdir(operationRoot);
    operationCreated = true;
    await Deno.mkdir(stagingRoot);
  } catch (cause) {
    if (operationCreated) await removeEmptyDirectory(operationRoot);
    throw new ZlsBuildError("Deterministic ZLS build staging already exists", {
      operationId,
      stagingRoot,
    }, { cause });
  }

  try {
    await Promise.all([
      Deno.mkdir(stagingPaths.install, { recursive: true }),
      Deno.mkdir(join(stagingRoot, "home")),
      Deno.mkdir(join(stagingRoot, "tmp")),
      Deno.mkdir(join(stagingPaths.cache, "xdg"), { recursive: true }),
      Deno.mkdir(join(stagingPaths.cache, "zig-global"), { recursive: true }),
      Deno.mkdir(join(stagingPaths.cache, "zig-local"), { recursive: true }),
    ]);
    await createLogRoot(logBase, logRoot, operationId, installationId);
    await (input.progress ?? (() => {}))(`ZLS build logs: ${logRoot}\n`);
    const command = instantiateBuildCommand(
      recipe,
      sourcePath,
      stagingPaths,
      input.zig.executablePath,
    );
    await executeLoggedBuild(
      input.runner,
      command,
      logRoot,
      input.progress ?? (() => {}),
      input.signal,
    );
    throwIfAborted(input.signal, "inspect ZLS build output");
    await assertPhysicalRegularTree(stagingPaths.install, input.signal);
    const version = await verifyBuiltVersion(
      stagingPaths.executable,
      recipe.source.version.versionString,
      input.runner,
      verificationEnvironment(stagingRoot, stagingPaths.executable),
      stagingRoot,
      input.signal,
    );
    const executable = await stablePhysicalMetadata(
      stagingPaths.executable,
      "built ZLS executable",
      input.signal,
    );
    const finalCommand = relocateCommand(command, stagingRoot, finalRoot);
    const manifest = validateZlsBuildManifest({
      schemaVersion: ZLS_BUILD_MANIFEST_SCHEMA_VERSION,
      installationId,
      recipe,
      source: recipe.source.resolved,
      hostTarget: recipe.host.denoTarget,
      paths: finalPaths,
      command: finalCommand,
      executable: { version, ...executable },
      verified: true,
    });
    await atomicWriteJson(join(stagingRoot, ZLS_BUILD_MANIFEST_FILE), manifest, {
      operationId,
      signal: input.signal,
    });
    throwIfAborted(input.signal, "publish managed ZLS build cache");
    await Deno.rename(stagingRoot, finalRoot);
    await removeEmptyDirectory(operationRoot);
    return { manifest, reused: false };
  } catch (cause) {
    try {
      await removeOwnedStaging(
        stagingParent,
        operationRoot,
        stagingRoot,
        operationId,
        installationId,
      );
    } catch (cleanupCause) {
      throw new AggregateError(
        [cause, cleanupCause],
        "Managed ZLS build failed and its owned staging could not be removed",
      );
    }
    if (input.signal?.aborted && !(cause instanceof ZigOperationAbortedError)) {
      throw new ZigOperationAbortedError("build managed ZLS", { logRoot }, {
        cause: input.signal.reason,
      });
    }
    if (cause instanceof Error) throw cause;
    throw new ZlsBuildError("Managed ZLS build failed", { logRoot }, { cause });
  }
}

export function validateZlsBuildManifest(value: unknown): ZlsBuildManifestV1 {
  const root = strictObject(value, "manifest", [
    "schemaVersion",
    "installationId",
    "recipe",
    "source",
    "hostTarget",
    "paths",
    "command",
    "executable",
    "verified",
  ]);
  equal(
    root.schemaVersion,
    ZLS_BUILD_MANIFEST_SCHEMA_VERSION,
    "manifest.schemaVersion",
  );
  equal(root.verified, true, "manifest.verified");
  const installationId = installationDigest(root.installationId);
  const recipe = validateZlsBuildRecipe(root.recipe, "manifest.recipe");
  const source = validateResolvedZlsSource(root.source, "manifest.source");
  if (canonicalJson(source) !== canonicalJson(recipe.source.resolved)) {
    throw new TypeError("manifest.source must equal manifest.recipe.source.resolved");
  }
  const hostTarget = requiredText(root.hostTarget, "manifest.hostTarget");
  if (hostTarget !== recipe.host.denoTarget) {
    throw new TypeError("manifest.hostTarget must equal manifest.recipe.host.denoTarget");
  }
  const pathsValue = strictObject(root.paths, "manifest.paths", [
    "root",
    "install",
    "cache",
    "executable",
  ]);
  const paths: ZlsBuildPaths = {
    root: normalizedAbsoluteValue(pathsValue.root, "manifest.paths.root"),
    install: normalizedAbsoluteValue(pathsValue.install, "manifest.paths.install"),
    cache: normalizedAbsoluteValue(pathsValue.cache, "manifest.paths.cache"),
    executable: normalizedAbsoluteValue(pathsValue.executable, "manifest.paths.executable"),
  };
  const expectedPaths = buildPaths(paths.root);
  if (canonicalJson(paths) !== canonicalJson(expectedPaths)) {
    throw new TypeError("manifest.paths are not the canonical ZLS build paths");
  }
  const executableValue = strictObject(root.executable, "manifest.executable", [
    "version",
    "size",
    "sha256",
  ]);
  const version = requiredText(executableValue.version, "manifest.executable.version");
  if (version !== source.versionMetadata.versionString) {
    throw new TypeError("manifest.executable.version must equal the exact source version string");
  }
  const command = validateCommand(root.command, "manifest.command");
  const expectedCommand = instantiateBuildCommand(
    recipe,
    command.cwd,
    paths,
    command.executable,
  );
  if (canonicalJson(command) !== canonicalJson(expectedCommand)) {
    throw new TypeError("manifest.command must equal the canonical direct Zig command");
  }
  return {
    schemaVersion: ZLS_BUILD_MANIFEST_SCHEMA_VERSION,
    installationId,
    recipe,
    source,
    hostTarget,
    paths,
    command,
    executable: {
      version,
      size: positiveInteger(executableValue.size, "manifest.executable.size"),
      sha256: digest(executableValue.sha256, "manifest.executable.sha256"),
    },
    verified: true,
  };
}

export async function readZlsBuildManifest(path: string): Promise<ZlsBuildManifestV1> {
  let value: unknown;
  try {
    value = JSON.parse(await Deno.readTextFile(path));
  } catch (cause) {
    throw new ZlsBuildError(`ZLS build manifest could not be read: ${path}`, { path }, { cause });
  }
  try {
    return validateZlsBuildManifest(value);
  } catch (cause) {
    throw new ZlsBuildError(`ZLS build manifest is invalid: ${path}`, { path }, { cause });
  }
}

function assertCurrentContracts(recipe: ZlsBuildRecipeV1): void {
  if (
    recipe.adapter.id !== ZLS_BUILD_RECIPE_ADAPTER_ID ||
    recipe.adapter.buildContractVersion !== ZLS_BUILD_CONTRACT_VERSION ||
    recipe.adapter.verifierContractVersion !== ZLS_INSTALL_VERIFIER_CONTRACT_VERSION
  ) throw new TypeError("ZLS recipe contract does not match this builder and verifier");
}

async function validateZigDependency(
  zig: InstalledObject,
  signal?: AbortSignal,
): Promise<ZlsZigExecutableFingerprint> {
  throwIfAborted(signal, "validate exact Zig dependency");
  if (zig.manifest.component !== "zig" || zig.manifest.dependencies.length !== 0) {
    throw new TypeError("ZLS requires an immutable Zig installation with no dependencies");
  }
  if (zig.manifest.installationId !== installationDigest(zig.manifest.installationId)) {
    throw new TypeError("Zig dependency installation ID is invalid");
  }
  const expectedPath = join(zig.root, ...zig.manifest.paths.executable.split("/"));
  if (resolve(zig.executablePath) !== resolve(expectedPath)) {
    throw new TypeError("Zig dependency executable path does not match its manifest");
  }
  const metadata = await stablePhysicalMetadata(zig.executablePath, "Zig dependency", signal);
  if (
    metadata.size !== zig.manifest.executable.size ||
    metadata.sha256 !== zig.manifest.executable.sha256
  ) throw new TypeError("Zig dependency executable fingerprint does not match its manifest");
  return {
    installPath: zig.manifest.paths.executable,
    size: metadata.size,
    sha256: metadata.sha256,
  };
}

function assertRecipeDependency(
  recipe: ZlsBuildRecipeV1,
  zig: InstalledObject,
  fingerprint: ZlsZigExecutableFingerprint,
): void {
  if (
    recipe.dependencies.length !== 1 ||
    recipe.dependencies[0].installationId !== zig.manifest.installationId ||
    canonicalJson(recipe.zig.executable) !== canonicalJson(fingerprint)
  ) throw new TypeError("ZLS recipe does not name and fingerprint the exact Zig installation");
}

function instantiateBuildCommand(
  recipe: ZlsBuildRecipeV1,
  sourcePath: string,
  paths: ZlsBuildPaths,
  zigExecutable: string,
): InstallCommandRecord {
  const replace = (value: string) =>
    value.replaceAll("$BUILD", paths.root).replaceAll("$ZIG_BIN", dirname(zigExecutable));
  return {
    executable: zigExecutable,
    args: recipe.build.arguments.map(replace),
    cwd: sourcePath,
    env: Object.fromEntries(
      Object.entries(recipe.environment.variables).sort(([left], [right]) => compare(left, right))
        .map(([key, value]) => [key, replace(value)]),
    ),
    clearEnv: true,
  };
}

async function executeLoggedBuild(
  runner: ProcessRunner,
  command: InstallCommandRecord,
  logRoot: string,
  progress: (message: string) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  await writeSyncedTextFile(join(logRoot, "build.command.json"), `${canonicalJson(command, 2)}\n`);
  const stdout = await Deno.open(join(logRoot, "build.stdout.log"), {
    createNew: true,
    write: true,
  });
  let stderr: Deno.FsFile | undefined;
  try {
    stderr = await Deno.open(join(logRoot, "build.stderr.log"), {
      createNew: true,
      write: true,
    });
    await progress(`Running ${basename(command.executable)} build for ZLS...\n`);
    const result = await runner.run({
      ...command,
      signal,
      maxDiagnosticBytes: MAX_BUILD_DIAGNOSTIC_BYTES,
      onStdout: async (chunk) => {
        await writeAll(stdout, chunk);
        await progress(new TextDecoder().decode(chunk));
      },
      onStderr: async (chunk) => {
        await writeAll(stderr!, chunk);
        await progress(new TextDecoder().decode(chunk));
      },
    });
    throwIfAborted(signal, "run ZLS build command");
    if (!result.success || result.signal !== null) {
      throw new ZlsBuildError("Exact Zig command failed while building ZLS", {
        executable: command.executable,
        args: command.args,
        exitCode: result.code,
        signal: result.signal,
        stderr: result.stderr,
        stderrTruncated: result.stderrTruncated,
        logRoot,
      });
    }
    await Promise.all([stdout.sync(), stderr.sync()]);
  } finally {
    stdout.close();
    stderr?.close();
  }
}

async function verifyCachedBuild(
  manifest: ZlsBuildManifestV1,
  recipe: ZlsBuildRecipeV1,
  expectedPaths: ZlsBuildPaths,
  runner: ProcessRunner,
  signal?: AbortSignal,
): Promise<void> {
  if (
    manifest.installationId !== await computeInstallationId(recipe) ||
    canonicalJson(manifest.recipe) !== canonicalJson(recipe) ||
    canonicalJson(manifest.paths) !== canonicalJson(expectedPaths)
  ) throw new ZlsBuildError("Cached ZLS build does not match its canonical recipe");
  await assertPhysicalRegularTree(manifest.paths.install, signal);
  const metadata = await stablePhysicalMetadata(manifest.paths.executable, "cached ZLS", signal);
  if (
    metadata.size !== manifest.executable.size || metadata.sha256 !== manifest.executable.sha256
  ) throw new ZlsBuildError("Cached ZLS executable fingerprint changed");
  await verifyBuiltVersion(
    manifest.paths.executable,
    recipe.source.version.versionString,
    runner,
    verificationEnvironment(manifest.paths.root, manifest.paths.executable),
    manifest.paths.root,
    signal,
  );
}

async function verifyBuiltVersion(
  executable: string,
  expectedVersion: string,
  runner: ProcessRunner,
  env: Readonly<Record<string, string>>,
  cwd: string,
  signal?: AbortSignal,
): Promise<string> {
  const result = await runner.run({
    executable,
    args: ["--version"],
    cwd,
    clearEnv: true,
    env,
    signal,
    maxDiagnosticBytes: MAX_VERSION_OUTPUT_BYTES,
  });
  throwIfAborted(signal, "verify built ZLS version");
  assertBoundedSuccess(result, MAX_VERSION_OUTPUT_BYTES, "'zls --version'");
  const version = result.stdout.trim();
  if (version !== expectedVersion) {
    throw new ZlsBuildError("Built ZLS version does not match its exact source", {
      expectedVersion,
      actualVersion: version,
    });
  }
  return version;
}

function verificationEnvironment(
  root: string,
  executable: string,
): Readonly<Record<string, string>> {
  return {
    CFLAGS: "",
    CXXFLAGS: "",
    CPPFLAGS: "",
    LDFLAGS: "",
    CPATH: "",
    C_INCLUDE_PATH: "",
    CPLUS_INCLUDE_PATH: "",
    LIBRARY_PATH: "",
    CMAKE_PREFIX_PATH: "",
    PKG_CONFIG_PATH: "",
    LANG: "C",
    LC_ALL: "C",
    PATH: dirname(executable),
    HOME: join(root, "home"),
    TMPDIR: join(root, "tmp"),
    XDG_CACHE_HOME: join(root, "cache", "xdg"),
    ZIG_GLOBAL_CACHE_DIR: join(root, "cache", "zig-global"),
    ZIG_LOCAL_CACHE_DIR: join(root, "cache", "zig-local"),
  };
}

async function assertPhysicalRegularTree(root: string, signal?: AbortSignal): Promise<void> {
  await assertPhysicalDirectory(root, "ZLS install output");
  const pending = [root];
  while (pending.length > 0) {
    throwIfAborted(signal, "inspect ZLS install output");
    const directory = pending.pop()!;
    const entries: Deno.DirEntry[] = [];
    for await (const entry of Deno.readDir(directory)) entries.push(entry);
    entries.sort((left, right) => compare(left.name, right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      assertPathContained(root, path);
      const info = await Deno.lstat(path);
      if (info.isSymlink) {
        throw new ZlsBuildError("ZLS install output contains a symlink", { path });
      }
      if (info.isDirectory) pending.push(path);
      else if (!info.isFile) {
        throw new ZlsBuildError("ZLS install output contains a special filesystem entry", { path });
      }
    }
  }
}

async function stablePhysicalMetadata(
  path: string,
  label: string,
  signal?: AbortSignal,
): Promise<{ readonly size: number; readonly sha256: string }> {
  throwIfAborted(signal, `fingerprint ${label}`);
  const normalized = normalizedAbsolute(path, `${label} path`);
  const before = await Deno.lstat(normalized);
  if (!before.isFile || before.isSymlink || before.size < 1) {
    throw new TypeError(`${label} is not a physical regular file: ${normalized}`);
  }
  if (Deno.build.os !== "windows" && before.mode !== null && (before.mode & 0o111) === 0) {
    throw new TypeError(`${label} is not executable: ${normalized}`);
  }
  if (resolve(await Deno.realPath(normalized)) !== normalized) {
    throw new TypeError(`${label} path traverses a symbolic link: ${normalized}`);
  }
  const metadata = await fileMetadata(normalized, signal);
  const after = await Deno.lstat(normalized);
  if (
    !after.isFile || after.isSymlink || before.size !== after.size ||
    before.dev !== null && after.dev !== null && before.dev !== after.dev ||
    before.ino !== null && after.ino !== null && before.ino !== after.ino
  ) throw new TypeError(`${label} changed while it was fingerprinted`);
  return metadata;
}

function buildPaths(rootValue: string): ZlsBuildPaths {
  const root = resolve(rootValue);
  return {
    root,
    install: join(root, "install"),
    cache: join(root, "cache"),
    executable: join(root, "install", "bin", Deno.build.os === "windows" ? "zls.exe" : "zls"),
  };
}

function relocateCommand(
  command: InstallCommandRecord,
  stagingRoot: string,
  finalRoot: string,
): InstallCommandRecord {
  const relocateText = (value: string) => value.replaceAll(stagingRoot, finalRoot);
  return {
    executable: relocateText(command.executable),
    args: command.args.map(relocateText),
    cwd: relocateText(command.cwd),
    env: Object.fromEntries(
      Object.entries(command.env).map(([key, value]) => [key, relocateText(value)]),
    ),
    clearEnv: true,
  };
}

async function createLogRoot(
  base: string,
  root: string,
  operationId: string,
  installationId: string,
): Promise<void> {
  assertOwnedLog(base, root, operationId, installationId);
  await ensurePhysicalDirectory(base);
  await Deno.mkdir(join(base, operationId));
  await Deno.mkdir(root, { recursive: true });
  await assertPhysicalDirectory(root, "ZLS build log root");
}

async function removeReplaceableCacheObject(parent: string, target: string): Promise<void> {
  if (dirname(resolve(target)) !== resolve(parent)) {
    throw new ZlsBuildError("Refused to replace a ZLS build outside its canonical cache parent");
  }
  const info = await Deno.lstat(target);
  await Deno.remove(target, { recursive: info.isDirectory && !info.isSymlink });
}

async function removeOwnedStaging(
  parent: string,
  operationRoot: string,
  stagingRoot: string,
  operationId: string,
  installationId: string,
): Promise<void> {
  assertOwnedStaging(parent, operationRoot, stagingRoot, operationId, installationId);
  try {
    const info = await Deno.lstat(stagingRoot);
    await Deno.remove(stagingRoot, { recursive: info.isDirectory && !info.isSymlink });
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound)) throw cause;
  }
  await removeEmptyDirectory(operationRoot);
}

function assertOwnedStaging(
  parent: string,
  operationRoot: string,
  stagingRoot: string,
  operationId: string,
  installationId: string,
): void {
  operationUuid(operationId);
  installationDigest(installationId);
  const expectedOperation = join(resolve(parent), operationId);
  const expectedStaging = join(expectedOperation, installationId);
  if (
    resolve(operationRoot) !== expectedOperation || resolve(stagingRoot) !== expectedStaging ||
    dirname(expectedOperation) !== resolve(parent) || dirname(expectedStaging) !== expectedOperation
  ) throw new TypeError("ZLS build staging is not owned by the exact operation");
}

function assertOwnedLog(
  base: string,
  root: string,
  operationId: string,
  installationId: string,
): void {
  operationUuid(operationId);
  installationDigest(installationId);
  if (resolve(root) !== join(resolve(base), operationId, "zls", installationId)) {
    throw new TypeError("ZLS build logs are not owned by the exact operation");
  }
}

async function assertPhysicalDirectory(path: string, label = "directory"): Promise<void> {
  const info = await Deno.lstat(path);
  if (!info.isDirectory || info.isSymlink || resolve(await Deno.realPath(path)) !== resolve(path)) {
    throw new TypeError(`${label} is not a physical directory: ${path}`);
  }
}

async function ensurePhysicalDirectory(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
  await assertPhysicalDirectory(resolve(path));
}

function validateCommand(value: unknown, path: string): InstallCommandRecord {
  const root = strictObject(value, path, ["executable", "args", "cwd", "env", "clearEnv"]);
  equal(root.clearEnv, true, `${path}.clearEnv`);
  if (!Array.isArray(root.args) || !root.args.every((item) => typeof item === "string")) {
    throw new TypeError(`${path}.args must be an array of strings`);
  }
  const envValue = looseObject(root.env, `${path}.env`);
  const env: Record<string, string> = {};
  for (const key of Object.keys(envValue).sort(compare)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof envValue[key] !== "string") {
      throw new TypeError(`${path}.env is invalid`);
    }
    env[key] = envValue[key] as string;
  }
  return {
    executable: normalizedAbsoluteValue(root.executable, `${path}.executable`),
    args: [...root.args] as string[],
    cwd: normalizedAbsoluteValue(root.cwd, `${path}.cwd`),
    env,
    clearEnv: true,
  };
}

function assertBoundedSuccess(result: ProcessResult, maximum: number, operation: string): void {
  if (
    !result.success || result.signal !== null || result.stdoutTruncated || result.stderrTruncated ||
    byteLength(result.stdout) > maximum || byteLength(result.stderr) > maximum
  ) {
    throw new ZlsBuildError(`${operation} failed or exceeded its output bound`, {
      exitCode: result.code,
      signal: result.signal,
      stderr: result.stderr,
      maximum,
    });
  }
}

function strictObject(
  value: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> {
  const root = looseObject(value, path);
  const unknown = Object.keys(root).filter((key) => !keys.includes(key)).sort(compare);
  if (unknown.length > 0) throw new TypeError(`${path} contains unknown key '${unknown[0]}'`);
  for (const key of keys) if (!(key in root)) throw new TypeError(`${path}.${key} is required`);
  return root;
}

function looseObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || hasControl(value)) {
    throw new TypeError(`${path} must be nonempty text without control characters`);
  }
  return value;
}

function normalizedAbsoluteValue(value: unknown, path: string): string {
  return normalizedAbsolute(requiredText(value, path), path);
}

function normalizedAbsolute(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new TypeError(`${label} must be an absolute normalized path`);
  }
  return path;
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${path} must be a positive safe integer`);
  }
  return value as number;
}

function digest(value: unknown, path: string): string {
  const result = requiredText(value, path);
  if (!INSTALLATION_ID.test(result)) throw new TypeError(`${path} must be a SHA-256 digest`);
  return result;
}

function installationDigest(value: unknown): string {
  return digest(value, "installationId");
}

function operationUuid(value: unknown): string {
  const result = requiredText(value, "operationId");
  if (!OPERATION_ID.test(result)) throw new TypeError("operationId must be a canonical UUID");
  return result;
}

function equal(actual: unknown, expected: unknown, path: string): void {
  if (actual !== expected) throw new TypeError(`${path} must equal ${String(expected)}`);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hasControl(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || code >= 0x7f && code <= 0x9f) return true;
  }
  return false;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
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

async function writeAll(file: Deno.FsFile, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) offset += await file.write(bytes.subarray(offset));
}

async function removeEmptyDirectory(path: string): Promise<void> {
  try {
    for await (const _entry of Deno.readDir(path)) return;
    await Deno.remove(path);
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound)) throw cause;
  }
}

function throwIfAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted) {
    throw new ZigOperationAbortedError(operation, {}, { cause: signal.reason });
  }
}
