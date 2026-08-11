import { dirname, isAbsolute, resolve } from "@std/path";

export const CANONICAL_ZIG_REPOSITORY_URL = "https://codeberg.org/ziglang/zig.git";
export const GLOBAL_CONFIG_MAX_BYTES = 1024 * 1024;

export type GlobalBuildProfile = "debug" | "release" | "relwithdebinfo" | "minsizerel";
export type GlobalCpuPolicy = "baseline" | "native";

export interface GlobalBuildConfig {
  readonly profile: GlobalBuildProfile;
  readonly generator: string;
  readonly jobs: number | null;
  readonly cpu: GlobalCpuPolicy;
  readonly cmakePrefixPath: string | null;
}

export interface GlobalToolConfig {
  readonly cmake: string | null;
  readonly cCompiler: string | null;
  readonly cxxCompiler: string | null;
  readonly llvmConfig: string | null;
  readonly clang: string | null;
  readonly lld: string | null;
  readonly generatorTool: string | null;
}

export interface GlobalWarningConfig {
  readonly cacheBytes: number | null;
  readonly movingSelectorMaxAgeHours: number;
}

/** Fully resolved global defaults. This format never contains an active toolchain selection. */
export interface GlobalConfig {
  readonly zigRepository: string;
  readonly build: GlobalBuildConfig;
  readonly tools: GlobalToolConfig;
  readonly warnings: GlobalWarningConfig;
}

export interface GlobalBuildConfigDocument {
  readonly profile?: GlobalBuildProfile;
  readonly generator?: string;
  readonly jobs?: number | null;
  readonly cpu?: GlobalCpuPolicy;
  readonly cmakePrefixPath?: string | null;
}

export interface GlobalToolConfigDocument {
  readonly cmake?: string | null;
  readonly cCompiler?: string | null;
  readonly cxxCompiler?: string | null;
  readonly llvmConfig?: string | null;
  readonly clang?: string | null;
  readonly lld?: string | null;
  readonly generatorTool?: string | null;
}

export interface GlobalWarningConfigDocument {
  readonly cacheBytes?: number | null;
  readonly movingSelectorMaxAgeHours?: number;
}

/** Strict, partial on-disk document. Omitted values receive {@link DEFAULT_GLOBAL_CONFIG}. */
export interface GlobalConfigDocument {
  readonly $schema?: string;
  readonly zigRepository?: string;
  readonly build?: GlobalBuildConfigDocument;
  readonly tools?: GlobalToolConfigDocument;
  readonly warnings?: GlobalWarningConfigDocument;
}

export type GlobalConfigEnvironment = Readonly<Record<string, string | undefined>>;

export interface GlobalConfigStoreOptions {
  /** Absolute or current-working-directory-relative path to the optional JSON document. */
  readonly configPath?: string;
  /** Alias useful when passing a path object field directly. */
  readonly path?: string;
  /** A captured environment map. The store never reads Deno.env implicitly. */
  readonly env?: GlobalConfigEnvironment;
}

export const GLOBAL_CONFIG_ENV = Object.freeze(
  {
    zigRepository: "ZIG_MANAGER_ZIG_REPOSITORY",
    buildProfile: "ZIG_MANAGER_BUILD_PROFILE",
    buildGenerator: "ZIG_MANAGER_BUILD_GENERATOR",
    buildJobs: "ZIG_MANAGER_BUILD_JOBS",
    buildCpu: "ZIG_MANAGER_BUILD_CPU",
    cmakePrefixPath: "ZIG_MANAGER_CMAKE_PREFIX_PATH",
    cmake: "ZIG_MANAGER_CMAKE",
    cCompiler: "ZIG_MANAGER_CC",
    cxxCompiler: "ZIG_MANAGER_CXX",
    llvmConfig: "ZIG_MANAGER_LLVM_CONFIG",
    clang: "ZIG_MANAGER_CLANG",
    lld: "ZIG_MANAGER_LLD",
    generatorTool: "ZIG_MANAGER_GENERATOR_TOOL",
    warningCacheBytes: "ZIG_MANAGER_WARNING_CACHE_BYTES",
    movingSelectorMaxAgeHours: "ZIG_MANAGER_MOVING_SELECTOR_MAX_AGE_HOURS",
  } as const,
);

