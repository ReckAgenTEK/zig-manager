import { join, resolve } from "@std/path";
import {
  MINIMUM_FREE_DISK_BYTES,
  RECOMMENDED_FREE_DISK_BYTES,
  RECOMMENDED_MEMORY_BYTES,
} from "./constants.ts";
import type {
  DiagnosticCacheResult,
  DiagnosticFilesystemKind,
  DiagnosticFilesystemResult,
  DiagnosticMemoryResult,
  DiagnosticResourceResult,
} from "./types.ts";

const MAX_CACHE_ENTRIES = 100_000;

export interface DiagnosticResourcePaths {
  readonly cacheBuild: string;
  readonly dataStaging: string;
  readonly scope?: string;
  readonly cacheRoot: string;
}

/** Injectable high-level seam around the Deno host APIs used only by diagnostics. */
export interface DiagnosticProbe {
  inspectFilesystem(
    path: string,
    kind: DiagnosticFilesystemKind,
  ): Promise<DiagnosticFilesystemResult>;
  inspectMemory(): Promise<DiagnosticMemoryResult>;
  inspectCache(path: string, thresholdBytes: number | null): Promise<DiagnosticCacheResult>;
  readTextFile(path: string): Promise<string>;
  now(): Date;
}

export class DenoDiagnosticProbe implements DiagnosticProbe {
  async inspectFilesystem(
    path: string,
    kind: DiagnosticFilesystemKind,
  ): Promise<DiagnosticFilesystemResult> {
    const requested = resolve(path);
    const located = await locatePhysicalDirectory(requested);
    if (!located.ok) {
      return filesystemResult(kind, requested, located.checkedPath, false, null, located.message);
    }

    const writable = await probeWritable(located.checkedPath);
    const availableBytes = await availableFilesystemBytes(located.checkedPath);
    return filesystemResult(
      kind,
      requested,
      located.checkedPath,
      writable.ok,
      availableBytes,
      writable.message,
    );
  }

  inspectMemory(): Promise<DiagnosticMemoryResult> {
    const deno = Deno as unknown as {
      systemMemoryInfo?: () => {
        total: number;
        available: number;
      };
    };
    if (deno.systemMemoryInfo === undefined) {
      return Promise.resolve(memoryResult(null, null, "Deno.systemMemoryInfo is unavailable"));
    }
    try {
      const memory = deno.systemMemoryInfo();
      if (!safeByteCount(memory.total) || !safeByteCount(memory.available)) {
        return Promise.resolve(
          memoryResult(null, null, "Deno returned invalid memory information"),
        );
      }
      return Promise.resolve(memoryResult(memory.total, memory.available, null));
    } catch (cause) {
      return Promise.resolve(memoryResult(null, null, errorMessage(cause)));
    }
  }

  async inspectCache(
    path: string,
    thresholdBytes: number | null,
  ): Promise<DiagnosticCacheResult> {
    const requested = resolve(path);
    if (thresholdBytes === null) {
      return {
        path: requested,
        thresholdBytes,
        measuredBytes: null,
        complete: null,
        message: null,
      };
    }
    const measured = await measureCache(requested, thresholdBytes);
    return {
      path: requested,
      thresholdBytes,
      measuredBytes: measured.bytes,
      complete: measured.complete,
      message: measured.message,
    };
  }

  readTextFile(path: string): Promise<string> {
    return Deno.readTextFile(path);
  }

  now(): Date {
    return new Date();
  }
}

export async function inspectDiagnosticResources(
  probe: DiagnosticProbe,
  paths: DiagnosticResourcePaths,
  cacheThresholdBytes: number | null,
): Promise<DiagnosticResourceResult> {
  const requests: readonly (readonly [DiagnosticFilesystemKind, string])[] = [
    ["cache-build", paths.cacheBuild],
    ["data-staging", paths.dataStaging],
    ...(paths.scope === undefined ? [] : [["scope", paths.scope] as const]),
  ];
  const filesystems = await Promise.all(
    requests.map(([kind, path]) => probe.inspectFilesystem(path, kind)),
  );
  const [memory, cache] = await Promise.all([
    probe.inspectMemory(),
    probe.inspectCache(paths.cacheRoot, cacheThresholdBytes),
  ]);
  return { filesystems, memory, cache };
}

function filesystemResult(
  kind: DiagnosticFilesystemKind,
  path: string,
  checkedPath: string,
  writable: boolean,
  availableBytes: number | null,
  message: string | null,
): DiagnosticFilesystemResult {
  return {
    kind,
    path,
    checkedPath,
    writable,
    availableBytes,
    minimumBytes: MINIMUM_FREE_DISK_BYTES,
    recommendedBytes: RECOMMENDED_FREE_DISK_BYTES,
    message,
  };
}

