import { dirname, join, resolve } from "@std/path";

export const SCOPE_DIRECTORY_NAME = ".zig-manager";
export const SCOPE_PIN_FILE_NAME = "toolchain";
export const SCOPE_FORMAT_HEADER = "zig-manager-scope-v1";
export const PROFILE_ID_LENGTH = 64;
export const SCOPE_PIN_SIZE_WITHOUT_FINAL_NEWLINE =
  `${SCOPE_FORMAT_HEADER}\nprofile=${"0".repeat(PROFILE_ID_LENGTH)}`.length;
export const SCOPE_PIN_SIZE_WITH_FINAL_NEWLINE = SCOPE_PIN_SIZE_WITHOUT_FINAL_NEWLINE + 1;

const PROFILE_ID_PATTERN = /^[0-9a-f]{64}$/;

export class ScopePathError extends Error {
  readonly code = "ZIG_SCOPE_INVALID";
  readonly path: string;
  readonly reason: string;

  constructor(path: string, reason: string, options?: ErrorOptions) {
    super(`Invalid Zig scope '${path}': ${reason}`, options);
    this.name = "ScopePathError";
    this.path = path;
    this.reason = reason;
  }
}

export class ScopePinError extends Error {
  readonly code = "ZIG_SCOPE_PIN_INVALID";
  readonly pinPath: string;
  readonly reason: string;

  constructor(pinPath: string, reason: string, options?: ErrorOptions) {
    super(`Invalid Zig scope pin '${pinPath}': ${reason}`, options);
    this.name = "ScopePinError";
    this.pinPath = pinPath;
    this.reason = reason;
  }
}

export interface ParsedScopePin {
  readonly schema: typeof SCOPE_FORMAT_HEADER;
  readonly profileId: string;
}

export interface ResolvedScopePin extends ParsedScopePin {
  readonly lookupPath: string;
  readonly scopeRoot: string;
  readonly pinPath: string;
}

export function isProfileId(value: string): boolean {
  return PROFILE_ID_PATTERN.test(value);
}

export function assertProfileId(value: string): string {
  if (!isProfileId(value)) {
    throw new ScopePinError(
      "<profile-id>",
      `profile ID must be exactly ${PROFILE_ID_LENGTH} lowercase hexadecimal characters`,
    );
  }
  return value;
}

export function serializeScopePin(profileId: string): string {
  assertProfileId(profileId);
  return `${SCOPE_FORMAT_HEADER}\nprofile=${profileId}\n`;
}

export function parseScopePin(text: string, pinPath = "<scope-pin>"): ParsedScopePin {
  const content = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines = content.split("\n");
  if (lines.length !== 2) {
    throw new ScopePinError(pinPath, "expected exactly two lines");
  }
  if (lines[0] !== SCOPE_FORMAT_HEADER) {
    throw new ScopePinError(pinPath, `first line must be '${SCOPE_FORMAT_HEADER}'`);
  }
  if (!lines[1].startsWith("profile=")) {
    throw new ScopePinError(pinPath, "second line must begin with 'profile='");
  }
  const profileId = lines[1].slice("profile=".length);
  if (!isProfileId(profileId)) {
    throw new ScopePinError(
      pinPath,
      `profile ID must be exactly ${PROFILE_ID_LENGTH} lowercase hexadecimal characters`,
    );
  }
  return { schema: SCOPE_FORMAT_HEADER, profileId };
}

export async function resolvePhysicalScopeDirectory(path: string): Promise<string> {
  assertScopePathText(path);
  let physical: string;
  try {
    physical = await Deno.realPath(path);
  } catch (cause) {
    throw new ScopePathError(path, "directory does not exist or cannot be resolved", { cause });
  }
  assertScopePathText(physical);
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(physical);
  } catch (cause) {
    throw new ScopePathError(path, "directory cannot be inspected", { cause });
  }
  if (!info.isDirectory) throw new ScopePathError(path, "scope path is not a directory");
  return resolve(physical);
}

export function assertScopePathText(path: string): void {
  if (path.length === 0) throw new ScopePathError(path, "path must not be empty");
  if (hasControlCharacter(path)) {
    throw new ScopePathError(path, "path contains a control character");
  }
}

export class ScopeResolver {
  async resolve(path: string): Promise<ResolvedScopePin | null> {
    const lookupPath = await resolvePhysicalScopeDirectory(path);
    let scopeRoot = lookupPath;

    while (true) {
      const metadataDirectory = join(scopeRoot, SCOPE_DIRECTORY_NAME);
      const pinPath = join(metadataDirectory, SCOPE_PIN_FILE_NAME);
      const metadataInfo = await lstatIfPresent(metadataDirectory);
      if (metadataInfo !== null) {
        await assertPhysicalMetadataDirectory(metadataDirectory, pinPath, metadataInfo);
      }
      const pinInfo = await lstatIfPresent(pinPath);
      if (pinInfo !== null) {
        await assertReadablePinPath(pinPath, pinInfo);
        let text: string;
        try {
          text = await Deno.readTextFile(pinPath);
        } catch (cause) {
          throw new ScopePinError(pinPath, "pin cannot be read", { cause });
        }
        const pin = parseScopePin(text, pinPath);
        return { ...pin, lookupPath, scopeRoot, pinPath };
      }

      const parent = dirname(scopeRoot);
      if (parent === scopeRoot) return null;
      scopeRoot = parent;
    }
  }
}

export async function resolveScopePin(path: string): Promise<ResolvedScopePin | null> {
  return await new ScopeResolver().resolve(path);
}

async function assertReadablePinPath(
  pinPath: string,
  pinInfo: Deno.FileInfo,
): Promise<void> {
  if (!pinInfo.isFile || pinInfo.isSymlink) {
    throw new ScopePinError(pinPath, "pin is not a physical regular file");
  }
  if (
    pinInfo.size !== SCOPE_PIN_SIZE_WITHOUT_FINAL_NEWLINE &&
    pinInfo.size !== SCOPE_PIN_SIZE_WITH_FINAL_NEWLINE
  ) {
    throw new ScopePinError(pinPath, "expected exactly two protocol lines");
  }

  try {
    const physicalPin = resolve(await Deno.realPath(pinPath));
    if (physicalPin !== resolve(pinPath)) {
      throw new ScopePinError(pinPath, "pin path traverses a symbolic link");
    }
  } catch (cause) {
    if (cause instanceof ScopePinError) throw cause;
    throw new ScopePinError(pinPath, "pin path cannot be resolved safely", { cause });
  }
}

async function assertPhysicalMetadataDirectory(
  metadataDirectory: string,
  pinPath: string,
  metadataInfo: Deno.FileInfo,
): Promise<void> {
  if (!metadataInfo.isDirectory || metadataInfo.isSymlink) {
    throw new ScopePinError(pinPath, `${SCOPE_DIRECTORY_NAME} is not a physical directory`);
  }
  try {
    if (resolve(await Deno.realPath(metadataDirectory)) !== resolve(metadataDirectory)) {
      throw new ScopePinError(pinPath, `${SCOPE_DIRECTORY_NAME} traverses a symbolic link`);
    }
  } catch (cause) {
    if (cause instanceof ScopePinError) throw cause;
    throw new ScopePinError(pinPath, `${SCOPE_DIRECTORY_NAME} cannot be resolved safely`, {
      cause,
    });
  }
}

async function lstatIfPresent(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.lstat(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return null;
    throw new ScopePathError(path, "path cannot be inspected", { cause });
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