export const DEFAULT_GLOBAL_CONFIG: GlobalConfig = Object.freeze({
  zigRepository: CANONICAL_ZIG_REPOSITORY_URL,
  build: Object.freeze({
    profile: "release",
    generator: "Ninja",
    jobs: null,
    cpu: "baseline",
    cmakePrefixPath: null,
  }),
  tools: Object.freeze({
    cmake: null,
    cCompiler: null,
    cxxCompiler: null,
    llvmConfig: null,
    clang: null,
    lld: null,
    generatorTool: null,
  }),
  warnings: Object.freeze({
    cacheBytes: null,
    movingSelectorMaxAgeHours: 24,
  }),
});

export class GlobalConfigValidationError extends TypeError {
  readonly configPath: string;
  readonly reason: string;

  constructor(configPath: string, reason: string, options?: ErrorOptions) {
    super(`Invalid global zig-manager configuration '${configPath}': ${reason}`, options);
    this.name = "GlobalConfigValidationError";
    this.configPath = configPath;
    this.reason = reason;
  }
}

/** Resolve a strict document and captured environment without performing filesystem access. */
export function resolveGlobalConfig(
  value: unknown = {},
  env: GlobalConfigEnvironment = {},
): GlobalConfig {
  const document = validateGlobalConfigDocument(value);
  const build = document.build ?? {};
  const tools = document.tools ?? {};
  const warnings = document.warnings ?? {};

  const zigRepository = environmentUrl(env, GLOBAL_CONFIG_ENV.zigRepository) ??
    document.zigRepository ?? DEFAULT_GLOBAL_CONFIG.zigRepository;
  const profile = environmentProfile(env, GLOBAL_CONFIG_ENV.buildProfile) ??
    build.profile ?? DEFAULT_GLOBAL_CONFIG.build.profile;
  const generator = environmentText(env, GLOBAL_CONFIG_ENV.buildGenerator) ??
    build.generator ?? DEFAULT_GLOBAL_CONFIG.build.generator;
  const jobs = environmentPositiveInteger(env, GLOBAL_CONFIG_ENV.buildJobs) ??
    build.jobs ?? DEFAULT_GLOBAL_CONFIG.build.jobs;
  const cpu = environmentCpuPolicy(env, GLOBAL_CONFIG_ENV.buildCpu) ??
    build.cpu ?? DEFAULT_GLOBAL_CONFIG.build.cpu;
  const cmakePrefixPath = environmentText(env, GLOBAL_CONFIG_ENV.cmakePrefixPath) ??
    build.cmakePrefixPath ?? DEFAULT_GLOBAL_CONFIG.build.cmakePrefixPath;

  return {
    zigRepository,
    build: { profile, generator, jobs, cpu, cmakePrefixPath },
    tools: {
      cmake: environmentText(env, GLOBAL_CONFIG_ENV.cmake) ??
        tools.cmake ?? DEFAULT_GLOBAL_CONFIG.tools.cmake,
      cCompiler: environmentText(env, GLOBAL_CONFIG_ENV.cCompiler) ??
        environmentText(env, "CC") ?? tools.cCompiler ?? DEFAULT_GLOBAL_CONFIG.tools.cCompiler,
      cxxCompiler: environmentText(env, GLOBAL_CONFIG_ENV.cxxCompiler) ??
        environmentText(env, "CXX") ?? tools.cxxCompiler ?? DEFAULT_GLOBAL_CONFIG.tools.cxxCompiler,
      llvmConfig: environmentText(env, GLOBAL_CONFIG_ENV.llvmConfig) ??
        tools.llvmConfig ?? DEFAULT_GLOBAL_CONFIG.tools.llvmConfig,
      clang: environmentText(env, GLOBAL_CONFIG_ENV.clang) ??
        tools.clang ?? DEFAULT_GLOBAL_CONFIG.tools.clang,
      lld: environmentText(env, GLOBAL_CONFIG_ENV.lld) ??
        tools.lld ?? DEFAULT_GLOBAL_CONFIG.tools.lld,
      generatorTool: environmentText(env, GLOBAL_CONFIG_ENV.generatorTool) ??
        tools.generatorTool ?? DEFAULT_GLOBAL_CONFIG.tools.generatorTool,
    },
    warnings: {
      cacheBytes: environmentNonnegativeInteger(env, GLOBAL_CONFIG_ENV.warningCacheBytes) ??
        warnings.cacheBytes ?? DEFAULT_GLOBAL_CONFIG.warnings.cacheBytes,
      movingSelectorMaxAgeHours: environmentPositiveNumber(
        env,
        GLOBAL_CONFIG_ENV.movingSelectorMaxAgeHours,
      ) ?? warnings.movingSelectorMaxAgeHours ??
        DEFAULT_GLOBAL_CONFIG.warnings.movingSelectorMaxAgeHours,
    },
  };
}

