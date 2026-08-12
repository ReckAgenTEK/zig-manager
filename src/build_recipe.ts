import { isAbsolute, resolve } from "@std/path";
import { validateZigSourceVersion } from "./source_version.ts";
import type { NormalizedBuildOptions, ZigSourceVersion } from "./types.ts";
import { type ResolvedZlsSource, validateResolvedZlsSource } from "./zls_source_workspace.ts";
import { validateZlsSourceVersion, type ZlsSourceVersion } from "./zls_source_version.ts";

export const ZIG_BUILD_RECIPE_SCHEMA_VERSION = 1 as const;
export const ZLS_BUILD_RECIPE_SCHEMA_VERSION = 1 as const;
export const ZIG_BUILD_CONTRACT_VERSION = 2 as const;
export const ZIG_INSTALL_VERIFIER_CONTRACT_VERSION = 2 as const;
export const ZLS_BUILD_RECIPE_ADAPTER_ID = "zls-source-build" as const;
export const ZLS_BUILD_CONTRACT_VERSION = 1 as const;
export const ZLS_INSTALL_VERIFIER_CONTRACT_VERSION = 1 as const;

const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PACKAGE_NAME = /^[a-z0-9][a-z0-9@._+-]*$/;

export const BUILD_RECIPE_TOOL_KEYS: readonly [
  "cmake",
  "cCompiler",
  "cxxCompiler",
  "llvmConfig",
  "clang",
  "lld",
  "generatorTool",
] = Object.freeze(
  [
    "cmake",
    "cCompiler",
    "cxxCompiler",
    "llvmConfig",
    "clang",
    "lld",
    "generatorTool",
  ] as const,
);

export type BuildRecipeToolKey = (typeof BUILD_RECIPE_TOOL_KEYS)[number];
export type BuildRecipeComponent = "zig" | "zls";

export interface BuildRecipeRepository {
  readonly identity: string;
  readonly url: string;
}

export interface BuildRecipeSource {
  readonly repository: BuildRecipeRepository;
  readonly commit: string;
  readonly version: ZigSourceVersion;
}

export interface BuildRecipeHost {
  readonly os: string;
  readonly architecture: string;
  readonly abi: string;
  readonly denoTarget: string;
}

export interface BuildRecipeQueryRecord {
  readonly args: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
}

