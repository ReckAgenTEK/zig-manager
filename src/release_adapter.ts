import { basename, dirname, join } from "@std/path";
import { dirname as windowsDirname, join as windowsJoin } from "@std/path/windows";
import { MINIMUM_GIT_VERSION, SUPPORTED_DOCS_ASSET_CONTRACT } from "./constants.ts";
import { ZigReleaseUnsupportedError } from "./errors.ts";
import { parseZigTag } from "./versions.ts";
import type {
  BuildArtifactPaths,
  BuildToolchain,
  CommandRecord,
  NormalizedBuildOptions,
  ResolvedZigManagerConfig,
  ZigBuildProfile,
  ZigSourceVersion,
} from "./types.ts";

export interface ReleaseRequirements {
  readonly defaultCmakePrefix: Readonly<
    Record<"linux" | "darwin" | "windows", string | null>
  >;
  readonly tools: Readonly<Record<ReleaseToolKey, ReleaseToolRequirement>>;
  readonly generators: Readonly<Record<string, ReleaseGeneratorRequirement>>;
  readonly developmentFiles: {
    readonly headers: readonly ReleaseDevelopmentHeader[];
    readonly libraries: readonly ReleaseDevelopmentLibrary[];
  };
  readonly llvmTargets: readonly string[];
  readonly archPackages: {
    readonly git: "git";
  };
  readonly archPackageConstraints: Readonly<Record<string, ReleaseArchPackageConstraint>>;
  readonly docsAssetContract: string;
}

export interface ReleaseArchPackageConstraint {
  readonly required: string;
  readonly acceptsVersion: (version: string) => boolean;
}

export type ReleaseToolKey =
  | "cmake"
  | "cCompiler"
  | "cxxCompiler"
  | "llvmConfig"
  | "clang"
  | "lld";

export interface ReleaseToolRequirement {
  readonly key: ReleaseToolKey;
  readonly component: string;
  readonly candidates: Readonly<
    Record<"linux" | "darwin" | "windows", readonly string[]>
  >;
  readonly arguments: readonly string[];
  readonly required: string;
  readonly parseVersion: (output: string) => string | null;
  readonly acceptsVersion: (version: string) => boolean;
  readonly archPackages: readonly string[];
}

export interface ReleaseGeneratorRequirement {
  readonly component: string;
  readonly candidates: Readonly<
    Record<"linux" | "darwin" | "windows", readonly string[]>
  >;
  readonly arguments: readonly string[];
  readonly required: string;
  readonly parseVersion: (output: string) => string | null;
  readonly acceptsVersion: (version: string) => boolean;
  readonly archPackages: readonly string[];
}

export interface ReleaseDevelopmentHeader {
  readonly component: string;
  readonly relativePath: string;
  readonly archPackages: readonly string[];
}

export interface ReleaseDevelopmentLibrary {
  readonly component: string;
  readonly namePattern: RegExp;
  readonly archPackages: readonly string[];
}

const ZIG_LLVM_TARGETS = Object.freeze([
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
]);

export interface BuildCommandContext {
  readonly platform: "linux" | "darwin" | "windows";
  readonly sourcePath: string;
  readonly version: ZigSourceVersion;
  readonly paths: BuildArtifactPaths;
  readonly options: NormalizedBuildOptions;
  readonly toolchain: BuildToolchain;
}

export interface DocsCommandContext {
  readonly platform: "linux" | "darwin" | "windows";
  readonly executable: string;
  readonly version: ZigSourceVersion;
  readonly checkoutPath: string;
  readonly prefix: string;
  readonly localCache: string;
  readonly globalCache: string;
}

export interface ReleaseAdapter {
  readonly id: string;
  readonly buildContractVersion: number;
  readonly verifierContractVersion: number;
  readonly requirements: ReleaseRequirements;
  supports(version: ZigSourceVersion): boolean;
  normalizeBuildOptions(
    config: ResolvedZigManagerConfig,
    profile?: ZigBuildProfile,
    jobs?: number,
    cmakePrefixPath?: string,
  ): NormalizedBuildOptions;
  createBuildCommands(context: BuildCommandContext): readonly CommandRecord[];
  createDocsCommand(context: DocsCommandContext): CommandRecord;
  executableCandidates(
    installPath: string,
    platform: "linux" | "darwin" | "windows",
  ): readonly string[];
}

const PROFILE_BUILD_TYPE: Readonly<
  Record<ZigBuildProfile, NormalizedBuildOptions["cmakeBuildType"]>
> = {
  debug: "Debug",
  release: "Release",
  relwithdebinfo: "RelWithDebInfo",
  minsizerel: "MinSizeRel",
};

