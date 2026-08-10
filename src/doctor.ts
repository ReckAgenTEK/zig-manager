import { join, resolve } from "@std/path";
import {
  MINIMUM_CMAKE_VERSION,
  MINIMUM_FREE_DISK_BYTES,
  REQUIRED_CLANG_MAJOR,
  REQUIRED_LLD_MAJOR,
  REQUIRED_LLVM_MAJOR,
} from "./constants.ts";
import { ZigOperationAbortedError } from "./errors.ts";
import type { ReleaseAdapter } from "./release_adapter.ts";
import type {
  BuildToolchain,
  FilesystemProbeResult,
  PrerequisiteIssue,
  ProcessResult,
  ProcessRunner,
  ResolvedZigManagerConfig,
  SourceRefDoctorResult,
  ToolProbeResult,
  ZigDoctorResult,
} from "./types.ts";

interface DoctorContext {
  readonly config: ResolvedZigManagerConfig;
  readonly adapter: ReleaseAdapter;
  readonly sourceRefDoctor: SourceRefDoctorResult;
  readonly runner: ProcessRunner;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: "linux" | "darwin" | "windows";
  readonly outputPath?: string;
  readonly signal?: AbortSignal;
}

interface CandidateSet {
  readonly values: readonly string[];
  readonly explicit: boolean;
}

const REQUIRED_LLVM_TARGETS = [
  "AArch64",
  "AMDGPU",
  "ARM",
  "AVR",
  "BPF",
  "Hexagon",
  "Lanai",
  "LoongArch",
  "Mips",
  "MSP430",
  "NVPTX",
  "PowerPC",
  "RISCV",
  "SPIRV",
  "Sparc",
  "SystemZ",
  "VE",
  "WebAssembly",
  "X86",
  "XCore",
] as const;

