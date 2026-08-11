import { BUILD_MANIFEST_SCHEMA_VERSION, DOCS_MANIFEST_SCHEMA_VERSION } from "./constants.ts";
import { validateZigBuildRecipe } from "./build_recipe.ts";
import { BuildManifestValidationError, DocsManifestValidationError } from "./errors.ts";
import { atomicWriteJson } from "./filesystem.ts";
import { validateZigSourceVersion } from "./source_version.ts";
import type {
  BuildIdentityInput,
  BuildManifest,
  CommandRecord,
  DocsArtifact,
  DocsManifest,
  MegaDocsRecord,
  NormalizedBuildOptions,
  ToolProbeResult,
  ZigBuildProfile,
} from "./types.ts";

const HASH = /^[0-9a-f]{64}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PROFILES = new Set<ZigBuildProfile>(["debug", "release", "relwithdebinfo", "minsizerel"]);

export async function readBuildManifest(path: string): Promise<BuildManifest> {
  let value: unknown;
  try {
    value = JSON.parse(await Deno.readTextFile(path));
  } catch (cause) {
    throw new BuildManifestValidationError(path, "manifest could not be read as JSON", { cause });
  }
  try {
    return validateBuildManifest(value);
  } catch (cause) {
    throw new BuildManifestValidationError(path, message(cause), { cause });
  }
}

export async function writeBuildManifest(path: string, manifest: BuildManifest): Promise<void> {
  try {
    await atomicWriteJson(path, validateBuildManifest(manifest));
  } catch (cause) {
    if (cause instanceof BuildManifestValidationError) throw cause;
    throw new BuildManifestValidationError(path, message(cause), { cause });
  }
}

export async function readDocsManifest(path: string): Promise<DocsManifest> {
  let value: unknown;
  try {
    value = JSON.parse(await Deno.readTextFile(path));
  } catch (cause) {
    throw new DocsManifestValidationError(path, "manifest could not be read as JSON", { cause });
  }
  try {
    return validateDocsManifest(value);
  } catch (cause) {
    throw new DocsManifestValidationError(path, message(cause), { cause });
  }
}

export async function writeDocsManifest(path: string, manifest: DocsManifest): Promise<void> {
  try {
    await atomicWriteJson(path, validateDocsManifest(manifest));
  } catch (cause) {
    if (cause instanceof DocsManifestValidationError) throw cause;
    throw new DocsManifestValidationError(path, message(cause), { cause });
  }
}

export function validateBuildManifest(value: unknown): BuildManifest {
  const root = object(value, "root", [
    "schemaVersion",
    "identity",
    "recipe",
    "source",
    "hostTarget",
    "configuration",
    "paths",
    "commands",
    "compiler",
    "verified",
  ]);
  equal(root.schemaVersion, BUILD_MANIFEST_SCHEMA_VERSION, "schemaVersion");
  equal(root.verified, true, "verified");
  const source = object(root.source, "source", ["selector", "version", "commit"]);
  const paths = object(root.paths, "paths", [
    "root",
    "cmakeBuild",
    "install",
    "cache",
    "logs",
    "executable",
    "lib",
  ]);
  const compiler = object(root.compiler, "compiler", ["version", "sha256", "size"]);
  if (!Array.isArray(root.commands)) throw new Error("commands must be an array");
  const sourceCommit = commit(source.commit, "source.commit");
  const sourceVersion = validateZigSourceVersion(source.version, "source.version");
  const recipe = validateZigBuildRecipe(root.recipe, "recipe");
  if (!sourceCommit.startsWith(sourceVersion.commitAbbreviation)) {
    throw new Error("source.version.commitAbbreviation does not identify source.commit");
  }
  const compilerVersion = text(compiler.version, "compiler.version");
  if (compilerVersion !== sourceVersion.text) {
    throw new Error("compiler.version does not match source.version.text");
  }
  if (
    recipe.component !== "zig" || recipe.source.commit !== sourceCommit ||
    JSON.stringify(recipe.source.version) !== JSON.stringify(sourceVersion)
  ) throw new Error("recipe source does not match build manifest source");
  return {
    schemaVersion: BUILD_MANIFEST_SCHEMA_VERSION,
    identity: hash(root.identity, "identity"),
    recipe,
    source: {
      selector: text(source.selector, "source.selector"),
      version: sourceVersion,
      commit: sourceCommit,
    },
    hostTarget: text(root.hostTarget, "hostTarget"),
    configuration: buildIdentity(root.configuration),
    paths: {
      root: text(paths.root, "paths.root"),
      cmakeBuild: text(paths.cmakeBuild, "paths.cmakeBuild"),
      install: text(paths.install, "paths.install"),
      cache: text(paths.cache, "paths.cache"),
      logs: text(paths.logs, "paths.logs"),
      executable: text(paths.executable, "paths.executable"),
      lib: text(paths.lib, "paths.lib"),
    },
    commands: root.commands.map((item, index) => command(item, `commands[${index}]`)),
    compiler: {
      version: compilerVersion,
      sha256: hash(compiler.sha256, "compiler.sha256"),
      size: size(compiler.size, "compiler.size"),
    },
    verified: true,
  };
}

