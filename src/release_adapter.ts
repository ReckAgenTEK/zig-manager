import { basename, dirname, join } from "@std/path";
import { dirname as windowsDirname, join as windowsJoin } from "@std/path/windows";
import {
  MINIMUM_CMAKE_VERSION,
  REQUIRED_CLANG_MAJOR,
  REQUIRED_LLD_MAJOR,
  REQUIRED_LLVM_MAJOR,
  SUPPORTED_DOCS_ASSET_CONTRACT,
} from "./constants.ts";
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
  readonly cmakeMinimum: string;
  readonly llvmMajor: number;
  readonly clangMajor: number;
  readonly lldMajor: number;
  readonly docsAssetContract: string;
}

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
  readonly requirements: ReleaseRequirements = {
    cmakeMinimum: MINIMUM_CMAKE_VERSION,
    llvmMajor: REQUIRED_LLVM_MAJOR,
    clangMajor: REQUIRED_CLANG_MAJOR,
    lldMajor: REQUIRED_LLD_MAJOR,
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
      `-DCMAKE_PREFIX_PATH=${context.options.cmakePrefixPath}`,
      `-DCMAKE_PROGRAM_PATH=${pathDirname(llvmConfig, context.platform)}`,
      "-DZIG_USE_LLVM_CONFIG=ON",
      `-DZIG_VERSION=${context.version.text}`,
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
      { executable: cmake, args: configureArgs, cwd: context.sourcePath, env },
      { executable: cmake, args: buildArgs, cwd: context.sourcePath, env },
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

export function releaseAdapterFor(version: ZigSourceVersion): ReleaseAdapter {
  const adapter = new ZigCMake21Adapter();
  if (adapter.supports(version)) return adapter;
  throw new ZigReleaseUnsupportedError(version.text);
}

function requiredTool(tool: BuildToolchain["cmake"]): string {
  if (!tool.available || !tool.supported) {
    throw new TypeError(`tool '${tool.name}' is unavailable or unsupported`);
  }
  return tool.executable;
}

function managedBuildEnvironment(paths: BuildArtifactPaths): Readonly<Record<string, string>> {
  return {
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
