import { isAbsolute, join, relative, resolve } from "@std/path";
import { GLOBAL_PROFILE_FILE_NAME } from "./global_profile.ts";

export type PlatformPathPlatform = "linux" | "darwin" | "windows";

export interface PlatformPathsInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly platform: PlatformPathPlatform;
}

/** Manager-owned paths derived only from the supplied platform inputs. */
export class PlatformPaths {
  readonly platform: "linux" | "darwin";
  readonly home: string;
  readonly overrideRoot: string | null;

  readonly configRoot: string;
  readonly stateRoot: string;
  readonly dataRoot: string;
  readonly cacheRoot: string;

  readonly configDir: string;
  readonly stateDir: string;
  readonly dataDir: string;
  readonly cacheDir: string;

  readonly configFile: string;
  readonly catalogFile: string;
  readonly scopesFile: string;
  readonly globalProfileFile: string;
  readonly stableZlsDir: string;
  readonly locksDir: string;
  readonly shimsDir: string;
  readonly globalBinDir: string;
  readonly resolverDir: string;
  readonly installsDir: string;
  readonly profilesDir: string;
  readonly sourcesDir: string;
  readonly buildsDir: string;
  readonly logsDir: string;

  constructor(input: PlatformPathsInput) {
    if (input.platform === "windows") {
      throw new TypeError("XDG zig-manager paths are not supported on Windows");
    }

    this.platform = input.platform;
    this.home = normalizeAbsolutePath(input.home, "home");

    const override = nonEmpty(input.env.ZIG_MANAGER_HOME);
    if (override !== undefined) {
      this.overrideRoot = normalizeAbsolutePath(override, "ZIG_MANAGER_HOME");
      this.configRoot = child(this.overrideRoot, "config");
      this.stateRoot = child(this.overrideRoot, "state");
      this.dataRoot = child(this.overrideRoot, "data");
      this.cacheRoot = child(this.overrideRoot, "cache");
    } else {
      this.overrideRoot = null;
      this.configRoot = managerXdgPath(input.env.XDG_CONFIG_HOME, this.home, ".config");
      this.stateRoot = managerXdgPath(
        input.env.XDG_STATE_HOME,
        this.home,
        join(".local", "state"),
      );
      this.dataRoot = managerXdgPath(
        input.env.XDG_DATA_HOME,
        this.home,
        join(".local", "share"),
      );
      this.cacheRoot = managerXdgPath(input.env.XDG_CACHE_HOME, this.home, ".cache");
    }

    this.configDir = this.configRoot;
    this.stateDir = this.stateRoot;
    this.dataDir = this.dataRoot;
    this.cacheDir = this.cacheRoot;

    this.configFile = child(this.configRoot, "config.json");
    this.catalogFile = child(this.stateRoot, "catalog.json");
    this.scopesFile = child(this.stateRoot, "scopes.json");
    this.globalProfileFile = child(this.stateRoot, GLOBAL_PROFILE_FILE_NAME);
    this.stableZlsDir = child(this.stateRoot, "stable-zls");
    this.locksDir = child(this.stateRoot, "locks");
    this.shimsDir = child(this.dataRoot, "shims");
    this.globalBinDir = denoGlobalBinPath(input.env.DENO_INSTALL_ROOT, this.home);
    this.resolverDir = this.shimsDir;
    this.installsDir = child(this.dataRoot, "installs");
    this.profilesDir = child(this.dataRoot, "profiles");
    this.sourcesDir = child(this.cacheRoot, "sources");
    this.buildsDir = child(this.cacheRoot, "builds");
    this.logsDir = child(this.cacheRoot, "logs");
  }

  assertDataPath(candidate: string): string {
    return assertContainedPath(this.dataRoot, candidate, "manager data");
  }

  assertStatePath(candidate: string): string {
    return assertContainedPath(this.stateRoot, candidate, "manager state");
  }

  assertCachePath(candidate: string): string {
    return assertContainedPath(this.cacheRoot, candidate, "manager cache");
  }
}

export function resolvePlatformPaths(input: PlatformPathsInput): PlatformPaths {
  return new PlatformPaths(input);
}

export function assertContainedPath(root: string, candidate: string, label = "managed"): string {
  const normalizedRoot = normalizeAbsolutePath(root, `${label} root`);
  const normalizedCandidate = normalizeAbsolutePath(candidate, `${label} path`);
  const rel = relative(normalizedRoot, normalizedCandidate);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new TypeError(`${label} path escapes its root: ${candidate}`);
  }
  return normalizedCandidate;
}

function managerXdgPath(value: string | undefined, home: string, fallback: string): string {
  const configured = nonEmpty(value);
  let base: string;
  if (configured !== undefined && isAbsolute(configured)) {
    base = normalizeAbsolutePath(configured, "XDG home");
  } else {
    base = child(home, fallback);
  }
  return child(base, "zig-manager");
}

function denoGlobalBinPath(value: string | undefined, home: string): string {
  const configured = nonEmpty(value);
  const root = configured === undefined
    ? child(home, ".deno")
    : normalizeAbsolutePath(configured, "DENO_INSTALL_ROOT");
  return child(root, "bin");
}

function child(root: string, ...segments: string[]): string {
  const candidate = resolve(root, ...segments);
  assertContainedPath(root, candidate);
  if (candidate === resolve(root)) {
    throw new TypeError("managed child path must be below its root");
  }
  return candidate;
}

function normalizeAbsolutePath(path: string, label: string): string {
  if (path.length === 0) throw new TypeError(`${label} must not be empty`);
  if (hasControlCharacter(path)) {
    throw new TypeError(`${label} contains a control character`);
  }
  if (!isAbsolute(path)) throw new TypeError(`${label} must be an absolute path: ${path}`);
  const normalized = resolve(path);
  if (normalized === "/") throw new TypeError(`${label} must not be the filesystem root`);
  return normalized;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value.length === 0 ? undefined : value;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