function memoryResult(
  totalBytes: number | null,
  availableBytes: number | null,
  message: string | null,
): DiagnosticMemoryResult {
  return {
    totalBytes,
    availableBytes,
    recommendedBytes: RECOMMENDED_MEMORY_BYTES,
    message,
  };
}

async function locatePhysicalDirectory(path: string): Promise<
  | { readonly ok: true; readonly checkedPath: string }
  | { readonly ok: false; readonly checkedPath: string; readonly message: string }
> {
  const segments = resolve(path).split("/").filter(Boolean);
  let current = "/";
  let lastDirectory = "/";
  for (const segment of segments) {
    current = join(current, segment);
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(current);
    } catch (cause) {
      if (cause instanceof Deno.errors.NotFound) {
        return { ok: true, checkedPath: lastDirectory };
      }
      return { ok: false, checkedPath: lastDirectory, message: errorMessage(cause) };
    }
    if (info.isSymlink) {
      return {
        ok: false,
        checkedPath: current,
        message: `path traverses symbolic link ${current}`,
      };
    }
    if (!info.isDirectory) {
      return {
        ok: false,
        checkedPath: current,
        message: `path component is not a directory: ${current}`,
      };
    }
    lastDirectory = current;
  }
  return { ok: true, checkedPath: lastDirectory };
}

async function probeWritable(path: string): Promise<{
  readonly ok: boolean;
  readonly message: string | null;
}> {
  const temporary = join(path, `.zig-manager-write-probe-${crypto.randomUUID()}`);
  let created = false;
  try {
    const file = await Deno.open(temporary, { createNew: true, write: true });
    created = true;
    try {
      await file.write(new Uint8Array([0]));
      await file.sync();
    } finally {
      file.close();
    }
    return { ok: true, message: null };
  } catch (cause) {
    return { ok: false, message: errorMessage(cause) };
  } finally {
    if (created) {
      try {
        await Deno.remove(temporary);
      } catch {
        // The probe result already records whether the directory was writable.
      }
    }
  }
}

async function availableFilesystemBytes(path: string): Promise<number | null> {
  const deno = Deno as unknown as {
    statfs?: (path: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;
  };
  if (deno.statfs === undefined) return null;
  try {
    const stat = await deno.statfs(path);
    const value = BigInt(stat.bavail) * BigInt(stat.bsize);
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : Number.MAX_SAFE_INTEGER;
  } catch {
    return null;
  }
}

async function measureCache(
  path: string,
  thresholdBytes: number,
): Promise<
  { readonly bytes: number | null; readonly complete: boolean; readonly message: string | null }
> {
  const located = await locatePhysicalDirectory(path);
  if (!located.ok) return { bytes: null, complete: false, message: located.message };
  if (located.checkedPath !== resolve(path)) {
    return { bytes: 0, complete: true, message: null };
  }
  let root: Deno.FileInfo;
  try {
    root = await Deno.lstat(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return { bytes: 0, complete: true, message: null };
    return { bytes: null, complete: false, message: errorMessage(cause) };
  }
  if (!root.isDirectory || root.isSymlink) {
    return {
      bytes: null,
      complete: false,
      message: "cache root is not a physical directory",
    };
  }

  const pending = [path];
  let entries = 0;
  let bytes = 0;
  try {
    while (pending.length > 0) {
      const directory = pending.pop()!;
      for await (const entry of Deno.readDir(directory)) {
        entries++;
        if (entries > MAX_CACHE_ENTRIES) {
          return { bytes, complete: false, message: "cache entry bound was reached" };
        }
        const child = join(directory, entry.name);
        const info = await Deno.lstat(child);
        if (info.isSymlink) {
          return { bytes, complete: false, message: `cache contains symbolic link ${child}` };
        }
        if (info.isDirectory) {
          pending.push(child);
        } else if (info.isFile) {
          bytes = Math.min(Number.MAX_SAFE_INTEGER, bytes + info.size);
          if (bytes > thresholdBytes) {
            return {
              bytes,
              complete: false,
              message: "measurement stopped after exceeding the configured threshold",
            };
          }
        } else {
          return { bytes, complete: false, message: `cache contains special entry ${child}` };
        }
      }
    }
    return { bytes, complete: true, message: null };
  } catch (cause) {
    return { bytes: null, complete: false, message: errorMessage(cause) };
  }
}

function safeByteCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
