import { dirname, isAbsolute, join, resolve } from "@std/path";
import {
  BUILD_RECIPE_ENVIRONMENT_KEYS,
  BUILD_RECIPE_TOOL_KEYS,
  type BuildRecipeFileFingerprint,
  type BuildRecipePackageFingerprint,
  type BuildRecipeQueryRecord,
  type BuildRecipeToolFingerprint,
  type BuildRecipeToolKey,
  validateZigBuildRecipe,
  type ZigBuildRecipeV1,
} from "./build_recipe.ts";
import { ZigOperationAbortedError } from "./errors.ts";
import { canonicalJson, fileMetadata, sha256Text } from "./filesystem.ts";
import type { ResolvedSource } from "./install_store.ts";
import type {
  ReleaseAdapter,
  ReleaseGeneratorRequirement,
  ReleaseToolRequirement,
} from "./release_adapter.ts";
import type { ToolchainHostIdentity } from "./profile_store.ts";
import type {
  BuildArtifactPaths,
  BuildToolchain,
  ProcessResult,
  ProcessRunner,
  ResolvedZigManagerConfig,
  ToolProbeResult,
  ZigSourceVersion,
} from "./types.ts";

const MAX_QUERY_BYTES = 256 * 1024;
const PACMAN = "/usr/bin/pacman";

export interface PrepareZigBuildRecipeInput {
  readonly source: ResolvedSource;
  readonly sourceVersion: ZigSourceVersion;
  readonly adapter: ReleaseAdapter;
  readonly host: ToolchainHostIdentity;
  readonly config: ResolvedZigManagerConfig;
  readonly toolchain: BuildToolchain;
  readonly runner: ProcessRunner;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
  readonly profile?: Parameters<ReleaseAdapter["normalizeBuildOptions"]>[1];
  readonly jobs?: number;
  readonly signal?: AbortSignal;
}

export interface PreparedZigBuildRecipe {
  readonly recipe: ZigBuildRecipeV1;
  readonly installationId: string;
  readonly toolchain: BuildToolchain;
}

