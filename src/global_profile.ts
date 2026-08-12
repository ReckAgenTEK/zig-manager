import { dirname, isAbsolute, resolve } from "@std/path";

export const GLOBAL_PROFILE_FILE_NAME = "global-profile";
export const GLOBAL_PROFILE_FORMAT_HEADER = "zig-manager-global-v1";
export const GLOBAL_PROFILE_ID_LENGTH = 64;
export const GLOBAL_PROFILE_SIZE_WITHOUT_FINAL_NEWLINE: number =
  `${GLOBAL_PROFILE_FORMAT_HEADER}\nprofile=${"0".repeat(GLOBAL_PROFILE_ID_LENGTH)}`.length;
export const GLOBAL_PROFILE_SIZE_WITH_FINAL_NEWLINE: number =
  GLOBAL_PROFILE_SIZE_WITHOUT_FINAL_NEWLINE + 1;

const PROFILE_ID_PATTERN = /^[0-9a-f]{64}$/;

export interface ParsedGlobalProfile {
  readonly schema: typeof GLOBAL_PROFILE_FORMAT_HEADER;
  readonly profileId: string;
}

export interface StoredGlobalProfile extends ParsedGlobalProfile {
  readonly pointerPath: string;
}

export class GlobalProfileError extends Error {
  readonly code = "ZIG_GLOBAL_PROFILE_INVALID";
  readonly pointerPath: string;
  readonly reason: string;

  constructor(pointerPath: string, reason: string, options?: ErrorOptions) {
    super(`Invalid zig-manager global profile pointer '${pointerPath}': ${reason}`, options);
    this.name = "GlobalProfileError";
    this.pointerPath = pointerPath;
    this.reason = reason;
  }
}

export function serializeGlobalProfile(profileId: string): string {
  assertGlobalProfileId(profileId, "<profile-id>");
  return `${GLOBAL_PROFILE_FORMAT_HEADER}\nprofile=${profileId}\n`;
}

export function parseGlobalProfile(
  text: string,
  pointerPath = "<global-profile>",
): ParsedGlobalProfile {
  const content = text.endsWith("\n") ? text.slice(0, -1) : text;
  const lines = content.split("\n");
  if (lines.length !== 2) {
    throw new GlobalProfileError(pointerPath, "expected exactly two lines");
  }
  if (lines[0] !== GLOBAL_PROFILE_FORMAT_HEADER) {
    throw new GlobalProfileError(
      pointerPath,
      `first line must be '${GLOBAL_PROFILE_FORMAT_HEADER}'`,
    );
  }
  if (!lines[1].startsWith("profile=")) {
    throw new GlobalProfileError(pointerPath, "second line must begin with 'profile='");
  }
  const profileId = lines[1].slice("profile=".length);
  assertGlobalProfileId(profileId, pointerPath);
  return { schema: GLOBAL_PROFILE_FORMAT_HEADER, profileId };
}

export class GlobalProfileStore {
  readonly pointerPath: string;

  constructor(pointerPath: string) {
    this.pointerPath = normalizePointerPath(pointerPath);
  }

  async read(): Promise<StoredGlobalProfile | null> {
    const parent = dirname(this.pointerPath);
    if (!await ensurePhysicalDirectoryTree(parent, false, this.pointerPath)) return null;
    const info = await lstatIfPresent(this.pointerPath);
    if (info === null) return null;
    await assertPhysicalPointer(this.pointerPath, info);
    let text: string;
    try {
      text = await Deno.readTextFile(this.pointerPath);
    } catch (cause) {
      throw new GlobalProfileError(this.pointerPath, "pointer cannot be read", { cause });
    }
    return { ...parseGlobalProfile(text, this.pointerPath), pointerPath: this.pointerPath };
  }

  async write(profileId: string): Promise<StoredGlobalProfile> {
    const text = serializeGlobalProfile(profileId);
    const parent = dirname(this.pointerPath);
    await ensurePhysicalDirectoryTree(parent, true, this.pointerPath);
    await assertReplaceablePointer(this.pointerPath);

    const temporaryPath = `${this.pointerPath}.tmp-${crypto.randomUUID()}`;
    let temporaryOwned = false;
    try {
      const file = await Deno.open(temporaryPath, {
        createNew: true,
        write: true,
        mode: 0o600,
      });
      temporaryOwned = true;
      try {
        await writeAll(file, new TextEncoder().encode(text));
        await file.sync();
      } finally {
        file.close();
      }
      await Deno.chmod(temporaryPath, 0o644);
      const temporaryInfo = await Deno.lstat(temporaryPath);
      await assertPhysicalPointer(temporaryPath, temporaryInfo);
      parseGlobalProfile(await Deno.readTextFile(temporaryPath), temporaryPath);

      if (!await ensurePhysicalDirectoryTree(parent, false, this.pointerPath)) {
        throw new GlobalProfileError(this.pointerPath, "pointer parent disappeared before publish");
      }
      await assertReplaceablePointer(this.pointerPath);
      await Deno.rename(temporaryPath, this.pointerPath);
      temporaryOwned = false;
    } catch (cause) {
      if (temporaryOwned) await removeTemporary(temporaryPath);
      if (cause instanceof GlobalProfileError) throw cause;
      throw new GlobalProfileError(this.pointerPath, "pointer could not be written atomically", {
        cause,
      });
    }

    return {
      schema: GLOBAL_PROFILE_FORMAT_HEADER,
      profileId,
      pointerPath: this.pointerPath,
    };
  }

