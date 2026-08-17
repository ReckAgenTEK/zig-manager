import { dirname, join, relative, resolve } from "@std/path";
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
  ZigSourceVersion,
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

export interface ManagedInstallDocsContext {
  readonly adapter: ReleaseAdapter;
  readonly platform: "linux" | "darwin" | "windows";
  readonly executable: string;
  readonly checkoutPath: string;
  readonly installPath: string;
  readonly cachePath: string;
  readonly logsPath: string;
  readonly llvmConfigPath: string;
  readonly selector: string;
  readonly version: ZigSourceVersion;
  readonly commit: string;
  readonly runner: ProcessRunner;
  readonly progress: (message: string) => void | Promise<void>;
  readonly signal?: AbortSignal;
}

interface AiDocsIndex {
  readonly schemaVersion: 1;
  readonly zig: {
    readonly selector: string;
    readonly version: string;
    readonly commit: string;
  };
  readonly entrypoints: {
    readonly overview: "AI_README.md";
    readonly languageReference: "langref.html";
    readonly completeHtml: string;
    readonly standardLibrary: "std/index.html";
    readonly standardLibrarySources: "std/sources.tar";
    readonly installedStandardLibrary: "../lib/zig/std";
  };
  readonly artifacts: readonly DocsArtifact[];
}

export const AI_DOCS_INDEX_FILE = "ai-index.json";

/** Build complete Zig docs directly into an unpublished install staging tree. */
export async function buildManagedInstallDocs(
  context: ManagedInstallDocsContext,
): Promise<void> {
  const docsRoot = join(context.installPath, "doc");
  const baseCommand = context.adapter.createDocsCommand({
    platform: context.platform,
    executable: context.executable,
    version: context.version,
    checkoutPath: context.checkoutPath,
    prefix: context.installPath,
    localCache: join(context.cachePath, "docs-local"),
    globalCache: join(context.cachePath, "docs-global"),
  });
  await Promise.all([
    Deno.mkdir(join(context.cachePath, "docs-local"), { recursive: true }),
    Deno.mkdir(join(context.cachePath, "docs-global"), { recursive: true }),
  ]);
  const libcConfig = context.platform === "linux" &&
      await requiresArchDocsLibcCompatibility()
    ? await prepareLinuxDocsLibcCompatibility({
      cachePath: context.cachePath,
      llvmConfigPath: context.llvmConfigPath,
      runner: context.runner,
      signal: context.signal,
    })
    : null;
  const command: CommandRecord = libcConfig === null
    ? baseCommand
    : { ...baseCommand, env: { ...baseCommand.env, ZIG_LIBC: libcConfig } };
  await executeDocsCommand(
    context.runner,
    command,
    context.logsPath,
    context.progress,
    context.signal,
  );
  await finalizeManagedInstallDocs(docsRoot, {
    selector: context.selector,
    version: context.version.text,
    commit: context.commit,
    signal: context.signal,
  });
}

const LINUX_CRT_OBJECTS = ["crt1.o", "Scrt1.o", "rcrt1.o", "crti.o", "crtn.o"] as const;
const LINUX_CRT_LIBRARIES = [
  "libc.a",
  "libm.a",
  "libpthread.a",
  "libdl.a",
  "librt.a",
  "libutil.a",
  "libc.so",
  "libm.so",
] as const;