/** Resolve and fingerprint every physical build input before configure can run. */
export async function prepareZigBuildRecipe(
  input: PrepareZigBuildRecipeInput,
): Promise<PreparedZigBuildRecipe> {
  throwIfAborted(input.signal);
  if (input.source.component !== "zig") {
    throw new TypeError("Zig recipe source component is invalid");
  }
  if (canonicalJson(input.source.versionMetadata) !== canonicalJson(input.sourceVersion)) {
    throw new TypeError("resolved source version metadata changed before recipe preparation");
  }
  if (!input.adapter.supports(input.sourceVersion)) {
    throw new TypeError(`adapter '${input.adapter.id}' does not support the exact source version`);
  }
  let options = input.adapter.normalizeBuildOptions(
    input.config,
    input.profile,
    input.jobs,
    input.toolchain.cmakePrefixPath,
  );
  const probes = toolProbes(input.toolchain);
  const physicalPaths = {} as Record<BuildRecipeToolKey, string>;
  for (const key of BUILD_RECIPE_TOOL_KEYS) {
    throwIfAborted(input.signal);
    physicalPaths[key] = await resolvePhysicalExecutable(
      probes[key].executable,
      input.env.PATH ?? "",
      input.cwd,
      `build tool ${key}`,
      input.signal,
    );
  }
  const fixedPath = unique(BUILD_RECIPE_TOOL_KEYS.map((key) => dirname(physicalPaths[key]))).join(
    ":",
  );
  const queryEnvironment = { LANG: "C", LC_ALL: "C", PATH: fixedPath };
  const tools = {} as Record<BuildRecipeToolKey, BuildRecipeToolFingerprint>;
  for (const key of BUILD_RECIPE_TOOL_KEYS) {
    throwIfAborted(input.signal);
    const requirement = toolRequirement(input.adapter, key, options.generator);
    tools[key] = await fingerprintTool(
      physicalPaths[key],
      probes[key],
      requirement,
      key,
      input.runner,
      queryEnvironment,
      input.signal,
    );
  }

  const llvmQueries = new Map(
    tools.llvmConfig.queries.map((query) => [canonicalJson(query.args), query]),
  );
  const includeDir = queryValue(llvmQueries, ["--includedir"], "LLVM include directory");
  const libDir = queryValue(llvmQueries, ["--libdir"], "LLVM library directory");
  const prefix = queryValue(llvmQueries, ["--prefix"], "LLVM prefix");
  if (resolve(prefix) !== resolve(options.cmakePrefixPath)) {
    throw new TypeError("normalized CMake prefix differs from the physical llvm-config prefix");
  }
  options = { ...options, cmakePrefixPath: resolve(prefix) };
  const developmentFiles = await fingerprintDevelopmentFiles(
    includeDir,
    libDir,
    input.adapter,
    input.signal,
  );
  const packageNames = unique([
    ...input.adapter.requirements.developmentFiles.headers.flatMap((item) => item.archPackages),
    ...input.adapter.requirements.developmentFiles.libraries.flatMap((item) => item.archPackages),
  ]).sort(compare);
  const packages: BuildRecipePackageFingerprint[] = [];
  for (const name of packageNames) {
    throwIfAborted(input.signal);
    const query = await runQuery(
      input.runner,
      PACMAN,
      ["-Q", name],
      queryEnvironment,
      input.signal,
    );
    const line = query.stdout.trim();
    const match = /^([^\s]+)\s+([^\s]+)$/.exec(line);
    if (match === null || match[1] !== name) {
      throw new TypeError(
        `pacman did not return an exact installed package fingerprint for ${name}`,
      );
    }
    packages.push({ name, version: match[2], query });
  }

  const physicalToolchain: BuildToolchain = {
    cmake: withExecutable(input.toolchain.cmake, physicalPaths.cmake),
    cCompiler: withExecutable(input.toolchain.cCompiler, physicalPaths.cCompiler),
    cxxCompiler: withExecutable(input.toolchain.cxxCompiler, physicalPaths.cxxCompiler),
    llvmConfig: withExecutable(input.toolchain.llvmConfig, physicalPaths.llvmConfig),
    clang: withExecutable(input.toolchain.clang, physicalPaths.clang),
    lld: withExecutable(input.toolchain.lld, physicalPaths.lld),
    generatorTool: withExecutable(requiredGenerator(input.toolchain), physicalPaths.generatorTool),
    cmakePrefixPath: resolve(prefix),
    llvmIncludeDir: resolve(includeDir),
    llvmLibDir: resolve(libDir),
  };
  const templates = input.adapter.createBuildCommands({
    platform: "linux",
    sourcePath: "$SOURCE",
    version: input.sourceVersion,
    paths: placeholderBuildPaths(),
    options,
    toolchain: physicalToolchain,
  });
  if (templates.length !== 2) {
    throw new TypeError("Zig build adapter must produce configure and build commands");
  }
  const variables = Object.fromEntries(
    BUILD_RECIPE_ENVIRONMENT_KEYS.map((key) => [key, ""]),
  ) as Record<
    string,
    string
  >;
  Object.assign(variables, {
    LANG: "C",
    LC_ALL: "C",
    PATH: fixedPath,
    HOME: "$BUILD/home",
    TMPDIR: "$BUILD/tmp",
    XDG_CACHE_HOME: "$BUILD/cache/xdg",
    ZIG_GLOBAL_CACHE_DIR: "$BUILD/cache/zig-global",
    ZIG_LOCAL_CACHE_DIR: "$BUILD/cache/zig-local",
  });
  const recipe = validateZigBuildRecipe({
    schemaVersion: 1,
    component: "zig",
    source: {
      repository: input.source.repository,
      commit: input.source.commit,
      version: input.sourceVersion,
    },
    adapter: {
      id: input.adapter.id,
      buildContractVersion: input.adapter.buildContractVersion,
      verifierContractVersion: input.adapter.verifierContractVersion,
    },
    host: input.host,
    cpuPolicy: options.cpu,
    build: options,
    cmake: {
      configureArguments: templates[0].args,
      buildArguments: templates[1].args,
    },
    environment: { clearEnv: true, inherited: [], variables },
    tools,
    development: { files: developmentFiles, packages },
    dependencies: [],
  });
  throwIfAborted(input.signal);
  return {
    recipe,
    installationId: await sha256Text(canonicalJson(recipe)),
    toolchain: physicalToolchain,
  };
}