  async remove(): Promise<boolean> {
    const parent = dirname(this.pointerPath);
    if (!await ensurePhysicalDirectoryTree(parent, false, this.pointerPath)) return false;
    const info = await lstatIfPresent(this.pointerPath);
    if (info === null) return false;
    await assertPhysicalPointer(this.pointerPath, info, false);
    try {
      await Deno.remove(this.pointerPath);
    } catch (cause) {
      throw new GlobalProfileError(this.pointerPath, "pointer could not be removed", { cause });
    }
    return true;
  }
}

export async function readGlobalProfile(pointerPath: string): Promise<StoredGlobalProfile | null> {
  return await new GlobalProfileStore(pointerPath).read();
}

export async function writeGlobalProfile(
  pointerPath: string,
  profileId: string,
): Promise<StoredGlobalProfile> {
  return await new GlobalProfileStore(pointerPath).write(profileId);
}

export async function removeGlobalProfile(pointerPath: string): Promise<boolean> {
  return await new GlobalProfileStore(pointerPath).remove();
}

function assertGlobalProfileId(profileId: string, pointerPath: string): string {
  if (!PROFILE_ID_PATTERN.test(profileId)) {
    throw new GlobalProfileError(
      pointerPath,
      `profile ID must be exactly ${GLOBAL_PROFILE_ID_LENGTH} lowercase hexadecimal characters`,
    );
  }
  return profileId;
}

function normalizePointerPath(path: string): string {
  if (path.length === 0 || !isAbsolute(path)) {
    throw new GlobalProfileError(path, "pointer path must be absolute");
  }
  if (hasControlCharacter(path)) {
    throw new GlobalProfileError(path, "pointer path contains a control character");
  }
  const normalized = resolve(path);
  if (normalized === "/") {
    throw new GlobalProfileError(path, "pointer path must not be the filesystem root");
  }
  return normalized;
}

async function ensurePhysicalDirectoryTree(
  path: string,
  create: boolean,
  pointerPath: string,
): Promise<boolean> {
  const missing: string[] = [];
  let current = resolve(path);
  while (true) {
    const info = await lstatIfPresent(current);
    if (info !== null) {
      await assertPhysicalDirectory(current, info, pointerPath);
      break;
    }
    missing.push(current);
    const parent = dirname(current);
    if (parent === current) {
      throw new GlobalProfileError(pointerPath, "no physical pointer parent exists");
    }
    current = parent;
  }

  if (!create) return missing.length === 0;
  for (const directory of missing.reverse()) {
    try {
      await Deno.mkdir(directory, { mode: 0o700 });
    } catch (cause) {
      if (!(cause instanceof Deno.errors.AlreadyExists)) {
        throw new GlobalProfileError(pointerPath, "pointer parent could not be created", { cause });
      }
    }
    const info = await lstatIfPresent(directory);
    if (info === null) {
      throw new GlobalProfileError(pointerPath, "pointer parent disappeared during creation");
    }
    await assertPhysicalDirectory(directory, info, pointerPath);
  }
  return true;
}

async function assertPhysicalDirectory(
  path: string,
  info: Deno.FileInfo,
  pointerPath: string,
): Promise<void> {
  if (!info.isDirectory || info.isSymlink) {
    throw new GlobalProfileError(
      pointerPath,
      `pointer parent is not a physical directory: ${path}`,
    );
  }
  let physical: string;
  try {
    physical = resolve(await Deno.realPath(path));
  } catch (cause) {
    throw new GlobalProfileError(pointerPath, `pointer parent cannot be resolved safely: ${path}`, {
      cause,
    });
  }
  if (physical !== resolve(path)) {
    throw new GlobalProfileError(pointerPath, `pointer parent traverses a symbolic link: ${path}`);
  }
}

async function assertPhysicalPointer(
  path: string,
  info: Deno.FileInfo,
  requireProtocolSize = true,
): Promise<void> {
  if (!info.isFile || info.isSymlink) {
    throw new GlobalProfileError(path, "pointer is not a physical regular file");
  }
  if (
    requireProtocolSize &&
    info.size !== GLOBAL_PROFILE_SIZE_WITHOUT_FINAL_NEWLINE &&
    info.size !== GLOBAL_PROFILE_SIZE_WITH_FINAL_NEWLINE
  ) {
    throw new GlobalProfileError(path, "expected exactly two protocol lines");
  }
  let physical: string;
  try {
    physical = resolve(await Deno.realPath(path));
  } catch (cause) {
    throw new GlobalProfileError(path, "pointer path cannot be resolved safely", { cause });
  }
  if (physical !== resolve(path)) {
    throw new GlobalProfileError(path, "pointer path traverses a symbolic link");
  }
}

async function assertReplaceablePointer(path: string): Promise<void> {
  const info = await lstatIfPresent(path);
  if (info !== null && (!info.isFile || info.isSymlink)) {
    throw new GlobalProfileError(path, "existing pointer is not a physical regular file");
  }
}

async function lstatIfPresent(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.lstat(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return null;
    throw new GlobalProfileError(path, "pointer path cannot be inspected", { cause });
  }
}

async function writeAll(file: Deno.FsFile, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) offset += await file.write(bytes.subarray(offset));
}

async function removeTemporary(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound)) {
      // Preserve the original publication failure.
    }
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