export interface BuildRecipeFileFingerprint {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface BuildRecipeToolFingerprint extends BuildRecipeFileFingerprint {
  readonly version: string;
  readonly queries: readonly BuildRecipeQueryRecord[];
}

export interface BuildRecipePackageFingerprint {
  readonly name: string;
  readonly version: string;
  readonly query: BuildRecipeQueryRecord;
}

export interface BuildRecipeDependency {
  readonly component: "zig";
  readonly installationId: string;
}

export type ZlsBuildProfile = "debug" | "release-safe" | "release-fast" | "release-small";
export type ZlsOptimizeMode = "Debug" | "ReleaseSafe" | "ReleaseFast" | "ReleaseSmall";

export interface ZlsZigExecutableFingerprint {
  /** Canonical path within the dependency installation, never its machine-local absolute path. */
  readonly installPath: string;
  readonly size: number;
  readonly sha256: string;
}

export interface ZlsBuildRecipeSource {
  readonly repository: BuildRecipeRepository;
  readonly commit: string;
  readonly version: ZlsSourceVersion;
  /** Exact resolution record, including selector/ref provenance and observation time. */
  readonly resolved: ResolvedZlsSource;
}

/** A source-built ZLS recipe is deliberately distinct from the CMake-backed Zig recipe. */
export interface ZlsBuildRecipeV1 {
  readonly schemaVersion: 1;
  readonly component: "zls";
  readonly source: ZlsBuildRecipeSource;
  readonly adapter: {
    readonly id: string;
    readonly buildContractVersion: number;
    readonly verifierContractVersion: number;
  };
  readonly host: BuildRecipeHost;
  readonly build: {
    readonly strategy: "zig";
    readonly profile: ZlsBuildProfile;
    readonly optimize: ZlsOptimizeMode;
    readonly jobs: number | null;
    readonly arguments: readonly string[];
  };
  readonly environment: {
    readonly clearEnv: true;
    readonly inherited: readonly [];
    readonly variables: Readonly<Record<string, string>>;
  };
  readonly zig: {
    readonly executable: ZlsZigExecutableFingerprint;
  };
  readonly dependencies: readonly [BuildRecipeDependency];
}

export type BuildRecipeV1 = ZigBuildRecipeV1 | ZlsBuildRecipeV1;

export interface ZigBuildRecipeV1 {
  readonly schemaVersion: 1;
  readonly component: BuildRecipeComponent;
  readonly source: BuildRecipeSource;
  readonly adapter: {
    readonly id: string;
    readonly buildContractVersion: number;
    readonly verifierContractVersion: number;
  };
  readonly host: BuildRecipeHost;
  readonly cpuPolicy: "baseline" | "native";
  readonly build: NormalizedBuildOptions;
  readonly cmake: {
    readonly configureArguments: readonly string[];
    readonly buildArguments: readonly string[];
  };
  readonly environment: {
    readonly clearEnv: true;
    readonly inherited: readonly [];
    readonly variables: Readonly<Record<string, string>>;
  };
  readonly tools: Readonly<Record<BuildRecipeToolKey, BuildRecipeToolFingerprint>>;
  readonly development: {
    readonly files: readonly BuildRecipeFileFingerprint[];
    readonly packages: readonly BuildRecipePackageFingerprint[];
  };
  readonly dependencies: readonly BuildRecipeDependency[];
}

export const BUILD_RECIPE_ENVIRONMENT_KEYS: readonly string[] = Object.freeze(
  [
    "CFLAGS",
    "CXXFLAGS",
    "CPPFLAGS",
    "LDFLAGS",
    "CPATH",
    "C_INCLUDE_PATH",
    "CPLUS_INCLUDE_PATH",
    "LIBRARY_PATH",
    "CMAKE_PREFIX_PATH",
    "PKG_CONFIG_PATH",
    "LANG",
    "LC_ALL",
    "PATH",
    "HOME",
    "TMPDIR",
    "XDG_CACHE_HOME",
    "ZIG_GLOBAL_CACHE_DIR",
    "ZIG_LOCAL_CACHE_DIR",
  ] as const,
);

export const ZLS_BUILD_RECIPE_ENVIRONMENT_KEYS: readonly string[] = BUILD_RECIPE_ENVIRONMENT_KEYS;

const EMPTY_ENVIRONMENT_KEYS = new Set([
  "CFLAGS",
  "CXXFLAGS",
  "CPPFLAGS",
  "LDFLAGS",
  "CPATH",
  "C_INCLUDE_PATH",
  "CPLUS_INCLUDE_PATH",
  "LIBRARY_PATH",
  "CMAKE_PREFIX_PATH",
  "PKG_CONFIG_PATH",
]);

/** Validate either recipe without interpreting one component's fields as the other's. */
export function validateBuildRecipe(value: unknown, path = "recipe"): BuildRecipeV1 {
  const root = looseObject(value, path);
  if (root.component === "zig") return validateZigBuildRecipe(value, path);
  if (root.component !== "zls") {
    throw new TypeError(`${path}.component must be 'zig' or 'zls'`);
  }
  const build = looseObject(root.build, `${path}.build`);
  if (build.strategy === "zig") return validateZlsBuildRecipe(value, path);
  // The v1 schema historically admitted CMake-shaped ZLS records. Keep those readable while all
  // newly created source-built ZLS records use the distinct Zig strategy above.
  return validateZigBuildRecipe(value, path);
}

export function isZlsBuildRecipe(recipe: BuildRecipeV1): recipe is ZlsBuildRecipeV1 {
  return recipe.component === "zls" && recipe.build.strategy === "zig";
}

export function zlsOptimizeForProfile(profile: ZlsBuildProfile): ZlsOptimizeMode {
  switch (profile) {
    case "debug":
      return "Debug";
    case "release-safe":
      return "ReleaseSafe";
    case "release-fast":
      return "ReleaseFast";
    case "release-small":
      return "ReleaseSmall";
  }
}

export function createZlsBuildArguments(input: {
  readonly versionString: string;
  readonly optimize: ZlsOptimizeMode;
  readonly jobs: number | null;
}): readonly string[] {
  const result = [
    "build",
    `-Dversion-string=${text(input.versionString, "versionString")}`,
    `-Doptimize=${input.optimize}`,
    "--prefix",
    "$BUILD/install",
    "--prefix-exe-dir",
    "bin",
  ];
  if (input.jobs !== null) result.push(`-j${positiveSafeInteger(input.jobs, "jobs")}`);
  return result;
}

/** Strict validation for the path-independent, Zig-built ZLS recipe. */
export function validateZlsBuildRecipe(value: unknown, path = "recipe"): ZlsBuildRecipeV1 {
  const root = strictObject(value, path, [
    "schemaVersion",
    "component",
    "source",
    "adapter",
    "host",
    "build",
    "environment",
    "zig",
    "dependencies",
  ]);
  equal(root.schemaVersion, ZIG_BUILD_RECIPE_SCHEMA_VERSION, `${path}.schemaVersion`);
  equal(root.component, "zls", `${path}.component`);
  const sourceValue = strictObject(root.source, `${path}.source`, [
    "repository",
    "commit",
    "version",
    "resolved",
  ]);
  const resolvedSource = validateResolvedZlsSource(
    sourceValue.resolved,
    `${path}.source.resolved`,
  );
  const source: ZlsBuildRecipeSource = {
    repository: repository(sourceValue.repository, `${path}.source.repository`),
    commit: objectId(sourceValue.commit, `${path}.source.commit`),
    version: validateZlsSourceVersion(sourceValue.version, `${path}.source.version`),
    resolved: resolvedSource,
  };
  if (
    canonicalObject(source.repository) !== canonicalObject(resolvedSource.repository) ||
    source.commit !== resolvedSource.commit ||
    canonicalObject(source.version) !== canonicalObject(resolvedSource.versionMetadata)
  ) throw new TypeError(`${path}.source fields must exactly match ${path}.source.resolved`);

  const adapterValue = strictObject(root.adapter, `${path}.adapter`, [
    "id",
    "buildContractVersion",
    "verifierContractVersion",
  ]);
  const adapter = {
    id: text(adapterValue.id, `${path}.adapter.id`),
    buildContractVersion: positiveSafeInteger(
      adapterValue.buildContractVersion,
      `${path}.adapter.buildContractVersion`,
    ),
    verifierContractVersion: positiveSafeInteger(
      adapterValue.verifierContractVersion,
      `${path}.adapter.verifierContractVersion`,
    ),
  };

  const hostValue = strictObject(root.host, `${path}.host`, [
    "os",
    "architecture",
    "abi",
    "denoTarget",
  ]);
  const host: BuildRecipeHost = {
    os: text(hostValue.os, `${path}.host.os`),
    architecture: text(hostValue.architecture, `${path}.host.architecture`),
    abi: text(hostValue.abi, `${path}.host.abi`),
    denoTarget: text(hostValue.denoTarget, `${path}.host.denoTarget`),
  };

  const buildValue = strictObject(root.build, `${path}.build`, [
    "strategy",
    "profile",
    "optimize",
    "jobs",
    "arguments",
  ]);
  equal(buildValue.strategy, "zig", `${path}.build.strategy`);
  const profile = zlsBuildProfile(buildValue.profile, `${path}.build.profile`);
  const optimize = zlsOptimizeMode(buildValue.optimize, `${path}.build.optimize`);
  if (optimize !== zlsOptimizeForProfile(profile)) {
    throw new TypeError(`${path}.build.optimize does not match ${path}.build.profile`);
  }
  const jobs = buildValue.jobs === null
    ? null
    : positiveSafeInteger(buildValue.jobs, `${path}.build.jobs`);
  const argumentsValue = stringArray(buildValue.arguments, `${path}.build.arguments`, true);
  const expectedArguments = createZlsBuildArguments({
    versionString: source.version.versionString,
    optimize,
    jobs,
  });
  if (JSON.stringify(argumentsValue) !== JSON.stringify(expectedArguments)) {
    throw new TypeError(`${path}.build.arguments must equal the canonical ZLS build arguments`);
  }

  const environmentValue = strictObject(root.environment, `${path}.environment`, [
    "clearEnv",
    "inherited",
    "variables",
  ]);
  equal(environmentValue.clearEnv, true, `${path}.environment.clearEnv`);
  if (!Array.isArray(environmentValue.inherited) || environmentValue.inherited.length !== 0) {
    throw new TypeError(`${path}.environment.inherited must be empty`);
  }
  const variablesValue = strictObject(
    environmentValue.variables,
    `${path}.environment.variables`,
    ZLS_BUILD_RECIPE_ENVIRONMENT_KEYS,
  );
  const variables: Record<string, string> = {};
  for (const key of ZLS_BUILD_RECIPE_ENVIRONMENT_KEYS) {
    variables[key] = text(
      variablesValue[key],
      `${path}.environment.variables.${key}`,
      true,
    );
    if (EMPTY_ENVIRONMENT_KEYS.has(key) && variables[key] !== "") {
      throw new TypeError(`${path}.environment.variables.${key} must be explicitly empty`);
    }
  }
  equal(variables.LANG, "C", `${path}.environment.variables.LANG`);
  equal(variables.LC_ALL, "C", `${path}.environment.variables.LC_ALL`);
  equal(variables.PATH, "$ZIG_BIN", `${path}.environment.variables.PATH`);
  equal(variables.HOME, "$BUILD/home", `${path}.environment.variables.HOME`);
  equal(variables.TMPDIR, "$BUILD/tmp", `${path}.environment.variables.TMPDIR`);
  equal(
    variables.XDG_CACHE_HOME,
    "$BUILD/cache/xdg",
    `${path}.environment.variables.XDG_CACHE_HOME`,
  );
  equal(
    variables.ZIG_GLOBAL_CACHE_DIR,
    "$BUILD/cache/zig-global",
    `${path}.environment.variables.ZIG_GLOBAL_CACHE_DIR`,
  );
  equal(
    variables.ZIG_LOCAL_CACHE_DIR,
    "$BUILD/cache/zig-local",
    `${path}.environment.variables.ZIG_LOCAL_CACHE_DIR`,
  );

  const zigValue = strictObject(root.zig, `${path}.zig`, ["executable"]);
  const executableValue = strictObject(zigValue.executable, `${path}.zig.executable`, [
    "installPath",
    "size",
    "sha256",
  ]);
  const executable: ZlsZigExecutableFingerprint = {
    installPath: canonicalInstallPath(
      executableValue.installPath,
      `${path}.zig.executable.installPath`,
    ),
    size: positiveSafeInteger(executableValue.size, `${path}.zig.executable.size`),
    sha256: digest(executableValue.sha256, `${path}.zig.executable.sha256`),
  };

  if (!Array.isArray(root.dependencies) || root.dependencies.length !== 1) {
    throw new TypeError(`${path}.dependencies must contain exactly one Zig installation`);
  }
  const dependencyValue = strictObject(root.dependencies[0], `${path}.dependencies[0]`, [
    "component",
    "installationId",
  ]);
  equal(dependencyValue.component, "zig", `${path}.dependencies[0].component`);
  const dependency: BuildRecipeDependency = {
    component: "zig",
    installationId: digest(
      dependencyValue.installationId,
      `${path}.dependencies[0].installationId`,
    ),
  };

  return {
    schemaVersion: ZIG_BUILD_RECIPE_SCHEMA_VERSION,
    component: "zls",
    source,
    adapter,
    host,
    build: { strategy: "zig", profile, optimize, jobs, arguments: argumentsValue },
    environment: { clearEnv: true, inherited: [], variables },
    zig: { executable },
    dependencies: [dependency],
  };
}

/** Strict runtime validation for the complete canonical component recipe. */
export function validateZigBuildRecipe(value: unknown, path = "recipe"): ZigBuildRecipeV1 {
  const root = strictObject(value, path, [
    "schemaVersion",
    "component",
    "source",
    "adapter",
    "host",
    "cpuPolicy",
    "build",
    "cmake",
    "environment",
    "tools",
    "development",
    "dependencies",
  ]);
  equal(root.schemaVersion, ZIG_BUILD_RECIPE_SCHEMA_VERSION, `${path}.schemaVersion`);
  const component = root.component;
  if (component !== "zig" && component !== "zls") {
    throw new TypeError(`${path}.component must be 'zig' or 'zls'`);
  }

  const sourceValue = strictObject(root.source, `${path}.source`, [
    "repository",
    "commit",
    "version",
  ]);
  const commit = objectId(sourceValue.commit, `${path}.source.commit`);
  const version = validateZigSourceVersion(sourceValue.version, `${path}.source.version`);
  if (!commit.startsWith(version.commitAbbreviation)) {
    throw new TypeError(`${path}.source.version.commitAbbreviation must identify the commit`);
  }
  const source: BuildRecipeSource = {
    repository: repository(sourceValue.repository, `${path}.source.repository`),
    commit,
    version,
  };

  const adapterValue = strictObject(root.adapter, `${path}.adapter`, [
    "id",
    "buildContractVersion",
    "verifierContractVersion",
  ]);
  const adapter = {
    id: text(adapterValue.id, `${path}.adapter.id`),
    buildContractVersion: positiveSafeInteger(
      adapterValue.buildContractVersion,
      `${path}.adapter.buildContractVersion`,
    ),
    verifierContractVersion: positiveSafeInteger(
      adapterValue.verifierContractVersion,
      `${path}.adapter.verifierContractVersion`,
    ),
  };

  const hostValue = strictObject(root.host, `${path}.host`, [
    "os",
    "architecture",
    "abi",
    "denoTarget",
  ]);
  const host: BuildRecipeHost = {
    os: text(hostValue.os, `${path}.host.os`),
    architecture: text(hostValue.architecture, `${path}.host.architecture`),
    abi: text(hostValue.abi, `${path}.host.abi`),
    denoTarget: text(hostValue.denoTarget, `${path}.host.denoTarget`),
  };

  const cpuPolicy = root.cpuPolicy;
  if (cpuPolicy !== "baseline" && cpuPolicy !== "native") {
    throw new TypeError(`${path}.cpuPolicy must be baseline or native`);
  }
  const build = normalizedBuildOptions(root.build, `${path}.build`);
  if (build.cpu !== cpuPolicy) throw new TypeError(`${path}.build.cpu must equal cpuPolicy`);

  const cmakeValue = strictObject(root.cmake, `${path}.cmake`, [
    "configureArguments",
    "buildArguments",
  ]);
  const configureArguments = stringArray(
    cmakeValue.configureArguments,
    `${path}.cmake.configureArguments`,
    true,
  );
  const buildArguments = stringArray(
    cmakeValue.buildArguments,
    `${path}.cmake.buildArguments`,
    true,
  );
  validateCmakeArguments(
    configureArguments,
    buildArguments,
    build,
    adapter.buildContractVersion,
    `${path}.cmake`,
  );

  const environmentValue = strictObject(root.environment, `${path}.environment`, [
    "clearEnv",
    "inherited",
    "variables",
  ]);
  equal(environmentValue.clearEnv, true, `${path}.environment.clearEnv`);
  if (!Array.isArray(environmentValue.inherited) || environmentValue.inherited.length !== 0) {
    throw new TypeError(`${path}.environment.inherited must be empty`);
  }
  const variablesValue = strictObject(
    environmentValue.variables,
    `${path}.environment.variables`,
    BUILD_RECIPE_ENVIRONMENT_KEYS,
  );
  const variables: Record<string, string> = {};
  for (const key of BUILD_RECIPE_ENVIRONMENT_KEYS) {
    variables[key] = text(
      variablesValue[key],
      `${path}.environment.variables.${key}`,
      true,
    );
    if (EMPTY_ENVIRONMENT_KEYS.has(key) && variables[key] !== "") {
      throw new TypeError(`${path}.environment.variables.${key} must be explicitly empty`);
    }
  }
  equal(variables.LANG, "C", `${path}.environment.variables.LANG`);
  equal(variables.LC_ALL, "C", `${path}.environment.variables.LC_ALL`);
  equal(variables.HOME, "$BUILD/home", `${path}.environment.variables.HOME`);
  equal(variables.TMPDIR, "$BUILD/tmp", `${path}.environment.variables.TMPDIR`);
  equal(
    variables.XDG_CACHE_HOME,
    "$BUILD/cache/xdg",
    `${path}.environment.variables.XDG_CACHE_HOME`,
  );
  equal(
    variables.ZIG_GLOBAL_CACHE_DIR,
    "$BUILD/cache/zig-global",
    `${path}.environment.variables.ZIG_GLOBAL_CACHE_DIR`,
  );
  equal(
    variables.ZIG_LOCAL_CACHE_DIR,
    "$BUILD/cache/zig-local",
    `${path}.environment.variables.ZIG_LOCAL_CACHE_DIR`,
  );
  validateRecipePath(variables.PATH, `${path}.environment.variables.PATH`);

  const toolsValue = strictObject(root.tools, `${path}.tools`, BUILD_RECIPE_TOOL_KEYS);
  const tools = {} as Record<BuildRecipeToolKey, BuildRecipeToolFingerprint>;
  for (const key of BUILD_RECIPE_TOOL_KEYS) {
    tools[key] = toolFingerprint(toolsValue[key], `${path}.tools.${key}`);
  }
  const developmentValue = strictObject(root.development, `${path}.development`, [
    "files",
    "packages",
  ]);
  if (!Array.isArray(developmentValue.files) || developmentValue.files.length === 0) {
    throw new TypeError(`${path}.development.files must be a nonempty array`);
  }
  if (!Array.isArray(developmentValue.packages) || developmentValue.packages.length === 0) {
    throw new TypeError(`${path}.development.packages must be a nonempty array`);
  }
  const files = developmentValue.files.map((item, index) =>
    fileFingerprint(item, `${path}.development.files[${index}]`)
  );
  assertSortedUnique(files.map((item) => item.path), `${path}.development.files`);
  const packages = developmentValue.packages.map((item, index) =>
    packageFingerprint(item, `${path}.development.packages[${index}]`)
  );
  assertSortedUnique(packages.map((item) => item.name), `${path}.development.packages`);

  if (!Array.isArray(root.dependencies)) {
    throw new TypeError(`${path}.dependencies must be an array`);
  }
  const dependencies = root.dependencies.map((item, index) => {
    const dependency = strictObject(item, `${path}.dependencies[${index}]`, [
      "component",
      "installationId",
    ]);
    equal(dependency.component, "zig", `${path}.dependencies[${index}].component`);
    return {
      component: "zig" as const,
      installationId: digest(
        dependency.installationId,
        `${path}.dependencies[${index}].installationId`,
      ),
    };
  });
  if (component === "zig" && dependencies.length !== 0) {
    throw new TypeError(`${path}.dependencies must be empty for Zig`);
  }
  if (component === "zls" && dependencies.length !== 1) {
    throw new TypeError(`${path}.dependencies must contain exactly one Zig installation for ZLS`);
  }

  return {
    schemaVersion: ZIG_BUILD_RECIPE_SCHEMA_VERSION,
    component,
    source,
    adapter,
    host,
    cpuPolicy,
    build,
    cmake: { configureArguments, buildArguments },
    environment: { clearEnv: true, inherited: [], variables },
    tools,
    development: { files, packages },
    dependencies,
  };
}

function normalizedBuildOptions(value: unknown, path: string): NormalizedBuildOptions {
  const root = strictObject(value, path, [
    "strategy",
    "profile",
    "cmakeBuildType",
    "generator",
    "jobs",
    "cmakePrefixPath",
    "cpu",
  ]);
  equal(root.strategy, "cmake", `${path}.strategy`);
  const profile = root.profile;
  if (
    profile !== "debug" && profile !== "release" && profile !== "relwithdebinfo" &&
    profile !== "minsizerel"
  ) throw new TypeError(`${path}.profile is invalid`);
  const cmakeBuildType = root.cmakeBuildType;
  if (
    cmakeBuildType !== "Debug" && cmakeBuildType !== "Release" &&
    cmakeBuildType !== "RelWithDebInfo" && cmakeBuildType !== "MinSizeRel"
  ) throw new TypeError(`${path}.cmakeBuildType is invalid`);
  const cpu = root.cpu;
  if (cpu !== "baseline" && cpu !== "native") throw new TypeError(`${path}.cpu is invalid`);
  return {
    strategy: "cmake",
    profile,
    cmakeBuildType,
    generator: text(root.generator, `${path}.generator`),
    jobs: root.jobs === null ? null : positiveSafeInteger(root.jobs, `${path}.jobs`),
    cmakePrefixPath: absolutePath(root.cmakePrefixPath, `${path}.cmakePrefixPath`),
    cpu,
  };
}

function validateCmakeArguments(
  configure: readonly string[],
  build: readonly string[],
  options: NormalizedBuildOptions,
  buildContractVersion: number,
  path: string,
): void {
  if (configure[0] !== "-S" || configure[1] !== "$SOURCE") {
    throw new TypeError(`${path}.configureArguments must use the canonical source placeholder`);
  }
  if (!configure.includes("-B") || !configure.includes("$BUILD/cmake-build")) {
    throw new TypeError(`${path}.configureArguments must use the canonical build placeholder`);
  }
  if (!configure.includes(`-G`) || !configure.includes(options.generator)) {
    throw new TypeError(`${path}.configureArguments must contain the normalized generator`);
  }
  if (!configure.includes("-DCMAKE_INSTALL_PREFIX=$BUILD/install")) {
    throw new TypeError(`${path}.configureArguments must use the canonical install placeholder`);
  }
  const extraBuildArguments = configure.filter((argument) =>
    argument.startsWith("-DZIG_EXTRA_BUILD_ARGS=")
  );
  const requiresNoLangref = buildContractVersion >= ZIG_BUILD_CONTRACT_VERSION;
  if (
    requiresNoLangref &&
    (extraBuildArguments.length !== 1 ||
      extraBuildArguments[0] !== "-DZIG_EXTRA_BUILD_ARGS=-Dno-langref")
  ) {
    throw new TypeError(
      `${path}.configureArguments must disable language-reference installation canonically`,
    );
  }
  if (build[0] !== "--build" || build[1] !== "$BUILD/cmake-build") {
    throw new TypeError(`${path}.buildArguments must use the canonical build placeholder`);
  }
  for (const argument of [...configure, ...build]) {
    if (argument.includes("$SOURCE") && argument !== "$SOURCE") {
      throw new TypeError(`${path} contains a noncanonical source placeholder`);
    }
    if (/\$(?:CACHE|DATA|STAGING|LOG|OUTPUT)/.test(argument)) {
      throw new TypeError(`${path} contains a forbidden output identity input`);
    }
  }
}

function toolFingerprint(value: unknown, path: string): BuildRecipeToolFingerprint {
  const root = strictObject(value, path, ["path", "version", "size", "sha256", "queries"]);
  if (!Array.isArray(root.queries) || root.queries.length === 0) {
    throw new TypeError(`${path}.queries must be a nonempty array`);
  }
  const queries = root.queries.map((item, index) => query(item, `${path}.queries[${index}]`));
  assertSortedUnique(
    queries.map((item) => JSON.stringify(item.args)),
    `${path}.queries`,
  );
  return {
    ...fileFingerprint(root, path, ["path", "version", "size", "sha256", "queries"]),
    version: text(root.version, `${path}.version`),
    queries,
  };
}

function fileFingerprint(
  value: unknown,
  path: string,
  knownKeys: readonly string[] = ["path", "size", "sha256"],
): BuildRecipeFileFingerprint {
  const root = strictObject(value, path, knownKeys);
  return {
    path: absolutePath(root.path, `${path}.path`),
    size: positiveSafeInteger(root.size, `${path}.size`),
    sha256: digest(root.sha256, `${path}.sha256`),
  };
}

function packageFingerprint(value: unknown, path: string): BuildRecipePackageFingerprint {
  const root = strictObject(value, path, ["name", "version", "query"]);
  const name = text(root.name, `${path}.name`);
  if (!PACKAGE_NAME.test(name)) throw new TypeError(`${path}.name is invalid`);
  return {
    name,
    version: text(root.version, `${path}.version`),
    query: query(root.query, `${path}.query`),
  };
}

function query(value: unknown, path: string): BuildRecipeQueryRecord {
  const root = strictObject(value, path, ["args", "stdout", "stderr"]);
  return {
    args: stringArray(root.args, `${path}.args`, true),
    stdout: queryText(root.stdout, `${path}.stdout`),
    stderr: queryText(root.stderr, `${path}.stderr`),
  };
}

function repository(value: unknown, path: string): BuildRecipeRepository {
  const root = strictObject(value, path, ["identity", "url"]);
  const identity = text(root.identity, `${path}.identity`);
  if (
    !/^[a-z0-9](?:[a-z0-9._/-]{0,126}[a-z0-9])?$/.test(identity) ||
    identity.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) throw new TypeError(`${path}.identity must be normalized`);
  const urlText = text(root.url, `${path}.url`);
  let url: URL;
  try {
    url = new URL(urlText);
  } catch (cause) {
    throw new TypeError(`${path}.url must be absolute`, { cause });
  }
  if (
    url.protocol !== "https:" || url.username !== "" || url.password !== "" ||
    url.search !== "" || url.hash !== "" || url.href !== urlText
  ) throw new TypeError(`${path}.url must be normalized credential-free HTTPS`);
  return { identity, url: urlText };
}

function validateRecipePath(value: string, path: string): void {
  const entries = value.split(":");
  if (entries.length === 0 || entries.some((entry) => entry.length === 0)) {
    throw new TypeError(`${path} must contain nonempty absolute entries`);
  }
  for (let index = 0; index < entries.length; index++) {
    absolutePath(entries[index], `${path}[${index}]`);
  }
  if (new Set(entries).size !== entries.length) throw new TypeError(`${path} contains duplicates`);
}

function absolutePath(value: unknown, path: string): string {
  const result = text(value, path);
  if (!isAbsolute(result) || resolve(result) !== result) {
    throw new TypeError(`${path} must be an absolute normalized path`);
  }
  return result;
}

function canonicalInstallPath(value: unknown, path: string): string {
  const result = text(value, path);
  if (result.includes("\\") || result.startsWith("/") || /^[A-Za-z]:/.test(result)) {
    throw new TypeError(`${path} must be a canonical relative install path`);
  }
  const segments = result.split("/");
  if (
    segments.length < 2 || segments[0] !== "install" ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new TypeError(`${path} must be below install without path traversal`);
  }
  return result;
}

function zlsBuildProfile(value: unknown, path: string): ZlsBuildProfile {
  if (
    value !== "debug" && value !== "release-safe" && value !== "release-fast" &&
    value !== "release-small"
  ) throw new TypeError(`${path} is invalid`);
  return value;
}

function zlsOptimizeMode(value: unknown, path: string): ZlsOptimizeMode {
  if (
    value !== "Debug" && value !== "ReleaseSafe" && value !== "ReleaseFast" &&
    value !== "ReleaseSmall"
  ) throw new TypeError(`${path} is invalid`);
  return value;
}

function objectId(value: unknown, path: string): string {
  const result = text(value, path);
  if (!COMMIT.test(result)) throw new TypeError(`${path} must be a lowercase object ID`);
  return result;
}

function digest(value: unknown, path: string): string {
  const result = text(value, path);
  if (!HASH.test(result)) throw new TypeError(`${path} must be a lowercase SHA-256 digest`);
  return result;
}

function positiveSafeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`${path} must be a positive safe integer`);
  }
  return value as number;
}