/** Validate and normalize the exact persisted shape without applying defaults or environment. */
export function validateGlobalConfigDocument(value: unknown): GlobalConfigDocument {
  const root = strictObject(value, "root", [
    "$schema",
    "zigRepository",
    "build",
    "tools",
    "warnings",
  ]);

  const schema = hasOwn(root, "$schema")
    ? { $schema: validateHttpsUrl(root.$schema, "$schema") }
    : {};
  const repository = hasOwn(root, "zigRepository")
    ? { zigRepository: validateRepositoryUrl(root.zigRepository, "zigRepository") }
    : {};
  const build = hasOwn(root, "build") ? { build: validateBuildDocument(root.build) } : {};
  const tools = hasOwn(root, "tools") ? { tools: validateToolDocument(root.tools) } : {};
  const warnings = hasOwn(root, "warnings")
    ? { warnings: validateWarningDocument(root.warnings) }
    : {};
  return { ...schema, ...repository, ...build, ...tools, ...warnings };
}

/** Optional global configuration store with an injected path and captured environment. */
export class GlobalConfigStore {
  readonly path: string;
  readonly configPath: string;
  readonly #env: GlobalConfigEnvironment;

  constructor(input: string | GlobalConfigStoreOptions, env: GlobalConfigEnvironment = {}) {
    const options = typeof input === "string" ? { configPath: input, env } : input;
    if (options.configPath !== undefined && options.path !== undefined) {
      throw new TypeError("provide only one of configPath or path");
    }
    const suppliedPath = options.configPath ?? options.path;
    if (suppliedPath === undefined) throw new TypeError("global config path is required");
    this.path = normalizeFilePath(suppliedPath, "global config path");
    this.configPath = this.path;
    this.#env = Object.freeze({ ...(options.env ?? {}) });
  }

  async load(): Promise<GlobalConfig> {
    try {
      const parent = dirname(this.path);
      const parentInfo = await lstatIfPresent(parent);
      if (parentInfo === null) return this.#resolve({});
      await assertPhysicalDirectory(parent, parentInfo, "global config parent");

      const info = await lstatIfPresent(this.path);
      if (info === null) return this.#resolve({});
      if (!info.isFile || info.isSymlink) {
        throw new GlobalConfigValidationError(
          this.path,
          "configuration path is not a physical file",
        );
      }
      if (info.size > GLOBAL_CONFIG_MAX_BYTES) {
        throw new GlobalConfigValidationError(
          this.path,
          `configuration exceeds ${GLOBAL_CONFIG_MAX_BYTES} bytes`,
        );
      }

      let value: unknown;
      try {
        value = JSON.parse(await Deno.readTextFile(this.path));
      } catch (cause) {
        throw new GlobalConfigValidationError(this.path, "file is not valid readable JSON", {
          cause,
        });
      }
      return this.#resolve(value);
    } catch (cause) {
      throw this.#validationError(cause);
    }
  }

  /** Validate first, then flush a temporary sibling and atomically replace the document. */
  async write(value: unknown): Promise<GlobalConfig> {
    let document: GlobalConfigDocument;
    try {
      document = validateGlobalConfigDocument(value);
    } catch (cause) {
      throw this.#validationError(cause);
    }
    const text = `${JSON.stringify(document, null, 2)}\n`;
    if (new TextEncoder().encode(text).byteLength > GLOBAL_CONFIG_MAX_BYTES) {
      throw new GlobalConfigValidationError(
        this.path,
        `configuration exceeds ${GLOBAL_CONFIG_MAX_BYTES} bytes`,
      );
    }
    try {
      await ensurePhysicalDirectoryTree(dirname(this.path));
      const current = await lstatIfPresent(this.path);
      if (current !== null && (!current.isFile || current.isSymlink)) {
        throw new GlobalConfigValidationError(
          this.path,
          "existing configuration path is not a physical file",
        );
      }
      await writeTextAtomically(this.path, text);
    } catch (cause) {
      throw this.#validationError(cause);
    }
    return resolveGlobalConfig(document, this.#env);
  }

  #resolve(value: unknown): GlobalConfig {
    try {
      return resolveGlobalConfig(value, this.#env);
    } catch (cause) {
      throw this.#validationError(cause);
    }
  }

  #validationError(cause: unknown): GlobalConfigValidationError {
    if (cause instanceof GlobalConfigValidationError) return cause;
    return new GlobalConfigValidationError(this.path, errorMessage(cause), { cause });
  }
}

