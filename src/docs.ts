import { join, relative, resolve } from "@std/path";
import { DOCS_MANIFEST_FILE, SUPPORTED_DOCS_ASSET_CONTRACT } from "./constants.ts";
import {
  ZigDocsBuildError,
  ZigDocsOutputError,
  ZigManagerError,
  ZigOperationAbortedError,
} from "./errors.ts";
import {
  atomicReplaceDirectory,
  canonicalJson,
  fileMetadata,
  removeIfPresent,
} from "./filesystem.ts";
import { writeDocsManifest } from "./manifest.ts";
import { buildMegaDocs } from "./mega_docs.ts";
import type { ReleaseAdapter } from "./release_adapter.ts";
import type {
  BuildManifest,
  CommandRecord,
  DocsArtifact,
  DocsManifest,
  DocsOptions,
  DocsResult,
  ProcessRunner,
  SourceSelectionState,
} from "./types.ts";

export interface ManagedDocsContext {
  readonly repositoryHome: string;
  readonly source: SourceSelectionState;
  readonly build: BuildManifest;
  readonly adapter: ReleaseAdapter;
  readonly runner: ProcessRunner;
  readonly platform: "linux" | "darwin" | "windows";
  readonly options: DocsOptions;
  readonly defaultMega: boolean;
  readonly progress: (message: string) => void | Promise<void>;
}

const EXPECTED = [
  "langref.html",
  "std/index.html",
  "std/main.js",
  "std/main.wasm",
  "std/sources.tar",
] as const;
const activeDocsLocks = new Set<string>();

interface DocsOperationLock {
  readonly file: Deno.FsFile;
  readonly path: string;
}

export async function buildManagedDocs(context: ManagedDocsContext): Promise<DocsResult> {
  const version = context.source.version;
  const outputPrefix = join(context.repositoryHome, ".ref-docs-build");
  const publishStage = join(context.repositoryHome, ".ref-docs-staging");
  const finalDirectory = join(context.repositoryHome, "ref-docs");
  const operationLock = await acquireDocsLock(join(context.repositoryHome, ".ref-docs.lock"));
  try {
    await removeIfPresent(outputPrefix, true);
    await removeIfPresent(publishStage, true);
    let outputPrefixCreated = false;
    let publishStageCreated = false;
    try {
      await Deno.mkdir(outputPrefix);
      outputPrefixCreated = true;
      await Deno.mkdir(publishStage);
      publishStageCreated = true;
    } catch (cause) {
      if (outputPrefixCreated) await removeIfPresent(outputPrefix, true);
      if (publishStageCreated) await removeIfPresent(publishStage, true);
      throw new ZigDocsBuildError("A deterministic docs staging directory already exists", {
        outputPrefix,
        publishStage,
      }, { cause });
    }

    const localCache = join(context.build.paths.cache, "docs-local");
    const globalCache = join(context.build.paths.cache, "docs-global");
    const command = context.adapter.createDocsCommand({
      platform: context.platform,
      executable: context.build.paths.executable,
      version,
      checkoutPath: context.source.checkoutPath,
      prefix: outputPrefix,
      localCache,
      globalCache,
    });
    try {
      await Promise.all([
        Deno.mkdir(localCache, { recursive: true }),
        Deno.mkdir(globalCache, { recursive: true }),
      ]);
      await executeDocsCommand(
        context.runner,
        command,
        context.build.paths.logs,
        context.progress,
        context.options.signal,
      );
      const generatedDocs = join(outputPrefix, "doc");
      await validateDocsTree(generatedDocs);
      await copyDocsTree(generatedDocs, publishStage);
      const artifacts = await docsArtifacts(publishStage);
      const mega = (context.options.mega ?? context.defaultMega)
        ? await buildMegaDocs({
          docsRoot: publishStage,
          version: version.text,
          commit: context.source.commit,
          artifacts,
          signal: context.options.signal,
        })
        : null;
      const manifest: DocsManifest = {
        schemaVersion: 2,
        source: {
          selector: context.source.selector,
          version,
          commit: context.source.commit,
          checkoutPath: context.source.checkoutPath,
        },
        compiler: {
          path: context.build.paths.executable,
          version: context.build.compiler.version,
          sha256: context.build.compiler.sha256,
        },
        buildIdentity: context.build.identity,
        outputPath: finalDirectory,
        command,
        artifacts,
        mega,
      };
      await writeDocsManifest(join(publishStage, DOCS_MANIFEST_FILE), manifest);
      await atomicReplaceDirectory(publishStage, finalDirectory);
      await removeIfPresent(outputPrefix, true);
      return { manifest };
    } catch (cause) {
      await removeIfPresent(outputPrefix, true);
      await removeIfPresent(publishStage, true);
      if (context.options.signal?.aborted) throw new ZigOperationAbortedError("docs");
      if (cause instanceof ZigManagerError) throw cause;
      throw new ZigDocsBuildError("Managed Zig documentation build failed", {
        outputPrefix,
        publishStage,
      }, { cause });
    }
  } finally {
    await releaseDocsLock(operationLock);
  }
}

