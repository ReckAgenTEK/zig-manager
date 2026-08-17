import { join, relative, resolve } from "@std/path";
import { ZigBuildError, ZigOperationAbortedError } from "./errors.ts";
import { assertPathContained, canonicalJson, removeIfPresent } from "./filesystem.ts";

export const MANAGED_ZIG_SOURCE_DIRECTORY = "src/zig";
export const MANAGED_ZIG_SOURCE_MANIFEST = "src/source.json";

interface SourceSnapshotManifest {
  readonly schemaVersion: 1;
  readonly selector: string;
  readonly version: string;
  readonly commit: string;
  readonly root: "zig";
  readonly files: number;
}

/** Copy an exact, read-only-friendly Zig worktree into the managed install. */
export async function buildManagedSourceSnapshot(input: {
  readonly checkoutPath: string;
  readonly installPath: string;
  readonly selector: string;
  readonly version: string;
  readonly commit: string;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const destination = join(input.installPath, ...MANAGED_ZIG_SOURCE_DIRECTORY.split("/"));
  await removeIfPresent(destination, true);
  await Deno.mkdir(destination, { recursive: true });
  const files = await copySourceTree(input.checkoutPath, destination, input.signal);
  if (files === 0) {
    throw new ZigBuildError("Managed Zig source snapshot is empty", {
      checkoutPath: input.checkoutPath,
    });
  }
  const manifest: SourceSnapshotManifest = {
    schemaVersion: 1,
    selector: input.selector,
    version: input.version,
    commit: input.commit,
    root: "zig",
    files,
  };
  await Deno.writeTextFile(
    join(input.installPath, ...MANAGED_ZIG_SOURCE_MANIFEST.split("/")),
    `${canonicalJson(manifest, 2)}\n`,
  );
}

export async function verifyManagedSourceSnapshot(
  installPath: string,
  expectedVersion: string,
  expectedCommit: string,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new ZigOperationAbortedError("verify managed Zig source snapshot");
  const manifestPath = join(installPath, ...MANAGED_ZIG_SOURCE_MANIFEST.split("/"));
  let value: unknown;
  try {
    value = JSON.parse(await Deno.readTextFile(manifestPath));
  } catch (cause) {
    throw new ZigBuildError("Managed Zig source manifest cannot be read", {
      manifestPath,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ZigBuildError("Managed Zig source manifest is invalid", { manifestPath });
  }
  const manifest = value as Record<string, unknown>;
  if (
    manifest.schemaVersion !== 1 || manifest.root !== "zig" ||
    manifest.version !== expectedVersion || manifest.commit !== expectedCommit ||
    typeof manifest.files !== "number" || !Number.isSafeInteger(manifest.files) ||
    manifest.files < 1
  ) throw new ZigBuildError("Managed Zig source provenance is invalid", { manifestPath });
  const root = join(installPath, ...MANAGED_ZIG_SOURCE_DIRECTORY.split("/"));
  const rootInfo = await Deno.lstat(root).catch(() => null);
  const cmakeInfo = await Deno.lstat(join(root, "CMakeLists.txt")).catch(() => null);
  if (rootInfo?.isDirectory !== true || rootInfo.isSymlink || cmakeInfo?.isFile !== true) {
    throw new ZigBuildError("Managed Zig source snapshot is incomplete", { root });
  }
}

async function copySourceTree(
  sourceRootValue: string,
  destinationRootValue: string,
  signal?: AbortSignal,
): Promise<number> {
  const sourceRoot = resolve(sourceRootValue);
  const destinationRoot = resolve(destinationRootValue);
  let files = 0;
  const pending = [{ source: sourceRoot, destination: destinationRoot }];
  while (pending.length > 0) {
    if (signal?.aborted) throw new ZigOperationAbortedError("copy managed Zig source snapshot");
    const current = pending.pop()!;
    const entries = [];
    for await (const entry of Deno.readDir(current.source)) entries.push(entry);
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index];
      if (shouldSkipSourceEntry(current.source, sourceRoot, entry.name)) continue;
      const source = assertPathContained(sourceRoot, join(current.source, entry.name));
      const destination = assertPathContained(
        destinationRoot,
        join(current.destination, entry.name),
      );
      const info = await Deno.lstat(source);
      if (info.isDirectory && !info.isSymlink) {
        await Deno.mkdir(destination);
        pending.push({ source, destination });
      } else if (info.isFile) {
        await Deno.copyFile(source, destination);
        files++;
      } else if (info.isSymlink) {
        const target = await Deno.realPath(source);
        assertPathContained(sourceRoot, target);
        const targetInfo = await Deno.stat(target);
        if (!targetInfo.isFile) {
          throw new ZigBuildError("Managed Zig source contains unsupported directory symlink", {
            source,
            target,
          });
        }
        await Deno.copyFile(target, destination);
        files++;
      } else {
        throw new ZigBuildError("Managed Zig source contains a special filesystem entry", {
          source,
        });
      }
    }
  }
  return files;
}

function shouldSkipSourceEntry(current: string, root: string, name: string): boolean {
  const rel = relative(root, current);
  if (rel === "" && name === ".git") return true;
  return name === ".zig-cache" || name === "zig-out";
}