export class ZigCMake21Adapter implements ReleaseAdapter {
  readonly id = "zig-cmake-llvm21-autodoc-v1";
  readonly buildContractVersion = 1;
  readonly verifierContractVersion = 2;
  readonly requirements: ReleaseRequirements = {
    defaultCmakePrefix: {
      linux: "/usr/lib/llvm21",
      darwin: null,
      windows: null,
    },
    tools: {
      cmake: {
        key: "cmake",
        component: "cmake",
        candidates: {
          linux: ["cmake"],
          darwin: ["cmake"],
          windows: ["cmake.exe"],
        },
        arguments: ["--version"],
        required: ">=3.15.0",
        parseVersion: parseCmakeVersion,
        acceptsVersion: (version) => compareNumericVersions(version, "3.15.0") >= 0,
        archPackages: ["cmake"],
      },
      cCompiler: {
        key: "cCompiler",
        component: "C compiler",
        candidates: {
          linux: ["/usr/lib/llvm21/bin/clang", "clang-21", "cc", "clang", "gcc"],
          darwin: [
            "/opt/homebrew/opt/llvm@21/bin/clang",
            "/usr/local/opt/llvm@21/bin/clang",
            "cc",
            "clang",
          ],
          windows: ["clang.exe", "cl.exe"],
        },
        arguments: ["--version"],
        required: "working C compiler",
        parseVersion: parseGeneralCompilerVersion,
        acceptsVersion: () => true,
        archPackages: ["clang21"],
      },
      cxxCompiler: {
        key: "cxxCompiler",
        component: "C++ compiler",
        candidates: {
          linux: ["/usr/lib/llvm21/bin/clang++", "clang++-21", "c++", "clang++", "g++"],
          darwin: [
            "/opt/homebrew/opt/llvm@21/bin/clang++",
            "/usr/local/opt/llvm@21/bin/clang++",
            "c++",
            "clang++",
          ],
          windows: ["clang++.exe", "cl.exe"],
        },
        arguments: ["--version"],
        required: "working C++ compiler",
        parseVersion: parseGeneralCompilerVersion,
        acceptsVersion: () => true,
        archPackages: ["clang21"],
      },
      llvmConfig: {
        key: "llvmConfig",
        component: "LLVM",
        candidates: {
          linux: ["/usr/lib/llvm21/bin/llvm-config", "llvm-config-21", "llvm-config"],
          darwin: [
            "/opt/homebrew/opt/llvm@21/bin/llvm-config",
            "/usr/local/opt/llvm@21/bin/llvm-config",
            "llvm-config-21",
            "llvm-config",
          ],
          windows: ["C:\\Program Files\\LLVM\\bin\\llvm-config.exe", "llvm-config.exe"],
        },
        arguments: ["--version"],
        required: "major 21",
        parseVersion: parseNumericVersion,
        acceptsVersion: (version) => major(version) === 21,
        archPackages: ["llvm21"],
      },
      clang: {
        key: "clang",
        component: "Clang",
        candidates: {
          linux: ["/usr/lib/llvm21/bin/clang", "clang-21", "clang"],
          darwin: [
            "/opt/homebrew/opt/llvm@21/bin/clang",
            "/usr/local/opt/llvm@21/bin/clang",
            "clang-21",
            "clang",
          ],
          windows: ["C:\\Program Files\\LLVM\\bin\\clang.exe", "clang.exe"],
        },
        arguments: ["--version"],
        required: "major 21",
        parseVersion: parseClangVersion,
        acceptsVersion: (version) => major(version) === 21,
        archPackages: ["clang21"],
      },
      lld: {
        key: "lld",
        component: "LLD",
        candidates: {
          linux: ["/usr/lib/llvm21/bin/ld.lld", "ld.lld-21", "ld.lld"],
          darwin: [
            "/opt/homebrew/opt/llvm@21/bin/ld.lld",
            "/usr/local/opt/llvm@21/bin/ld.lld",
            "ld.lld",
          ],
          windows: ["C:\\Program Files\\LLVM\\bin\\lld-link.exe", "lld-link.exe"],
        },
        arguments: ["--version"],
        required: "major 21",
        parseVersion: parseLldVersion,
        acceptsVersion: (version) => major(version) === 21,
        archPackages: ["lld21"],
      },
    },
    generators: {
      Ninja: {
        component: "generator Ninja",
        candidates: { linux: ["ninja"], darwin: ["ninja"], windows: ["ninja.exe"] },
        arguments: ["--version"],
        required: "available",
        parseVersion: parseGeneralCompilerVersion,
        acceptsVersion: () => true,
        archPackages: ["ninja"],
      },
      "Ninja Multi-Config": {
        component: "generator Ninja Multi-Config",
        candidates: { linux: ["ninja"], darwin: ["ninja"], windows: ["ninja.exe"] },
        arguments: ["--version"],
        required: "available",
        parseVersion: parseGeneralCompilerVersion,
        acceptsVersion: () => true,
        archPackages: ["ninja"],
      },
      "Unix Makefiles": {
        component: "generator Unix Makefiles",
        candidates: { linux: ["make"], darwin: ["make"], windows: [] },
        arguments: ["--version"],
        required: "available",
        parseVersion: parseGeneralCompilerVersion,
        acceptsVersion: () => true,
        archPackages: ["make"],
      },
      "NMake Makefiles": {
        component: "generator NMake Makefiles",
        candidates: { linux: [], darwin: [], windows: ["nmake.exe"] },
        arguments: ["/?"],
        required: "available",
        parseVersion: (output) => output.trim().length > 0 ? output.trim().split(/\s+/)[0] : null,
        acceptsVersion: () => true,
        archPackages: [],
      },
    },
    developmentFiles: {
      headers: [
        {
          component: "LLVM headers",
          relativePath: "llvm/IR/IRBuilder.h",
          archPackages: ["llvm21"],
        },
        {
          component: "Clang headers",
          relativePath: "clang/Frontend/ASTUnit.h",
          archPackages: ["clang21"],
        },
        {
          component: "LLD headers",
          relativePath: "lld/Common/Driver.h",
          archPackages: ["lld21"],
        },
      ],
      libraries: [
        { component: "LLVM libraries", namePattern: /llvm/i, archPackages: ["llvm21"] },
        { component: "Clang libraries", namePattern: /clang/i, archPackages: ["clang21"] },
        { component: "LLD libraries", namePattern: /lld/i, archPackages: ["lld21"] },
      ],
    },
    llvmTargets: ZIG_LLVM_TARGETS,
    archPackages: { git: "git" },
    archPackageConstraints: {
      cmake: {
        required: ">=3.15.0",
        acceptsVersion: (version) => comparePackageVersion(version, "3.15.0") >= 0,
      },
      llvm21: {
        required: "major 21",
        acceptsVersion: (version) => packageMajor(version) === 21,
      },
      clang21: {
        required: "major 21",
        acceptsVersion: (version) => packageMajor(version) === 21,
      },
      lld21: {
        required: "major 21",
        acceptsVersion: (version) => packageMajor(version) === 21,
      },
      ninja: { required: "available", acceptsVersion: validPackageVersion },
      make: { required: "available", acceptsVersion: validPackageVersion },
      git: {
        required: `>=${MINIMUM_GIT_VERSION}`,
        acceptsVersion: (version) => comparePackageVersion(version, MINIMUM_GIT_VERSION) >= 0,
      },
    },
    docsAssetContract: SUPPORTED_DOCS_ASSET_CONTRACT.id,
  };