async function acquireDocsLock(path: string): Promise<DocsOperationLock> {
  path = resolve(path);
  if (activeDocsLocks.has(path)) {
    throw new ZigDocsBuildError("Another managed Zig documentation build is already running", {
      lockPath: path,
    });
  }
  activeDocsLocks.add(path);
  let file: Deno.FsFile | undefined;
  try {
    file = await Deno.open(path, { create: true, read: true, write: true, mode: 0o600 });
    if (!await file.tryLock()) {
      throw new ZigDocsBuildError("Another managed Zig documentation build is already running", {
        lockPath: path,
      });
    }
    return { file, path };
  } catch (cause) {
    file?.close();
    activeDocsLocks.delete(path);
    if (cause instanceof ZigManagerError) throw cause;
    throw new ZigDocsBuildError("Could not acquire the managed Zig documentation lock", {
      lockPath: path,
    }, { cause });
  }
}

async function releaseDocsLock(lock: DocsOperationLock): Promise<void> {
  try {
    await lock.file.unlock();
  } finally {
    lock.file.close();
    activeDocsLocks.delete(lock.path);
  }
}

export async function validateDocsTree(docsRoot: string): Promise<void> {
  const actual: string[] = [];
  await collectFiles(docsRoot, docsRoot, actual);
  actual.sort();
  const expected = [...EXPECTED].sort();
  if (
    actual.length !== expected.length || actual.some((value, index) => value !== expected[index])
  ) {
    throw new ZigDocsOutputError(
      `expected exactly ${expected.join(", ")}; found ${actual.join(", ") || "no files"}`,
      docsRoot,
    );
  }
  for (const path of EXPECTED) {
    const absolute = join(docsRoot, ...path.split("/"));
    const stat = await Deno.stat(absolute);
    if (!stat.isFile || stat.size < 1) {
      throw new ZigDocsOutputError(`required file is empty: ${path}`, absolute);
    }
  }
}

async function collectFiles(root: string, directory: string, output: string[]): Promise<void> {
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const entry of Deno.readDir(directory)) entries.push(entry);
  } catch (cause) {
    throw new ZigDocsOutputError(
      `documentation directory cannot be read: ${String(cause)}`,
      directory,
    );
  }
  entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isSymlink) {
      throw new ZigDocsOutputError("documentation output contains a symlink", path);
    }
    if (entry.isDirectory) await collectFiles(root, path, output);
    else if (entry.isFile) output.push(relative(root, path).split("\\").join("/"));
    else {throw new ZigDocsOutputError(
        "documentation output contains an unsupported file type",
        path,
      );}
  }
}

async function copyDocsTree(source: string, destination: string): Promise<void> {
  await Deno.mkdir(join(destination, "std"), { recursive: true });
  for (const path of EXPECTED) {
    const segments = path.split("/");
    await Deno.copyFile(join(source, ...segments), join(destination, ...segments));
  }
}

async function docsArtifacts(root: string): Promise<DocsArtifact[]> {
  const result: DocsArtifact[] = [];
  for (const path of EXPECTED) {
    const metadata = await fileMetadata(join(root, ...path.split("/")));
    result.push({ path, sha256: metadata.sha256, size: metadata.size });
  }
  return result;
}

async function executeDocsCommand(
  runner: ProcessRunner,
  command: CommandRecord,
  logs: string,
  progress: (message: string) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  await Deno.mkdir(logs, { recursive: true });
  await Deno.writeTextFile(join(logs, "docs.command.json"), `${canonicalJson(command, 2)}\n`);
  const stdout = await Deno.open(join(logs, "docs.stdout.log"), {
    create: true,
    truncate: true,
    write: true,
  });
  const stderr = await Deno.open(join(logs, "docs.stderr.log"), {
    create: true,
    truncate: true,
    write: true,
  });
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();
  await progress("Building Zig language and standard-library documentation...\n");
  try {
    const result = await runner.run({
      ...command,
      signal,
      onStdout: async (chunk) => {
        await writeAll(stdout, chunk);
        const text = stdoutDecoder.decode(chunk, { stream: true });
        if (text.length > 0) await progress(text);
      },
      onStderr: async (chunk) => {
        await writeAll(stderr, chunk);
        const text = stderrDecoder.decode(chunk, { stream: true });
        if (text.length > 0) await progress(text);
      },
    });
    await Promise.all([stdout.sync(), stderr.sync()]);
    if (signal?.aborted || result.signal !== null) throw new ZigOperationAbortedError("docs");
    if (!result.success) {
      throw new ZigDocsBuildError("Zig docs command failed", {
        executable: command.executable,
        args: command.args,
        exitCode: result.code,
        stderr: result.stderr,
        stderrTruncated: result.stderrTruncated,
      });
    }
  } finally {
    stdout.close();
    stderr.close();
  }
}

export async function verifyDocsManifestFiles(
  manifest: DocsManifest,
): Promise<void> {
  for (const artifact of manifest.artifacts) {
    const path = resolve(manifest.outputPath, ...artifact.path.split("/"));
    const metadata = await fileMetadata(path);
    if (metadata.sha256 !== artifact.sha256 || metadata.size !== artifact.size) {
      throw new ZigDocsOutputError("artifact differs from docs manifest", path);
    }
  }
  if (manifest.mega !== null) {
    const path = resolve(manifest.outputPath, manifest.mega.path);
    const metadata = await fileMetadata(path);
    if (metadata.sha256 !== manifest.mega.sha256 || metadata.size !== manifest.mega.size) {
      throw new ZigDocsOutputError("mega document differs from docs manifest", path);
    }
  }
}

async function writeAll(file: Deno.FsFile, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) offset += await file.write(chunk.subarray(offset));
}

export const ZIG_DOCS_ASSETS = SUPPORTED_DOCS_ASSET_CONTRACT;