export async function inspectBuildPrerequisites(context: DoctorContext): Promise<ZigDoctorResult> {
  throwIfAborted(context.signal, "doctor");
  const { config, runner, signal } = context;
  const cmake = await probeTool(
    runner,
    "cmake",
    candidates(explicit(config.tools.cmake, context.env.ZIG_MANAGER_CMAKE), ["cmake"]),
    ["--version"],
    `>=${MINIMUM_CMAKE_VERSION}`,
    parseCmakeVersion,
    (version) => compareNumericVersions(version, MINIMUM_CMAKE_VERSION) >= 0,
    signal,
  );
  const cCompiler = await probeTool(
    runner,
    "C compiler",
    candidates(
      explicit(config.tools.cCompiler, context.env.ZIG_MANAGER_CC, context.env.CC),
      compilerDefaults(context.platform, false),
    ),
    ["--version"],
    "working C compiler",
    parseGeneralCompilerVersion,
    () => true,
    signal,
  );
  const cxxCompiler = await probeTool(
    runner,
    "C++ compiler",
    candidates(
      explicit(config.tools.cxxCompiler, context.env.ZIG_MANAGER_CXX, context.env.CXX),
      compilerDefaults(context.platform, true),
    ),
    ["--version"],
    "working C++ compiler",
    parseGeneralCompilerVersion,
    () => true,
    signal,
  );
  const llvmConfig = await probeTool(
    runner,
    "LLVM",
    candidates(
      explicit(config.tools.llvmConfig, context.env.ZIG_MANAGER_LLVM_CONFIG),
      llvmConfigDefaults(context.platform),
    ),
    ["--version"],
    `major ${REQUIRED_LLVM_MAJOR}`,
    parseNumericVersion,
    (version) => major(version) === REQUIRED_LLVM_MAJOR,
    signal,
  );
  const clang = await probeTool(
    runner,
    "Clang",
    candidates(
      explicit(config.tools.clang, context.env.ZIG_MANAGER_CLANG),
      clangDefaults(context.platform),
    ),
    ["--version"],
    `major ${REQUIRED_CLANG_MAJOR}`,
    parseClangVersion,
    (version) => major(version) === REQUIRED_CLANG_MAJOR,
    signal,
  );
  const lld = await probeTool(
    runner,
    "LLD",
    candidates(
      explicit(config.tools.lld, context.env.ZIG_MANAGER_LLD),
      lldDefaults(context.platform),
    ),
    ["--version"],
    `major ${REQUIRED_LLD_MAJOR}`,
    parseLldVersion,
    (version) => major(version) === REQUIRED_LLD_MAJOR,
    signal,
  );

  const generatorDefaults = generatorToolDefaults(config.build.generator, context.platform);
  const generatorTool = generatorDefaults.length === 0 && config.tools.generatorTool === null &&
      context.env.ZIG_MANAGER_GENERATOR_TOOL === undefined
    ? null
    : await probeTool(
      runner,
      `generator ${config.build.generator}`,
      candidates(
        explicit(config.tools.generatorTool, context.env.ZIG_MANAGER_GENERATOR_TOOL),
        generatorDefaults,
      ),
      ["--version"],
      "available",
      parseGeneralCompilerVersion,
      () => true,
      signal,
    );

  const generatorSupported = cmake.available && await cmakeSupportsGenerator(
    runner,
    cmake.executable,
    config.build.generator,
    signal,
  );
  const llvmDetails = llvmConfig.available && llvmConfig.supported
    ? await probeLlvmDirectories(runner, llvmConfig.executable, signal)
    : { prefix: null, includeDir: null, libDir: null };
  const configuredPrefix = firstNonempty(
    config.build.cmakePrefixPath,
    context.env.ZIG_MANAGER_CMAKE_PREFIX_PATH,
  );
  const cmakePrefixPath = configuredPrefix ?? llvmDetails.prefix ?? archPrefix(context.platform) ??
    "";
  const developmentFiles = await inspectDevelopmentFiles(
    llvmDetails.includeDir,
    llvmDetails.libDir,
  );
  const llvmTargets = llvmConfig.available && llvmConfig.supported
    ? await inspectLlvmTargets(runner, llvmConfig.executable, signal)
    : { ok: false, message: "a compatible llvm-config is required to inspect LLVM targets" };
  throwIfAborted(signal, "doctor");
  const filesystem = await inspectFilesystem(
    await nearestExistingDirectory(context.outputPath ?? config.sourceRoot, config.projectRoot),
  );

  const toolchain: BuildToolchain = {
    cmake,
    cCompiler,
    cxxCompiler,
    llvmConfig,
    clang,
    lld,
    generatorTool,
    cmakePrefixPath,
    llvmIncludeDir: llvmDetails.includeDir,
    llvmLibDir: llvmDetails.libDir,
  };
  const issues: PrerequisiteIssue[] = [];
  if (!context.sourceRefDoctor.ok) {
    issues.push({
      code: "MISSING",
      component: "Git/source-ref",
      message: context.sourceRefDoctor.git.message ?? "source-ref doctor failed",
    });
  }
  for (const tool of [cmake, cCompiler, cxxCompiler, llvmConfig, clang, lld]) {
    if (!tool.available) {
      issues.push({
        code: "MISSING",
        component: tool.name,
        message: tool.message ?? `${tool.name} is unavailable`,
      });
    } else if (!tool.supported) {
      issues.push({
        code: "VERSION",
        component: tool.name,
        message: tool.message ?? `${tool.name} is incompatible`,
      });
    }
  }
  if (generatorTool && (!generatorTool.available || !generatorTool.supported)) {
    issues.push({
      code: "GENERATOR",
      component: config.build.generator,
      message: generatorTool.message ?? "generator tool is unavailable",
    });
  }
  if (!generatorSupported) {
    issues.push({
      code: "GENERATOR",
      component: config.build.generator,
      message: `CMake does not report generator '${config.build.generator}'`,
    });
  }
  if (!developmentFiles.ok) {
    issues.push({
      code: "DEVELOPMENT_FILES",
      component: "LLVM/Clang/LLD",
      message: developmentFiles.message,
    });
  }
  if (!llvmTargets.ok) {
    issues.push({
      code: "DEVELOPMENT_FILES",
      component: "LLVM targets",
      message: llvmTargets.message,
    });
  }
  if (!filesystem.writable || filesystem.sufficientDisk === false) {
    issues.push({
      code: "FILESYSTEM",
      component: filesystem.path,
      message: filesystem.message ?? "managed output path is unsuitable",
    });
  }
  return {
    schemaVersion: 1,
    ok: issues.length === 0,
    adapter: context.adapter.id,
    sourceRef: context.sourceRefDoctor,
    toolchain,
    filesystem,
    issues,
  };
}