  supports(version: ZigSourceVersion): boolean {
    const parsed = parseZigTag(version.base);
    return parsed?.major === 0 && (parsed.minor === 16 || parsed.minor === 17);
  }

  normalizeBuildOptions(
    config: ResolvedZigManagerConfig,
    profile = config.build.profile,
    jobs = config.build.jobs ?? undefined,
    cmakePrefixPath = config.build.cmakePrefixPath ?? "",
  ): NormalizedBuildOptions {
    if (jobs !== undefined && (!Number.isSafeInteger(jobs) || jobs < 1)) {
      throw new TypeError("build jobs must be a positive integer");
    }
    return {
      strategy: "cmake",
      profile,
      cmakeBuildType: PROFILE_BUILD_TYPE[profile],
      generator: config.build.generator,
      jobs: jobs ?? null,
      cmakePrefixPath,
      cpu: config.build.cpu ?? "baseline",
    };
  }

  createBuildCommands(context: BuildCommandContext): readonly CommandRecord[] {
    const cmake = requiredTool(context.toolchain.cmake);
    const cCompiler = requiredTool(context.toolchain.cCompiler);
    const cxxCompiler = requiredTool(context.toolchain.cxxCompiler);
    const llvmConfig = requiredTool(context.toolchain.llvmConfig);
    const configureArgs = [
      "-S",
      context.sourcePath,
      "-B",
      context.paths.cmakeBuild,
      "-G",
      context.options.generator,
      `-DCMAKE_BUILD_TYPE=${context.options.cmakeBuildType}`,
      `-DCMAKE_INSTALL_PREFIX=${context.paths.install}`,
      `-DCMAKE_C_COMPILER=${cCompiler}`,
      `-DCMAKE_CXX_COMPILER=${cxxCompiler}`,
      `-DCMAKE_LINKER=${requiredTool(context.toolchain.lld)}`,
      `-DCMAKE_MAKE_PROGRAM=${requiredTool(context.toolchain.generatorTool!)}`,
      `-DCMAKE_PREFIX_PATH=${context.options.cmakePrefixPath}`,
      `-DCMAKE_PROGRAM_PATH=${pathDirname(llvmConfig, context.platform)}`,
      "-DZIG_USE_LLVM_CONFIG=ON",
      `-DZIG_VERSION=${context.version.text}`,
      `-DCMAKE_C_FLAGS=${context.options.cpu === "native" ? "-march=native" : ""}`,
      `-DCMAKE_CXX_FLAGS=${context.options.cpu === "native" ? "-march=native" : ""}`,
      "-DCMAKE_EXE_LINKER_FLAGS=",
      "-DCMAKE_SHARED_LINKER_FLAGS=",
    ];
    const buildArgs = [
      "--build",
      context.paths.cmakeBuild,
      "--target",
      "install",
      "--config",
      context.options.cmakeBuildType,
      "--parallel",
      ...(context.options.jobs === null ? [] : [String(context.options.jobs)]),
    ];
    const env = managedBuildEnvironment(context.paths);
    return [
      { executable: cmake, args: configureArgs, cwd: context.sourcePath, env, clearEnv: true },
      { executable: cmake, args: buildArgs, cwd: context.sourcePath, env, clearEnv: true },
    ];
  }