/** Arch's glibc CRT layout needs an isolated compatibility copy for Zig's bundled LLD. */
export async function requiresArchDocsLibcCompatibility(
  readOsRelease: () => Promise<string> = () => Deno.readTextFile("/etc/os-release"),
): Promise<boolean> {
  try {
    const text = await readOsRelease();
    const match = /^ID=(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s#]+))\s*$/m.exec(text);
    return (match?.[1] ?? match?.[2] ?? match?.[3] ?? null) === "arch";
  } catch {
    return false;
  }
}

/**
 * Give Zig's bundled LLD CRT objects it can parse on hosts whose system CRTs contain
 * newer optional ELF metadata (currently GNU `.sframe`). System files remain untouched.
 */
export async function prepareLinuxDocsLibcCompatibility(input: {
  readonly cachePath: string;
  readonly llvmConfigPath: string;
  readonly runner: ProcessRunner;
  readonly signal?: AbortSignal;
  readonly systemLibDirectory?: string;
  readonly systemIncludeDirectory?: string;
}): Promise<string> {
  const systemLib = input.systemLibDirectory ?? "/usr/lib";
  const systemInclude = input.systemIncludeDirectory ?? "/usr/include";
  const root = join(input.cachePath, "docs-libc");
  const crt = join(root, "crt");
  const config = join(root, "libc.txt");
  const objcopy = join(dirname(input.llvmConfigPath), "llvm-objcopy");
  await removeIfPresent(root, true);
  await Deno.mkdir(crt, { recursive: true });
  for (const name of LINUX_CRT_OBJECTS) {
    if (input.signal?.aborted) throw new ZigOperationAbortedError("prepare docs libc");
    const destination = join(crt, name);
    await Deno.copyFile(join(systemLib, name), destination);
    if (name === "crti.o" || name === "crtn.o") continue;
    const result = await input.runner.run({
      executable: objcopy,
      args: ["--remove-section=.sframe", "--remove-section=.rela.sframe", destination],
      cwd: root,
      env: {},
      clearEnv: true,
      signal: input.signal,
    });
    if (input.signal?.aborted || result.signal !== null) {
      throw new ZigOperationAbortedError("prepare docs libc");
    }
    if (!result.success) {
      throw new ZigDocsBuildError("LLVM objcopy could not prepare docs libc CRT objects", {
        executable: objcopy,
        object: destination,
        exitCode: result.code,
        stderr: result.stderr,
      });
    }
  }
  for (const name of LINUX_CRT_LIBRARIES) {
    await Deno.symlink(join(systemLib, name), join(crt, name));
  }
  await Deno.writeTextFile(
    config,
    `include_dir=${systemInclude}\n` +
      `sys_include_dir=${systemInclude}\n` +
      `crt_dir=${crt}\n` +
      "msvc_lib_dir=\n" +
      "kernel32_lib_dir=\n" +
      "gcc_dir=\n",
  );
  return config;
}

export async function finalizeManagedInstallDocs(
  docsRoot: string,
  provenance: {
    readonly selector: string;
    readonly version: string;
    readonly commit: string;
    readonly signal?: AbortSignal;
  },
): Promise<void> {
  await validateDocsTree(docsRoot);
  const generated = await docsArtifacts(docsRoot);
  const mega = await buildMegaDocs({
    docsRoot,
    version: provenance.version,
    commit: provenance.commit,
    artifacts: generated,
    signal: provenance.signal,
  });
  const artifacts = [
    ...await docsArtifacts(docsRoot),
    { path: mega.path, sha256: mega.sha256, size: mega.size },
  ];
  const index: AiDocsIndex = {
    schemaVersion: 1,
    zig: {
      selector: provenance.selector,
      version: provenance.version,
      commit: provenance.commit,
    },
    entrypoints: {
      overview: "AI_README.md",
      languageReference: "langref.html",
      completeHtml: mega.path,
      standardLibrary: "std/index.html",
      standardLibrarySources: "std/sources.tar",
      installedStandardLibrary: "../lib/zig/std",
    },
    artifacts,
  };
  await Deno.writeTextFile(join(docsRoot, AI_DOCS_INDEX_FILE), `${canonicalJson(index, 2)}\n`);
  await Deno.writeTextFile(
    join(docsRoot, "AI_README.md"),
    `# Zig ${provenance.version} documentation\n\n` +
      `Exact source commit: \`${provenance.commit}\`.\n\n` +
      `For language semantics, read \`langref.html\`. For standard-library APIs, use ` +
      `\`std/index.html\` or the self-contained \`${mega.path}\`. For token-efficient source ` +
      `lookup, read Zig files under \`../lib/zig/std\`; \`std/sources.tar\` is the canonical ` +
      `autodoc source archive. Machine-readable paths and artifact hashes are in ` +
      `\`${AI_DOCS_INDEX_FILE}\`.\n`,
  );
}

/** Verify the required docs and every generated artifact recorded for AI consumers. */
export async function verifyManagedInstallDocs(
  installPath: string,
  expectedVersion: string,
  expectedCommit: string,
  signal?: AbortSignal,
): Promise<void> {
  const docsRoot = join(installPath, "doc");
  const indexPath = join(docsRoot, AI_DOCS_INDEX_FILE);
  let value: unknown;
  try {
    value = JSON.parse(await Deno.readTextFile(indexPath));
  } catch {
    throw new ZigDocsOutputError("AI documentation index cannot be read", indexPath);
  }
  const index = validateAiDocsIndex(value, indexPath);
  if (index.zig.version !== expectedVersion || index.zig.commit !== expectedCommit) {
    throw new ZigDocsOutputError(
      "AI documentation provenance does not match installation",
      indexPath,
    );
  }
  for (const artifact of index.artifacts) {
    if (signal?.aborted) throw new ZigOperationAbortedError("verify installed docs");
    const path = join(docsRoot, ...artifact.path.split("/"));
    const metadata = await fileMetadata(path, signal);
    if (metadata.sha256 !== artifact.sha256 || metadata.size !== artifact.size) {
      throw new ZigDocsOutputError("AI documentation artifact differs from index", path);
    }
  }
  for (
    const required of [
      "AI_README.md",
      "langref.html",
      "std/index.html",
      index.entrypoints.completeHtml,
    ]
  ) {
    const path = join(docsRoot, ...required.split("/"));
    const metadata = await fileMetadata(path, signal);
    if (metadata.size === 0) throw new ZigDocsOutputError("AI documentation file is empty", path);
  }
}

function validateAiDocsIndex(value: unknown, path: string): AiDocsIndex {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ZigDocsOutputError("AI documentation index must be an object", path);
  }
  const root = value as Record<string, unknown>;
  if (root.schemaVersion !== 1 || root.zig === null || typeof root.zig !== "object") {
    throw new ZigDocsOutputError("AI documentation index has invalid schema", path);
  }
  const zig = root.zig as Record<string, unknown>;
  if (
    typeof zig.selector !== "string" || typeof zig.version !== "string" ||
    typeof zig.commit !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(zig.commit)
  ) throw new ZigDocsOutputError("AI documentation provenance is invalid", path);
  if (!Array.isArray(root.artifacts) || root.artifacts.length === 0) {
    throw new ZigDocsOutputError("AI documentation artifacts are missing", path);
  }
  if (root.entrypoints === null || typeof root.entrypoints !== "object") {
    throw new ZigDocsOutputError("AI documentation entrypoints are missing", path);
  }
  const entrypoints = root.entrypoints as Record<string, unknown>;
  if (
    typeof entrypoints.completeHtml !== "string" || entrypoints.completeHtml.includes("/") ||
    !entrypoints.completeHtml.endsWith("-all.html")
  ) throw new ZigDocsOutputError("AI documentation complete HTML entrypoint is invalid", path);
  const artifacts = root.artifacts.map((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new ZigDocsOutputError(`AI documentation artifact ${index} is invalid`, path);
    }
    const artifact = item as Record<string, unknown>;
    if (
      typeof artifact.path !== "string" || artifact.path.startsWith("/") ||
      artifact.path.split("/").includes("..") || typeof artifact.size !== "number" ||
      !Number.isSafeInteger(artifact.size) || artifact.size < 1 ||
      typeof artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(artifact.sha256)
    ) throw new ZigDocsOutputError(`AI documentation artifact ${index} is invalid`, path);
    return { path: artifact.path, size: artifact.size, sha256: artifact.sha256 };
  });
  return { ...root, zig, entrypoints, artifacts } as unknown as AiDocsIndex;
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