async function probeTool(
  runner: ProcessRunner,
  name: string,
  set: CandidateSet,
  args: readonly string[],
  required: string,
  parseVersion: (output: string) => string | null,
  accepts: (version: string) => boolean,
  signal?: AbortSignal,
): Promise<ToolProbeResult> {
  let lastMessage: string | null = null;
  for (const executable of set.values) {
    let result: ProcessResult;
    try {
      result = await runner.run({ executable, args, signal });
    } catch (cause) {
      throwIfAborted(signal, `probe ${name}`);
      lastMessage = cause instanceof Error ? cause.message : String(cause);
      if (set.explicit) break;
      continue;
    }
    throwIfAborted(signal, `probe ${name}`);
    if (!result.success) {
      lastMessage = diagnostic(result) || `${name} exited with code ${result.code}`;
      if (set.explicit) break;
      continue;
    }
    const version = parseVersion(`${result.stdout}\n${result.stderr}`);
    if (version === null) {
      return {
        name,
        executable,
        available: true,
        version: null,
        supported: false,
        required,
        message: `${name} version could not be parsed`,
      };
    }
    const supported = accepts(version);
    return {
      name,
      executable,
      available: true,
      version,
      supported,
      required,
      message: supported ? null : `${name} ${version} does not satisfy ${required}`,
    };
  }
  return {
    name,
    executable: set.values[0] ?? "",
    available: false,
    version: null,
    supported: false,
    required,
    message: lastMessage ?? `${name} executable was not found`,
  };
}

async function cmakeSupportsGenerator(
  runner: ProcessRunner,
  executable: string,
  generator: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    const result = await runner.run({ executable, args: ["--help"], signal });
    throwIfAborted(signal, "probe CMake generator");
    return result.success && `${result.stdout}\n${result.stderr}`.includes(generator);
  } catch (cause) {
    throwIfAborted(signal, "probe CMake generator");
    if (cause instanceof ZigOperationAbortedError) throw cause;
    return false;
  }
}

async function probeLlvmDirectories(
  runner: ProcessRunner,
  executable: string,
  signal?: AbortSignal,
): Promise<{ prefix: string | null; includeDir: string | null; libDir: string | null }> {
  const query = async (argument: string): Promise<string | null> => {
    try {
      const result = await runner.run({ executable, args: [argument], signal });
      throwIfAborted(signal, "probe LLVM directories");
      const value = result.stdout.trim();
      return result.success && value.length > 0 ? value : null;
    } catch (cause) {
      throwIfAborted(signal, "probe LLVM directories");
      if (cause instanceof ZigOperationAbortedError) throw cause;
      return null;
    }
  };
  const [prefix, includeDir, libDir] = await Promise.all([
    query("--prefix"),
    query("--includedir"),
    query("--libdir"),
  ]);
  return { prefix, includeDir, libDir };
}

async function inspectDevelopmentFiles(
  includeDir: string | null,
  libDir: string | null,
): Promise<{ ok: boolean; message: string }> {
  if (includeDir === null || libDir === null) {
    return { ok: false, message: "llvm-config did not report include and library directories" };
  }
  const headers = [
    join(includeDir, "llvm", "IR", "IRBuilder.h"),
    join(includeDir, "clang", "Frontend", "ASTUnit.h"),
    join(includeDir, "lld", "Common", "Driver.h"),
  ];
  for (const header of headers) {
    try {
      if (!(await Deno.stat(header)).isFile) {
        return { ok: false, message: `required development header is missing: ${header}` };
      }
    } catch {
      return { ok: false, message: `required development header is missing: ${header}` };
    }
  }
  try {
    const names: string[] = [];
    for await (const entry of Deno.readDir(libDir)) {
      if (entry.isFile || entry.isSymlink) names.push(entry.name);
    }
    for (const required of [/llvm/i, /clang/i, /lld/i]) {
      if (!names.some((name) => required.test(name))) {
        return { ok: false, message: `required development libraries are missing from ${libDir}` };
      }
    }
  } catch {
    return { ok: false, message: `LLVM library directory cannot be inspected: ${libDir}` };
  }
  return { ok: true, message: "LLVM, Clang, and LLD development files are present" };
}