export async function loadGlobalConfig(
  input: string | GlobalConfigStoreOptions,
  env: GlobalConfigEnvironment = {},
): Promise<GlobalConfig> {
  return await new GlobalConfigStore(input, env).load();
}

function validateBuildDocument(value: unknown): GlobalBuildConfigDocument {
  const root = strictObject(value, "build", [
    "profile",
    "generator",
    "jobs",
    "cpu",
    "cmakePrefixPath",
  ]);
  return {
    ...(hasOwn(root, "profile") ? { profile: buildProfile(root.profile, "build.profile") } : {}),
    ...(hasOwn(root, "generator") ? { generator: text(root.generator, "build.generator") } : {}),
    ...(hasOwn(root, "jobs") ? { jobs: nullablePositiveInteger(root.jobs, "build.jobs") } : {}),
    ...(hasOwn(root, "cpu") ? { cpu: cpuPolicy(root.cpu, "build.cpu") } : {}),
    ...(hasOwn(root, "cmakePrefixPath")
      ? { cmakePrefixPath: nullableText(root.cmakePrefixPath, "build.cmakePrefixPath") }
      : {}),
  };
}

function validateToolDocument(value: unknown): GlobalToolConfigDocument {
  const keys = [
    "cmake",
    "cCompiler",
    "cxxCompiler",
    "llvmConfig",
    "clang",
    "lld",
    "generatorTool",
  ] as const;
  const root = strictObject(value, "tools", keys);
  const result: Record<string, string | null> = {};
  for (const key of keys) {
    if (hasOwn(root, key)) result[key] = nullableText(root[key], `tools.${key}`);
  }
  return result;
}

function validateWarningDocument(value: unknown): GlobalWarningConfigDocument {
  const root = strictObject(value, "warnings", [
    "cacheBytes",
    "movingSelectorMaxAgeHours",
  ]);
  return {
    ...(hasOwn(root, "cacheBytes")
      ? { cacheBytes: nullableNonnegativeInteger(root.cacheBytes, "warnings.cacheBytes") }
      : {}),
    ...(hasOwn(root, "movingSelectorMaxAgeHours")
      ? {
        movingSelectorMaxAgeHours: positiveNumber(
          root.movingSelectorMaxAgeHours,
          "warnings.movingSelectorMaxAgeHours",
        ),
      }
      : {}),
  };
}

function environmentText(
  env: GlobalConfigEnvironment,
  name: string,
): string | undefined {
  const value = env[name];
  return value === undefined ? undefined : text(value, `environment ${name}`);
}

function environmentUrl(
  env: GlobalConfigEnvironment,
  name: string,
): string | undefined {
  const value = env[name];
  return value === undefined ? undefined : validateRepositoryUrl(value, `environment ${name}`);
}

function environmentProfile(
  env: GlobalConfigEnvironment,
  name: string,
): GlobalBuildProfile | undefined {
  const value = env[name];
  return value === undefined ? undefined : buildProfile(value, `environment ${name}`);
}

function environmentCpuPolicy(
  env: GlobalConfigEnvironment,
  name: string,
): GlobalCpuPolicy | undefined {
  const value = env[name];
  return value === undefined ? undefined : cpuPolicy(value, `environment ${name}`);
}

function environmentPositiveInteger(
  env: GlobalConfigEnvironment,
  name: string,
): number | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new TypeError(`environment ${name} must be a positive integer`);
  }
  return positiveInteger(Number(value), `environment ${name}`);
}

function environmentNonnegativeInteger(
  env: GlobalConfigEnvironment,
  name: string,
): number | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError(`environment ${name} must be a nonnegative integer`);
  }
  return nonnegativeInteger(Number(value), `environment ${name}`);
}

function environmentPositiveNumber(
  env: GlobalConfigEnvironment,
  name: string,
): number | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  if (value.length === 0 || value.trim() !== value) {
    throw new TypeError(`environment ${name} must be a positive number`);
  }
  return positiveNumber(Number(value), `environment ${name}`);
}

function buildProfile(value: unknown, path: string): GlobalBuildProfile {
  if (
    value !== "debug" && value !== "release" && value !== "relwithdebinfo" &&
    value !== "minsizerel"
  ) {
    throw new TypeError(`${path} must be debug, release, relwithdebinfo, or minsizerel`);
  }
  return value;
}