export function validateDocsManifest(value: unknown): DocsManifest {
  const root = object(value, "root", [
    "schemaVersion",
    "source",
    "compiler",
    "buildIdentity",
    "outputPath",
    "command",
    "artifacts",
    "mega",
  ]);
  equal(root.schemaVersion, DOCS_MANIFEST_SCHEMA_VERSION, "schemaVersion");
  const source = object(root.source, "source", [
    "selector",
    "version",
    "commit",
    "checkoutPath",
  ]);
  const compiler = object(root.compiler, "compiler", ["path", "version", "sha256"]);
  if (!Array.isArray(root.artifacts)) throw new Error("artifacts must be an array");
  const sourceCommit = commit(source.commit, "source.commit");
  const sourceVersion = validateZigSourceVersion(source.version, "source.version");
  if (!sourceCommit.startsWith(sourceVersion.commitAbbreviation)) {
    throw new Error("source.version.commitAbbreviation does not identify source.commit");
  }
  const compilerVersion = text(compiler.version, "compiler.version");
  if (compilerVersion !== sourceVersion.text) {
    throw new Error("compiler.version does not match source.version.text");
  }
  return {
    schemaVersion: DOCS_MANIFEST_SCHEMA_VERSION,
    source: {
      selector: text(source.selector, "source.selector"),
      version: sourceVersion,
      commit: sourceCommit,
      checkoutPath: text(source.checkoutPath, "source.checkoutPath"),
    },
    compiler: {
      path: text(compiler.path, "compiler.path"),
      version: compilerVersion,
      sha256: hash(compiler.sha256, "compiler.sha256"),
    },
    buildIdentity: hash(root.buildIdentity, "buildIdentity"),
    outputPath: text(root.outputPath, "outputPath"),
    command: command(root.command, "command"),
    artifacts: root.artifacts.map((item, index) => artifact(item, `artifacts[${index}]`)),
    mega: root.mega === null ? null : mega(root.mega),
  };
}

function buildIdentity(value: unknown): BuildIdentityInput {
  const root = object(value, "configuration", ["sourceCommit", "hostTarget", "options", "tools"]);
  const options = object(root.options, "configuration.options", [
    "strategy",
    "profile",
    "cmakeBuildType",
    "generator",
    "jobs",
    "cmakePrefixPath",
    "cpu",
  ]);
  const tools = object(root.tools, "configuration.tools", [
    "cmake",
    "cCompiler",
    "cxxCompiler",
    "llvmConfig",
    "clang",
    "lld",
    "generatorTool",
  ]);
  const profile = text(options.profile, "configuration.options.profile") as ZigBuildProfile;
  if (!PROFILES.has(profile)) throw new Error("configuration.options.profile is invalid");
  const strategy = options.strategy;
  if (strategy !== "cmake") throw new Error("configuration.options.strategy must be 'cmake'");
  const buildType = options.cmakeBuildType;
  if (!["Debug", "Release", "RelWithDebInfo", "MinSizeRel"].includes(buildType as string)) {
    throw new Error("configuration.options.cmakeBuildType is invalid");
  }
  const normalized: NormalizedBuildOptions = {
    strategy,
    profile,
    cmakeBuildType: buildType as NormalizedBuildOptions["cmakeBuildType"],
    generator: text(options.generator, "configuration.options.generator"),
    jobs: options.jobs === null
      ? null
      : positiveInteger(options.jobs, "configuration.options.jobs"),
    cmakePrefixPath: typeof options.cmakePrefixPath === "string"
      ? options.cmakePrefixPath
      : invalid("configuration.options.cmakePrefixPath must be a string"),
    cpu: options.cpu === "baseline" || options.cpu === "native"
      ? options.cpu
      : invalid("configuration.options.cpu must be baseline or native"),
  };
  return {
    sourceCommit: commit(root.sourceCommit, "configuration.sourceCommit"),
    hostTarget: text(root.hostTarget, "configuration.hostTarget"),
    options: normalized,
    tools: {
      cmake: identityTool(tools.cmake, "configuration.tools.cmake"),
      cCompiler: identityTool(tools.cCompiler, "configuration.tools.cCompiler"),
      cxxCompiler: identityTool(tools.cxxCompiler, "configuration.tools.cxxCompiler"),
      llvmConfig: identityTool(tools.llvmConfig, "configuration.tools.llvmConfig"),
      clang: identityTool(tools.clang, "configuration.tools.clang"),
      lld: identityTool(tools.lld, "configuration.tools.lld"),
      generatorTool: tools.generatorTool === null
        ? null
        : identityTool(tools.generatorTool, "configuration.tools.generatorTool"),
    },
  };
}