async function inspectLlvmTargets(
  runner: ProcessRunner,
  executable: string,
  signal?: AbortSignal,
): Promise<{ ok: boolean; message: string }> {
  try {
    const result = await runner.run({ executable, args: ["--targets-built"], signal });
    throwIfAborted(signal, "probe LLVM targets");
    if (!result.success) {
      return { ok: false, message: diagnostic(result) || "llvm-config --targets-built failed" };
    }
    const available = new Set(result.stdout.trim().split(/\s+/).filter(Boolean));
    const missing = REQUIRED_LLVM_TARGETS.filter((target) => !available.has(target));
    return missing.length === 0
      ? { ok: true, message: "all Zig-required LLVM targets are present" }
      : { ok: false, message: `LLVM is missing required targets: ${missing.join(", ")}` };
  } catch (cause) {
    throwIfAborted(signal, "probe LLVM targets");
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

async function inspectFilesystem(path: string): Promise<FilesystemProbeResult> {
  const probe = join(path, `.zig-manager-write-probe-${crypto.randomUUID()}`);
  let writable = false;
  let message: string | null = null;
  try {
    const file = await Deno.open(probe, { createNew: true, write: true });
    try {
      await file.write(new Uint8Array([0]));
      await file.sync();
      writable = true;
    } finally {
      file.close();
    }
  } catch (cause) {
    message = cause instanceof Error ? cause.message : String(cause);
  } finally {
    try {
      await Deno.remove(probe);
    } catch {
      // The probe may not have been created.
    }
  }
  const freeBytes = await portableFreeBytes(path);
  const sufficientDisk = freeBytes === null ? null : freeBytes >= MINIMUM_FREE_DISK_BYTES;
  if (writable && sufficientDisk === false) {
    message = `only ${freeBytes} bytes are free; ${MINIMUM_FREE_DISK_BYTES} bytes are required`;
  }
  return {
    path: resolve(path),
    writable,
    freeBytes,
    minimumFreeBytes: MINIMUM_FREE_DISK_BYTES,
    sufficientDisk,
    message,
  };
}

async function portableFreeBytes(path: string): Promise<number | null> {
  const deno = Deno as unknown as {
    statfs?: (path: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>;
  };
  if (!deno.statfs) return null;
  try {
    const stat = await deno.statfs(path);
    const value = BigInt(stat.bavail) * BigInt(stat.bsize);
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : Number.MAX_SAFE_INTEGER;
  } catch {
    return null;
  }
}

function candidates(value: string | null, defaults: readonly string[]): CandidateSet {
  return value === null
    ? { values: defaults, explicit: false }
    : { values: [value], explicit: true };
}

function explicit(...values: readonly (string | null | undefined)[]): string | null {
  return firstNonempty(...values);
}

function firstNonempty(...values: readonly (string | null | undefined)[]): string | null {
  for (const value of values) {
    if (value !== null && value !== undefined && value.length > 0) return value;
  }
  return null;
}

function compilerDefaults(platform: DoctorContext["platform"], cxx: boolean): readonly string[] {
  if (platform === "windows") return cxx ? ["clang++.exe", "cl.exe"] : ["clang.exe", "cl.exe"];
  if (platform === "linux") {
    return cxx
      ? ["/usr/lib/llvm21/bin/clang++", "c++", "clang++", "g++"]
      : ["/usr/lib/llvm21/bin/clang", "cc", "clang", "gcc"];
  }
  return cxx
    ? [
      "/opt/homebrew/opt/llvm@21/bin/clang++",
      "/usr/local/opt/llvm@21/bin/clang++",
      "c++",
      "clang++",
    ]
    : [
      "/opt/homebrew/opt/llvm@21/bin/clang",
      "/usr/local/opt/llvm@21/bin/clang",
      "cc",
      "clang",
    ];
}

function llvmConfigDefaults(platform: DoctorContext["platform"]): readonly string[] {
  if (platform === "linux") {
    return ["/usr/lib/llvm21/bin/llvm-config", "llvm-config-21", "llvm-config"];
  }
  if (platform === "darwin") {
    return [
      "/opt/homebrew/opt/llvm@21/bin/llvm-config",
      "/usr/local/opt/llvm@21/bin/llvm-config",
      "llvm-config-21",
      "llvm-config",
    ];
  }
  return ["C:\\Program Files\\LLVM\\bin\\llvm-config.exe", "llvm-config.exe"];
}

function clangDefaults(platform: DoctorContext["platform"]): readonly string[] {
  if (platform === "linux") return ["/usr/lib/llvm21/bin/clang", "clang-21", "clang"];
  if (platform === "darwin") {
    return [
      "/opt/homebrew/opt/llvm@21/bin/clang",
      "/usr/local/opt/llvm@21/bin/clang",
      "clang-21",
      "clang",
    ];
  }
  return ["C:\\Program Files\\LLVM\\bin\\clang.exe", "clang.exe"];
}

function lldDefaults(platform: DoctorContext["platform"]): readonly string[] {
  if (platform === "linux") return ["/usr/lib/llvm21/bin/ld.lld", "ld.lld-21", "ld.lld"];
  if (platform === "darwin") {
    return ["/opt/homebrew/opt/llvm@21/bin/ld.lld", "/usr/local/opt/llvm@21/bin/ld.lld", "ld.lld"];
  }
  return ["C:\\Program Files\\LLVM\\bin\\lld-link.exe", "lld-link.exe"];
}

function generatorToolDefaults(
  generator: string,
  platform: DoctorContext["platform"],
): readonly string[] {
  if (/ninja/i.test(generator)) return [platform === "windows" ? "ninja.exe" : "ninja"];
  if (generator === "Unix Makefiles") return ["make"];
  if (generator === "NMake Makefiles") return ["nmake.exe"];
  return [];
}

function archPrefix(platform: DoctorContext["platform"]): string | null {
  return platform === "linux" ? "/usr/lib/llvm21" : null;
}

function parseCmakeVersion(output: string): string | null {
  return /cmake version\s+([0-9]+(?:\.[0-9]+){1,2})/i.exec(output)?.[1] ?? null;
}

function parseClangVersion(output: string): string | null {
  return /(?:clang|LLVM) version\s+([0-9]+(?:\.[0-9]+){0,2})/i.exec(output)?.[1] ??
    parseNumericVersion(output);
}

function parseLldVersion(output: string): string | null {
  return /(?:LLD|lld-link)\s+([0-9]+(?:\.[0-9]+){0,2})/i.exec(output)?.[1] ??
    parseNumericVersion(output);
}

function parseGeneralCompilerVersion(output: string): string | null {
  return /([0-9]+(?:\.[0-9]+){1,2})/.exec(output)?.[1] ??
    (output.trim().length > 0 ? output.trim().split(/\s+/)[0] : null);
}

function parseNumericVersion(output: string): string | null {
  return /(?:^|\s)([0-9]+(?:\.[0-9]+){0,2})(?:\s|$)/m.exec(output)?.[1] ?? null;
}

function major(version: string): number {
  return Number(version.split(".", 1)[0]);
}

export function compareNumericVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function diagnostic(result: ProcessResult): string {
  return (result.stderr.trim() || result.stdout.trim()).slice(0, 1000);
}

async function nearestExistingDirectory(path: string, fallback: string): Promise<string> {
  let candidate = resolve(path);
  while (true) {
    try {
      const stat = await Deno.stat(candidate);
      return stat.isDirectory ? candidate : resolve(candidate, "..");
    } catch (cause) {
      if (!(cause instanceof Deno.errors.NotFound)) return resolve(fallback);
    }
    const parent = resolve(candidate, "..");
    if (parent === candidate) return resolve(fallback);
    candidate = parent;
  }
}

function throwIfAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted) throw new ZigOperationAbortedError(operation);
}
