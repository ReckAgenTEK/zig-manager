import { dirname, join, resolve } from "@std/path";
import { ZigOperationAbortedError } from "./errors.ts";
import {
  parseScopePin,
  resolvePhysicalScopeDirectory,
  SCOPE_DIRECTORY_NAME,
  SCOPE_PIN_FILE_NAME,
  ScopePathError,
  serializeScopePin,
} from "./scope_resolver.ts";

const encoder = new TextEncoder();
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ScopePinMutationOptions {
  readonly signal?: AbortSignal;
  readonly operationId?: string;
}

export interface ScopePinWriteResult {
  readonly scopeRoot: string;
  readonly pinPath: string;
  readonly profileId: string;
}

export class ScopePinStore {
  async write(
    scopePath: string,
    profileId: string,
    options: ScopePinMutationOptions = {},
  ): Promise<ScopePinWriteResult> {
    const operationId = validateOperationId(options.operationId ?? crypto.randomUUID());
    throwIfAborted(options.signal, "publish scope pin", scopePath);
    const text = serializeScopePin(profileId);
    const scopeRoot = await resolvePhysicalScopeDirectory(scopePath);
    throwIfAborted(options.signal, "publish scope pin", scopeRoot);
    const metadataDirectory = join(scopeRoot, SCOPE_DIRECTORY_NAME);
    const pinPath = join(metadataDirectory, SCOPE_PIN_FILE_NAME);
    assertDirectChild(scopeRoot, metadataDirectory);
    assertDirectChild(metadataDirectory, pinPath);
    await ensurePhysicalDirectory(metadataDirectory);
    await assertReplaceablePin(pinPath);
    throwIfAborted(options.signal, "publish scope pin", pinPath);

    const temporaryPath = join(metadataDirectory, `.toolchain.tmp-${operationId}`);
    let temporaryOwned = false;
    try {
      const file = await Deno.open(temporaryPath, {
        createNew: true,
        write: true,
        mode: 0o600,
      });
      temporaryOwned = true;
      try {
        await writeAll(file, encoder.encode(text));
        await file.sync();
      } finally {
        file.close();
      }
      throwIfAborted(options.signal, "publish scope pin", pinPath);
      await Deno.chmod(temporaryPath, 0o644);
      parseScopePin(await Deno.readTextFile(temporaryPath), temporaryPath);
      throwIfAborted(options.signal, "publish scope pin", pinPath);
      await Deno.rename(temporaryPath, pinPath);
    } catch (cause) {
      if (temporaryOwned) await removeTemporary(temporaryPath);
      if (cause instanceof ScopePathError || cause instanceof ZigOperationAbortedError) throw cause;
      throw new ScopePathError(pinPath, "pin could not be written atomically", { cause });
    }

    return { scopeRoot, pinPath, profileId };
  }

  async remove(scopePath: string, options: ScopePinMutationOptions = {}): Promise<boolean> {
    validateOperationId(options.operationId ?? crypto.randomUUID());
    throwIfAborted(options.signal, "remove scope pin", scopePath);
    const scopeRoot = await resolvePhysicalScopeDirectory(scopePath);
    throwIfAborted(options.signal, "remove scope pin", scopeRoot);
    const metadataDirectory = join(scopeRoot, SCOPE_DIRECTORY_NAME);
    const pinPath = join(metadataDirectory, SCOPE_PIN_FILE_NAME);
    assertDirectChild(scopeRoot, metadataDirectory);
    assertDirectChild(metadataDirectory, pinPath);

    const metadataInfo = await lstatIfPresent(metadataDirectory);
    if (metadataInfo === null) return false;
    await assertExistingPhysicalDirectory(metadataDirectory, metadataInfo);

    const pinInfo = await lstatIfPresent(pinPath);
    if (pinInfo === null) return false;
    if (!pinInfo.isFile || pinInfo.isSymlink) {
      throw new ScopePathError(pinPath, "exact scope pin is not a physical regular file");
    }

    try {
      throwIfAborted(options.signal, "remove scope pin", pinPath);
      await Deno.remove(pinPath);
    } catch (cause) {
      throw new ScopePathError(pinPath, "exact scope pin could not be removed", { cause });
    }
    await removeDirectoryIfEmpty(metadataDirectory);
    return true;
  }
}

export async function writeScopePin(
  scopePath: string,
  profileId: string,
  options: ScopePinMutationOptions = {},
): Promise<ScopePinWriteResult> {
  return await new ScopePinStore().write(scopePath, profileId, options);
}

export async function removeScopePin(
  scopePath: string,
  options: ScopePinMutationOptions = {},
): Promise<boolean> {
  return await new ScopePinStore().remove(scopePath, options);
}

async function ensurePhysicalDirectory(path: string): Promise<void> {
  let info = await lstatIfPresent(path);
  if (info === null) {
    try {
      await Deno.mkdir(path, { mode: 0o755 });
    } catch (cause) {
      if (!(cause instanceof Deno.errors.AlreadyExists)) {
        throw new ScopePathError(path, "scope metadata directory could not be created", { cause });
      }
    }
    info = await lstatIfPresent(path);
  }
  if (info === null) throw new ScopePathError(path, "scope metadata directory is missing");
  await assertExistingPhysicalDirectory(path, info);
}

async function assertExistingPhysicalDirectory(path: string, info: Deno.FileInfo): Promise<void> {
  if (!info.isDirectory || info.isSymlink) {
    throw new ScopePathError(path, "scope metadata path is not a physical directory");
  }
  try {
    if (resolve(await Deno.realPath(path)) !== resolve(path)) {
      throw new ScopePathError(path, "scope metadata path traverses a symbolic link");
    }
  } catch (cause) {
    if (cause instanceof ScopePathError) throw cause;
    throw new ScopePathError(path, "scope metadata path cannot be resolved safely", { cause });
  }
}

async function assertReplaceablePin(path: string): Promise<void> {
  const info = await lstatIfPresent(path);
  if (info !== null && (!info.isFile || info.isSymlink)) {
    throw new ScopePathError(path, "existing scope pin is not a physical regular file");
  }
}

function assertDirectChild(root: string, candidate: string): void {
  if (dirname(resolve(candidate)) !== resolve(root)) {
    throw new ScopePathError(candidate, "managed path escapes its scope root");
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

async function writeAll(file: Deno.FsFile, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) offset += await file.write(bytes.subarray(offset));
}

async function removeTemporary(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound)) {
      // Preserve the original write failure.
    }
  }
}

async function removeDirectoryIfEmpty(path: string): Promise<void> {
  try {
    for await (const _entry of Deno.readDir(path)) return;
    await Deno.remove(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return;
    // Pin removal already succeeded; an empty metadata directory is harmless.
  }
}

function validateOperationId(value: string): string {
  if (!OPERATION_ID.test(value)) throw new TypeError("operationId must be a canonical UUID");
  return value;
}

function throwIfAborted(
  signal: AbortSignal | undefined,
  operation: string,
  path: string,
): void {
  if (signal?.aborted) {
    throw new ZigOperationAbortedError(operation, { path }, { cause: signal.reason });
  }
}