function cpuPolicy(value: unknown, path: string): GlobalCpuPolicy {
  if (value !== "baseline" && value !== "native") {
    throw new TypeError(`${path} must be baseline or native`);
  }
  return value;
}

function nullableText(value: unknown, path: string): string | null {
  return value === null ? null : text(value, path);
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string") throw new TypeError(`${path} must be a string`);
  if (value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${path} must be nonempty without surrounding whitespace`);
  }
  rejectControls(value, path);
  return value;
}

function validateRepositoryUrl(value: unknown, path: string): string {
  const result = validateHttpsUrl(value, path);
  const parsed = new URL(result);
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new TypeError(`${path} must not contain a query or fragment`);
  }
  return result;
}

function validateHttpsUrl(value: unknown, path: string): string {
  const source = text(value, path);
  if (source.includes("\\")) throw new TypeError(`${path} contains an invalid URL separator`);
  let parsed: URL;
  try {
    parsed = new URL(source);
  } catch (cause) {
    throw new TypeError(`${path} must be a valid absolute URL`, { cause });
  }
  if (parsed.protocol !== "https:" || parsed.hostname.length === 0) {
    throw new TypeError(`${path} must be an absolute HTTPS URL`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new TypeError(`${path} must not contain credentials`);
  }
  return parsed.href;
}

function nullablePositiveInteger(value: unknown, path: string): number | null {
  return value === null ? null : positiveInteger(value, path);
}

function positiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${path} must be a positive safe integer`);
  }
  return value as number;
}

function nullableNonnegativeInteger(value: unknown, path: string): number | null {
  return value === null ? null : nonnegativeInteger(value, path);
}

function nonnegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${path} must be a nonnegative safe integer`);
  }
  return value as number;
}

function positiveNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${path} must be a positive finite number`);
  }
  return value;
}

function strictObject(
  value: unknown,
  path: string,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${path} must be a plain object`);
  }
  const result = value as Record<string, unknown>;
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(result).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) throw new TypeError(`${path} contains unknown key '${unknown[0]}'`);
  return result;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function rejectControls(value: string, path: string): void {
  if (/\p{Cc}/u.test(value)) throw new TypeError(`${path} contains a control character`);
}

function normalizeFilePath(path: string, label: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new TypeError(`${label} must be a nonempty path`);
  }
  rejectControls(path, label);
  return resolve(path);
}

async function ensurePhysicalDirectoryTree(path: string): Promise<void> {
  const target = resolve(path);
  if (!isAbsolute(target)) throw new TypeError(`directory path must be absolute: ${path}`);
  const missing: string[] = [];
  let current = target;
  while (true) {
    const info = await lstatIfPresent(current);
    if (info !== null) {
      await assertPhysicalDirectory(current, info, "directory");
      break;
    }
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) throw new TypeError(`no physical ancestor exists for ${target}`);
    current = parent;
  }
  for (const directory of missing.reverse()) {
    try {
      await Deno.mkdir(directory, { mode: 0o700 });
    } catch (cause) {
      if (!(cause instanceof Deno.errors.AlreadyExists)) throw cause;
    }
    const info = await Deno.lstat(directory);
    await assertPhysicalDirectory(directory, info, "directory");
  }
}

async function assertPhysicalDirectory(
  path: string,
  info: Deno.FileInfo,
  label: string,
): Promise<void> {
  if (!info.isDirectory || info.isSymlink) {
    throw new TypeError(`${label} is not a physical directory: ${path}`);
  }
  const physical = resolve(await Deno.realPath(path));
  if (physical !== resolve(path)) {
    throw new TypeError(`${label} traverses a symbolic link: ${path}`);
  }
}

async function writeTextAtomically(path: string, textValue: string): Promise<void> {
  const temporary = `${path}.tmp-${crypto.randomUUID()}`;
  const bytes = new TextEncoder().encode(textValue);
  let file: Deno.FsFile | undefined;
  try {
    file = await Deno.open(temporary, { createNew: true, write: true, mode: 0o600 });
    let offset = 0;
    while (offset < bytes.length) offset += await file.write(bytes.subarray(offset));
    await file.sync();
    file.close();
    file = undefined;
    await Deno.rename(temporary, path);
  } catch (cause) {
    file?.close();
    await removeIfPresent(temporary);
    throw new GlobalConfigValidationError(path, "file could not be written atomically", { cause });
  }
}

async function lstatIfPresent(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.lstat(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return null;
    throw cause;
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound)) {
      // Preserve the operation that prompted temporary cleanup.
    }
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