async function fingerprintTool(
  path: string,
  probe: ToolProbeResult,
  requirement: ReleaseToolRequirement | ReleaseGeneratorRequirement,
  key: BuildRecipeToolKey,
  runner: ProcessRunner,
  env: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<BuildRecipeToolFingerprint> {
  if (!probe.available || !probe.supported || probe.version === null) {
    throw new TypeError(`build tool ${key} is not ready for identity fingerprinting`);
  }
  const queryArgs: string[][] = [[...requirement.arguments]];
  if (key === "cmake") queryArgs.push(["--help"]);
  if (key === "llvmConfig") {
    queryArgs.push(["--includedir"], ["--libdir"], ["--prefix"], ["--targets-built"]);
  }
  queryArgs.sort((left, right) => compare(canonicalJson(left), canonicalJson(right)));
  const queries: BuildRecipeQueryRecord[] = [];
  for (const args of queryArgs) queries.push(await runQuery(runner, path, args, env, signal));
  const versionQuery = queries.find((query) =>
    canonicalJson(query.args) === canonicalJson(requirement.arguments)
  );
  if (versionQuery === undefined) throw new TypeError(`build tool ${key} version query is missing`);
  const parsed = requirement.parseVersion(`${versionQuery.stdout}\n${versionQuery.stderr}`);
  if (parsed === null || parsed !== probe.version || !requirement.acceptsVersion(parsed)) {
    throw new TypeError(`build tool ${key} changed between diagnostics and recipe preparation`);
  }
  const metadata = await stablePhysicalFileMetadata(path, `build tool ${key}`, signal);
  return { path, version: parsed, ...metadata, queries };
}

async function fingerprintDevelopmentFiles(
  includeDirValue: string,
  libDirValue: string,
  adapter: ReleaseAdapter,
  signal?: AbortSignal,
): Promise<BuildRecipeFileFingerprint[]> {
  throwIfAborted(signal);
  const includeDir = await physicalDirectory(includeDirValue, "LLVM include directory", signal);
  const libDir = await physicalDirectory(libDirValue, "LLVM library directory", signal);
  const paths: string[] = [];
  for (const header of adapter.requirements.developmentFiles.headers) {
    paths.push(join(includeDir, ...header.relativePath.split("/")));
  }
  const entries: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(libDir)) {
    throwIfAborted(signal);
    entries.push(entry);
  }
  entries.sort((left, right) => compare(left.name, right.name));
  for (const requirement of adapter.requirements.developmentFiles.libraries) {
    const matches: string[] = [];
    for (const entry of entries) {
      throwIfAborted(signal);
      requirement.namePattern.lastIndex = 0;
      if (!requirement.namePattern.test(entry.name)) continue;
      const candidate = join(libDir, entry.name);
      try {
        const physical = resolve(await Deno.realPath(candidate));
        const info = await Deno.lstat(physical);
        if (info.isFile && !info.isSymlink && info.size > 0) matches.push(physical);
      } catch (cause) {
        if (cause instanceof ZigOperationAbortedError) throw cause;
      }
    }
    if (matches.length === 0) {
      throw new TypeError(`no physical development file matched ${requirement.component}`);
    }
    paths.push(...matches);
  }
  const uniquePaths = unique(paths.map((path) => resolve(path))).sort(compare);
  const result: BuildRecipeFileFingerprint[] = [];
  for (const path of uniquePaths) {
    throwIfAborted(signal);
    result.push({ path, ...await stablePhysicalFileMetadata(path, "development file", signal) });
  }
  return result;
}

async function runQuery(
  runner: ProcessRunner,
  executable: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  signal?: AbortSignal,
): Promise<BuildRecipeQueryRecord> {
  const result = await runner.run({
    executable,
    args,
    clearEnv: true,
    env,
    signal,
    maxDiagnosticBytes: MAX_QUERY_BYTES,
  });
  assertBoundedSuccess(result, executable, args);
  return { args: [...args], stdout: result.stdout, stderr: result.stderr };
}

function assertBoundedSuccess(
  result: ProcessResult,
  executable: string,
  args: readonly string[],
): void {
  if (
    !result.success || result.stdoutTruncated || result.stderrTruncated ||
    byteLength(result.stdout) > MAX_QUERY_BYTES || byteLength(result.stderr) > MAX_QUERY_BYTES
  ) throw new TypeError(`required adapter query failed: ${executable} ${args.join(" ")}`);
}

