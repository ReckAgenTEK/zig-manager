import { basename, isAbsolute, relative, resolve } from "@std/path";
import { inspectElf64X86_64 } from "./elf.ts";
import { ZigOperationAbortedError } from "./errors.ts";
import { fileMetadata } from "./filesystem.ts";
import type {
  RuntimeDependencyInspector,
  RuntimeDependencyInspectorInput,
  RuntimeDependencyRecord,
  RuntimeLinkageRecord,
} from "./install_store.ts";
import type { ProcessRunner } from "./types.ts";

export const LINUX_RUNTIME_INSPECTOR_CONTRACT_VERSION = 1 as const;
const LDD_PATH = "/usr/bin/ldd";
const MAX_LDD_OUTPUT_BYTES = 1024 * 1024;
const ADDRESS_SUFFIX = /\s+\(0x[0-9a-fA-F]+\)\s*$/;

export interface LinuxRuntimeDependencyInspectorOptions {
  readonly runner: ProcessRunner;
}

/** Production Linux dependency inspection using a direct ldd argument array and bounded output. */
export class LinuxRuntimeDependencyInspector implements RuntimeDependencyInspector {
  readonly contractVersion = LINUX_RUNTIME_INSPECTOR_CONTRACT_VERSION;
  readonly #runner: ProcessRunner;

  constructor(options: LinuxRuntimeDependencyInspectorOptions) {
    this.#runner = options.runner;
  }

  async inspect(input: RuntimeDependencyInspectorInput): Promise<RuntimeLinkageRecord> {
    throwIfAborted(input.signal);
    if (input.platform !== "linux") {
      throw new TypeError("the production runtime dependency inspector supports Linux only");
    }
    const executablePath = normalizedAbsolute(input.executablePath, "runtime executable");
    const cacheRoot = normalizedAbsolute(input.cacheRoot, "manager cache root");
    const elf = await inspectElf64X86_64(executablePath);
    throwIfAborted(input.signal);
    if (!elf.dynamicallyLinked && elf.interpreter === null) {
      return { linkage: "static" };
    }
    if (elf.interpreter === null) {
      throw new TypeError("dynamically linked ELF executable does not report an interpreter");
    }

    const interpreter = await physicalDependency(
      "interpreter",
      elf.interpreter,
      cacheRoot,
      input.signal,
    );
    const result = await this.#runner.run({
      executable: LDD_PATH,
      args: [executablePath],
      clearEnv: true,
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin" },
      signal: input.signal,
      maxDiagnosticBytes: MAX_LDD_OUTPUT_BYTES,
    });
    throwIfAborted(input.signal);
    if (
      !result.success || result.stdoutTruncated || result.stderrTruncated ||
      byteLength(result.stdout) > MAX_LDD_OUTPUT_BYTES ||
      byteLength(result.stderr) > MAX_LDD_OUTPUT_BYTES
    ) {
      throw new TypeError(
        `bounded ldd inspection failed: ${result.stderr.trim() || `exit ${result.code}`}`,
      );
    }

    const dependencies: RuntimeDependencyRecord[] = [];
    const names = new Set<string>();
    const paths = new Set<string>();
    for (const rawLine of result.stdout.split("\n")) {
      throwIfAborted(input.signal);
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith("linux-vdso.so.")) continue;
      if (/^(?:statically linked|not a dynamic executable)$/i.test(line)) {
        throw new TypeError("ldd contradicted the ELF dynamic linkage metadata");
      }
      if (line.includes("=> not found")) {
        throw new TypeError(`runtime dependency is unresolved: ${line}`);
      }

      const withoutAddress = line.replace(ADDRESS_SUFFIX, "").trim();
      let name: string;
      let path: string;
      const arrow = withoutAddress.indexOf(" => ");
      if (arrow >= 0) {
        name = withoutAddress.slice(0, arrow).trim();
        path = withoutAddress.slice(arrow + 4).trim();
      } else if (withoutAddress.startsWith("/")) {
        path = withoutAddress;
        name = basename(path);
      } else {
        throw new TypeError(`runtime dependency output is malformed: ${line}`);
      }
      if (name.length === 0 || !path.startsWith("/")) {
        throw new TypeError(`runtime dependency output is malformed: ${line}`);
      }
      const dependency = await physicalDependency(name, path, cacheRoot, input.signal);
      if (dependency.path === interpreter.path) continue;
      if (names.has(dependency.name) || paths.has(dependency.path)) {
        throw new TypeError(`runtime dependency is duplicated: ${dependency.name}`);
      }
      names.add(dependency.name);
      paths.add(dependency.path);
      dependencies.push(dependency);
    }
    dependencies.sort((left, right) =>
      compare(left.name, right.name) || compare(left.path, right.path)
    );
    return { linkage: "dynamic", interpreter, dependencies };
  }
}

async function physicalDependency(
  name: string,
  candidate: string,
  cacheRoot: string,
  signal?: AbortSignal,
): Promise<RuntimeDependencyRecord> {
  throwIfAborted(signal);
  normalizedAbsolute(candidate, `runtime dependency ${name}`);
  let candidateInfo: Deno.FileInfo;
  try {
    candidateInfo = await Deno.lstat(candidate);
  } catch (cause) {
    throw new TypeError(`runtime dependency is missing: ${candidate}`, { cause });
  }
  if (candidateInfo.isSymlink) {
    throw new TypeError(`runtime dependency must not be a symlink: ${candidate}`);
  }
  let physical: string;
  try {
    physical = resolve(await Deno.realPath(candidate));
  } catch (cause) {
    throw new TypeError(`runtime dependency is missing: ${candidate}`, { cause });
  }
  if (contained(cacheRoot, physical)) {
    throw new TypeError(`runtime dependency resolves into the replaceable cache root: ${physical}`);
  }
  const info = await Deno.lstat(physical);
  if (!info.isFile || info.isSymlink || info.size < 1) {
    throw new TypeError(`runtime dependency is not a physical regular file: ${physical}`);
  }
  const metadata = await fileMetadata(physical, signal);
  return { name, path: physical, size: metadata.size, sha256: metadata.sha256 };
}

function normalizedAbsolute(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new TypeError(`${label} must be an absolute normalized path`);
  }
  return path;
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new ZigOperationAbortedError("inspect runtime dependencies", {}, {
      cause: signal.reason,
    });
  }
}
