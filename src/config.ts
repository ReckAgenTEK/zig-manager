import { join, resolve } from "@std/path";
import { MAX_CONFIG_BYTES, ZIG_MANAGER_CONFIG_FILE } from "./constants.ts";
import { ConfigNotFoundError, ConfigValidationError } from "./errors.ts";
import { assertPathBelow, assertRealPathContained } from "./filesystem.ts";
import { parseZigSelector } from "./versions.ts";
import { DEFAULT_GLOBAL_CONFIG } from "./global_config.ts";
import type {
  ResolvedZigManagerConfig,
  ZigBuildProfile,
  ZigManagerConfig,
  ZigManagerToolConfig,
} from "./types.ts";

const ROOT_KEYS = new Set([
  "$schema",
  "sourceRoot",
  "repository",
  "provider",
  "name",
  "selector",
  "build",
  "docs",
  "tools",
]);
const BUILD_KEYS = new Set(["strategy", "profile", "generator", "cmakePrefixPath", "jobs"]);
const DOCS_KEYS = new Set(["mega"]);
const TOOL_KEYS = new Set([
  "cmake",
  "cCompiler",
  "cxxCompiler",
  "llvmConfig",
  "clang",
  "lld",
  "generatorTool",
]);
const PROFILES = new Set<ZigBuildProfile>([
  "debug",
  "release",
  "relwithdebinfo",
  "minsizerel",
]);
const PORTABLE_SEGMENT = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/i;

export async function loadZigManagerConfig(
  projectRoot: string = Deno.cwd(),
): Promise<ResolvedZigManagerConfig> {
  const root = resolve(projectRoot);
  const path = join(root, ZIG_MANAGER_CONFIG_FILE);
  let text: string;
  try {
    const stat = await Deno.stat(path);
    if (!stat.isFile) throw new ConfigValidationError(path, "configuration path is not a file");
    if (stat.size > MAX_CONFIG_BYTES) {
      throw new ConfigValidationError(path, `configuration exceeds ${MAX_CONFIG_BYTES} bytes`);
    }
    text = await Deno.readTextFile(path);
  } catch (cause) {
    if (cause instanceof ConfigValidationError) throw cause;
    if (cause instanceof Deno.errors.NotFound) throw new ConfigNotFoundError(path, { cause });
    throw new ConfigValidationError(path, "configuration could not be read", { cause });
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new ConfigValidationError(path, "file is not valid JSON", { cause });
  }
  const config = resolveZigManagerConfig(value, root, path);
  try {
    await assertRealPathContained(config.projectRoot, config.sourceRoot);
  } catch (cause) {
    throw new ConfigValidationError(path, "sourceRoot resolves outside the project root", {
      cause,
    });
  }
  return config;
}

export function resolveZigManagerConfig(
  value: unknown,
  projectRoot: string = Deno.cwd(),
  configPath: string = join(resolve(projectRoot), ZIG_MANAGER_CONFIG_FILE),
): ResolvedZigManagerConfig {
  const root = resolve(projectRoot);
  try {
    const config = validateConfig(value);
    const sourceRoot = assertPathBelow(root, resolve(root, config.sourceRoot));
    const tools = normalizeTools(config.tools);
    return {
      configPath: resolve(configPath),
      projectRoot: root,
      sourceRoot,
      repository: config.repository,
      provider: config.provider,
      name: config.name,
      selector: config.selector,
      build: { ...config.build },
      docs: { ...config.docs },
      tools,
      warnings: { ...DEFAULT_GLOBAL_CONFIG.warnings },
    };
  } catch (cause) {
    if (cause instanceof ConfigValidationError) throw cause;
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new ConfigValidationError(resolve(configPath), reason, { cause });
  }
}

function validateConfig(value: unknown): ZigManagerConfig {
  const root = record(value, "root");
  rejectUnknown(root, ROOT_KEYS, "root");
  if ("$schema" in root) string(root.$schema, "$schema");
  const sourceRoot = nonempty(root.sourceRoot, "sourceRoot");
  if (sourceRoot.includes("\0")) throw new Error("sourceRoot contains a NUL byte");
  const repository = nonempty(root.repository, "repository");
  const provider = portableSegment(root.provider, "provider");
  const name = portableSegment(root.name, "name");
  const selector = nonempty(root.selector, "selector");
  parseZigSelector(selector);

  const build = record(root.build, "build");
  rejectUnknown(build, BUILD_KEYS, "build");
  if (build.strategy !== "cmake") throw new Error("build.strategy must be 'cmake'");
  const profile = nonempty(build.profile, "build.profile") as ZigBuildProfile;
  if (!PROFILES.has(profile)) throw new Error(`build.profile '${profile}' is unsupported`);
  const generator = nonempty(build.generator, "build.generator");
  const cmakePrefixPath = nullableString(build.cmakePrefixPath, "build.cmakePrefixPath");
  const jobs = nullablePositiveInteger(build.jobs, "build.jobs");

  const docs = record(root.docs, "docs");
  rejectUnknown(docs, DOCS_KEYS, "docs");
  if (typeof docs.mega !== "boolean") throw new Error("docs.mega must be a boolean");

  let tools: MutablePartial<ZigManagerToolConfig> | undefined;
  if (root.tools !== undefined) {
    const toolsValue = record(root.tools, "tools");
    rejectUnknown(toolsValue, TOOL_KEYS, "tools");
    tools = {};
    for (const key of TOOL_KEYS) {
      if (toolsValue[key] !== undefined) {
        tools[key as keyof ZigManagerToolConfig] = nullableString(toolsValue[key], `tools.${key}`);
      }
    }
  }

  return {
    ...(root.$schema === undefined ? {} : { $schema: root.$schema as string }),
    sourceRoot,
    repository,
    provider,
    name,
    selector,
    build: { strategy: "cmake", profile, generator, cmakePrefixPath, jobs },
    docs: { mega: docs.mega },
    ...(tools === undefined ? {} : { tools }),
  };
}

type MutablePartial<T> = { -readonly [Key in keyof T]?: T[Key] };

function normalizeTools(value: Partial<ZigManagerToolConfig> | undefined): ZigManagerToolConfig {
  return {
    cmake: value?.cmake ?? null,
    cCompiler: value?.cCompiler ?? null,
    cxxCompiler: value?.cxxCompiler ?? null,
    llvmConfig: value?.llvmConfig ?? null,
    clang: value?.clang ?? null,
    lld: value?.lld ?? null,
    generatorTool: value?.generatorTool ?? null,
  };
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) throw new Error(`${path} contains unknown key '${unknown[0]}'`);
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  return value;
}

function nonempty(value: unknown, path: string): string {
  const result = string(value, path);
  if (result.length === 0 || result.trim() !== result) {
    throw new Error(`${path} must be a nonempty string without surrounding whitespace`);
  }
  if (/\p{Cc}/u.test(result)) throw new Error(`${path} contains a control character`);
  return result;
}

function portableSegment(value: unknown, path: string): string {
  const result = nonempty(value, path);
  if (!PORTABLE_SEGMENT.test(result) || result === "." || result === "..") {
    throw new Error(`${path} is not a portable path segment`);
  }
  return result;
}

function nullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return nonempty(value, path);
}

function nullablePositiveInteger(value: unknown, path: string): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${path} must be null or a positive integer`);
  }
  return value as number;
}