async function resolvePhysicalExecutable(
  candidate: string,
  capturedPath: string,
  cwd: string,
  label: string,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  if (candidate.length === 0 || candidate.includes("\0")) throw new TypeError(`${label} is empty`);
  const candidates: string[] = [];
  if (candidate.includes("/")) {
    candidates.push(isAbsolute(candidate) ? candidate : resolve(cwd, candidate));
  } else {
    for (const entry of capturedPath.split(":")) {
      const directory = entry.length === 0 ? cwd : isAbsolute(entry) ? entry : resolve(cwd, entry);
      candidates.push(join(directory, candidate));
    }
  }
  for (const path of candidates) {
    throwIfAborted(signal);
    try {
      const physical = resolve(await Deno.realPath(path));
      const info = await Deno.lstat(physical);
      if (
        info.isFile && !info.isSymlink && info.size > 0 &&
        (info.mode === null || (info.mode & 0o111) !== 0)
      ) return physical;
    } catch (cause) {
      if (
        !(cause instanceof Deno.errors.NotFound) && !(cause instanceof Deno.errors.NotADirectory)
      ) {
        throw cause;
      }
    }
  }
  throw new TypeError(`${label} cannot be resolved to a physical regular executable`);
}

async function stablePhysicalFileMetadata(
  path: string,
  label: string,
  signal?: AbortSignal,
): Promise<{ readonly size: number; readonly sha256: string }> {
  throwIfAborted(signal);
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new TypeError(`${label} path is not normalized`);
  }
  const before = await Deno.lstat(path);
  if (!before.isFile || before.isSymlink || before.size < 1) {
    throw new TypeError(`${label} is not a physical regular file: ${path}`);
  }
  const metadata = await fileMetadata(path, signal);
  throwIfAborted(signal);
  const after = await Deno.lstat(path);
  if (
    !after.isFile || after.isSymlink || before.size !== after.size ||
    before.dev !== null && after.dev !== null && before.dev !== after.dev ||
    before.ino !== null && after.ino !== null && before.ino !== after.ino
  ) throw new TypeError(`${label} changed while it was fingerprinted: ${path}`);
  return metadata;
}

async function physicalDirectory(
  pathValue: string,
  label: string,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  if (!isAbsolute(pathValue)) throw new TypeError(`${label} is not absolute`);
  const physical = resolve(await Deno.realPath(pathValue));
  const info = await Deno.lstat(physical);
  if (!info.isDirectory || info.isSymlink) throw new TypeError(`${label} is not physical`);
  return physical;
}

function queryValue(
  queries: ReadonlyMap<string, BuildRecipeQueryRecord>,
  args: readonly string[],
  label: string,
): string {
  const value = queries.get(canonicalJson(args))?.stdout.trim();
  if (value === undefined || value.length === 0 || !isAbsolute(value)) {
    throw new TypeError(`${label} query did not return an absolute path`);
  }
  return value;
}

function toolProbes(toolchain: BuildToolchain): Record<BuildRecipeToolKey, ToolProbeResult> {
  return {
    cmake: toolchain.cmake,
    cCompiler: toolchain.cCompiler,
    cxxCompiler: toolchain.cxxCompiler,
    llvmConfig: toolchain.llvmConfig,
    clang: toolchain.clang,
    lld: toolchain.lld,
    generatorTool: requiredGenerator(toolchain),
  };
}

function requiredGenerator(toolchain: BuildToolchain): ToolProbeResult {
  if (toolchain.generatorTool === null) throw new TypeError("build generator tool is required");
  return toolchain.generatorTool;
}

function toolRequirement(
  adapter: ReleaseAdapter,
  key: BuildRecipeToolKey,
  generator: string,
): ReleaseToolRequirement | ReleaseGeneratorRequirement {
  if (key === "generatorTool") {
    const requirement = adapter.requirements.generators[generator];
    if (requirement === undefined) {
      throw new TypeError(`adapter has no generator contract for ${generator}`);
    }
    return requirement;
  }
  return adapter.requirements.tools[key];
}

function withExecutable(probe: ToolProbeResult, executable: string): ToolProbeResult {
  return { ...probe, executable };
}

function placeholderBuildPaths(): BuildArtifactPaths {
  return {
    root: "$BUILD",
    cmakeBuild: "$BUILD/cmake-build",
    install: "$BUILD/install",
    cache: "$BUILD/cache",
    logs: "$BUILD/logs",
    executable: "$BUILD/install/bin/zig",
    lib: "$BUILD/install/lib/zig",
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ZigOperationAbortedError("prepare canonical Zig build recipe", {}, {
      cause: signal.reason,
    });
  }
}