function identityTool(value: unknown, path: string): { path: string; version: string } {
  const item = object(value, path, ["path", "version"]);
  return { path: text(item.path, `${path}.path`), version: text(item.version, `${path}.version`) };
}

function command(value: unknown, path: string): CommandRecord {
  const item = object(value, path, ["executable", "args", "cwd", "env", "clearEnv"]);
  equal(item.clearEnv, true, `${path}.clearEnv`);
  if (!Array.isArray(item.args) || !item.args.every((value) => typeof value === "string")) {
    throw new Error(`${path}.args must be an array of strings`);
  }
  const envObject = object(item.env, `${path}.env`, null);
  const env: Record<string, string> = {};
  for (const key of Object.keys(envObject).sort()) {
    if (typeof envObject[key] !== "string") {
      throw new Error(`${path}.env.${key} must be a string`);
    }
    env[key] = envObject[key] as string;
  }
  return {
    executable: text(item.executable, `${path}.executable`),
    args: [...item.args] as string[],
    cwd: text(item.cwd, `${path}.cwd`),
    env,
    clearEnv: true,
  };
}

function artifact(value: unknown, path: string): DocsArtifact {
  const item = object(value, path, ["path", "sha256", "size"]);
  return {
    path: safeRelativePath(item.path, `${path}.path`),
    sha256: hash(item.sha256, `${path}.sha256`),
    size: size(item.size, `${path}.size`),
  };
}

function mega(value: unknown): MegaDocsRecord {
  const item = object(value, "mega", ["formatVersion", "assetContract", "path", "sha256", "size"]);
  equal(item.formatVersion, 1, "mega.formatVersion");
  return {
    formatVersion: 1,
    assetContract: text(item.assetContract, "mega.assetContract"),
    path: safeRelativePath(item.path, "mega.path"),
    sha256: hash(item.sha256, "mega.sha256"),
    size: size(item.size, "mega.size"),
  };
}

function object(
  value: unknown,
  path: string,
  keys: readonly string[] | null,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  const result = value as Record<string, unknown>;
  if (keys !== null) {
    const unknown = Object.keys(result).filter((key) => !keys.includes(key)).sort();
    if (unknown.length > 0) throw new Error(`${path} contains unknown key '${unknown[0]}'`);
    for (const key of keys) if (!(key in result)) throw new Error(`${path}.${key} is required`);
  }
  return result;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a nonempty string`);
  }
  return value;
}

function hash(value: unknown, path: string): string {
  const result = text(value, path);
  if (!HASH.test(result)) throw new Error(`${path} must be a lowercase SHA-256 digest`);
  return result;
}

function commit(value: unknown, path: string): string {
  const result = text(value, path);
  if (!COMMIT.test(result)) throw new Error(`${path} must be a lowercase object ID`);
  return result;
}

function size(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${path} must be a positive integer`);
  }
  return value as number;
}

function positiveInteger(value: unknown, path: string): number {
  return size(value, path);
}

function equal(actual: unknown, expected: unknown, path: string): void {
  if (actual !== expected) throw new Error(`${path} must equal ${String(expected)}`);
}

function invalid(message: string): never {
  throw new Error(message);
}

function safeRelativePath(value: unknown, path: string): string {
  const result = text(value, path);
  if (
    result.startsWith("/") || result.startsWith("\\") || /^[A-Za-z]:/.test(result) ||
    result.split(/[\\/]/).some((segment) => segment === "" || segment === "." || segment === "..")
  ) throw new Error(`${path} must be a safe relative artifact path`);
  return result;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function toolIdentity(
  tool: ToolProbeResult,
): { readonly path: string; readonly version: string } {
  if (!tool.available || !tool.supported || tool.version === null) {
    throw new TypeError(`tool '${tool.name}' cannot be included in a build identity`);
  }
  return { path: tool.executable, version: tool.version };
}