  createDocsCommand(context: DocsCommandContext): CommandRecord {
    const args = [
      "build",
      "docs",
      "-p",
      context.prefix,
      `-Dversion-string=${context.version.text}`,
      "--cache-dir",
      context.localCache,
      "--global-cache-dir",
      context.globalCache,
    ];
    return {
      executable: context.platform === "linux" ? "prlimit" : context.executable,
      args: context.platform === "linux" ? ["--core=1:", "--", context.executable, ...args] : args,
      cwd: context.checkoutPath,
      env: {
        ZIG_LOCAL_CACHE_DIR: context.localCache,
        ZIG_GLOBAL_CACHE_DIR: context.globalCache,
      },
      clearEnv: true,
    };
  }

  executableCandidates(
    installPath: string,
    platform: "linux" | "darwin" | "windows",
  ): readonly string[] {
    const name = platform === "windows" ? "zig.exe" : "zig";
    const pathJoin = platform === "windows" ? windowsJoin : join;
    return [pathJoin(installPath, "bin", name), pathJoin(installPath, name)];
  }
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

function compareNumericVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function comparePackageVersion(left: string, right: string): number {
  const parsed = packageNumericVersion(left);
  return parsed === null ? -1 : compareNumericVersions(parsed, right);
}

function packageMajor(version: string): number {
  const parsed = packageNumericVersion(version);
  return parsed === null ? Number.NaN : Number(parsed.split(".", 1)[0]);
}

function validPackageVersion(version: string): boolean {
  return packageNumericVersion(version) !== null;
}

function packageNumericVersion(version: string): string | null {
  const withoutEpoch = version.includes(":") ? version.slice(version.indexOf(":") + 1) : version;
  return /^([0-9]+(?:\.[0-9]+)*)/.exec(withoutEpoch)?.[1] ?? null;
}

export function releaseAdapterFor(version: ZigSourceVersion, commit?: string): ReleaseAdapter {
  const adapter = new ZigCMake21Adapter();
  if (adapter.supports(version)) return adapter;
  throw new ZigReleaseUnsupportedError(version.text, {
    ...(commit === undefined ? {} : { commit }),
  });
}

function requiredTool(tool: BuildToolchain["cmake"]): string {
  if (!tool.available || !tool.supported) {
    throw new TypeError(`tool '${tool.name}' is unavailable or unsupported`);
  }
  return tool.executable;
}

function managedBuildEnvironment(paths: BuildArtifactPaths): Readonly<Record<string, string>> {
  return {
    CFLAGS: "",
    CXXFLAGS: "",
    LDFLAGS: "",
    ZIG_GLOBAL_CACHE_DIR: join(paths.cache, "global"),
    ZIG_LOCAL_CACHE_DIR: join(paths.cache, "local"),
  };
}

export function commandDisplayName(command: CommandRecord): string {
  return basename(command.executable);
}

function pathDirname(path: string, platform: "linux" | "darwin" | "windows"): string {
  return platform === "windows" ? windowsDirname(path) : dirname(path);
}