function stringArray(value: unknown, path: string, allowEmptyStrings: boolean): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value.map((item, index) => text(item, `${path}[${index}]`, allowEmptyStrings));
}

function text(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new TypeError(`${path} must be ${allowEmpty ? "a string" : "nonempty text"}`);
  }
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || code >= 0x7f && code <= 0x9f) {
      throw new TypeError(`${path} must not contain control characters`);
    }
  }
  return value;
}

function queryText(value: unknown, path: string): string {
  if (typeof value !== "string") throw new TypeError(`${path} must be a string`);
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (
      code === 0 || code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d ||
      code >= 0x7f && code <= 0x9f
    ) throw new TypeError(`${path} contains an unsafe control character`);
  }
  return value;
}

function strictObject(
  value: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> {
  const result = looseObject(value, path);
  const unknown = Object.keys(result).filter((key) => !keys.includes(key)).sort();
  if (unknown.length > 0) throw new TypeError(`${path} contains unknown key '${unknown[0]}'`);
  for (const key of keys) if (!(key in result)) throw new TypeError(`${path}.${key} is required`);
  return result;
}

function looseObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertSortedUnique(values: readonly string[], path: string): void {
  for (let index = 1; index < values.length; index++) {
    if (values[index - 1] >= values[index]) {
      throw new TypeError(`${path} must be strictly sorted without duplicates`);
    }
  }
}

function equal(actual: unknown, expected: unknown, path: string): void {
  if (actual !== expected) throw new TypeError(`${path} must equal ${String(expected)}`);
}

function canonicalObject(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalObject).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${
      Object.keys(record).sort().map((key) => `${key}:${canonicalObject(record[key])}`).join(",")
    }}`;
  }
  return JSON.stringify(value);
}
