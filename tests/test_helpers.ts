import { LockedRequestMismatchError, RepositoryNotFoundError } from "@reckagentek/source-ref";
import { dirname, join } from "@std/path";
import { ZigOperationAbortedError } from "../src/errors.ts";
import { ZLS_INSTALL_VERIFIER_CONTRACT_VERSION } from "../src/build_recipe.ts";
import type {
  ZlsLspProtocolVerification,
  ZlsLspProtocolVerifier,
  ZlsLspProtocolVerifierInput,
} from "../src/zls_install_pipeline.ts";
import {
  ZLS_SOURCE_REPOSITORY_IDENTITY,
  ZLS_SOURCE_REPOSITORY_URL,
} from "../src/zls_source_workspace.ts";
import type {
  CheckoutResult,
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
  RemoteHead,
  RemoteRef,
  RepositoryStatus,
  RevisionDescription,
  SourceRefApi,
  SourceRefDoctorResult,
  ZigManagerConfig,
  ZigSourceVersion,
} from "../src/mod.ts";

export const COMMIT_A = "a".repeat(40);
export const COMMIT_B = "b".repeat(40);
export const COMMIT_C = "c".repeat(40);
export const COMMIT_D = "d".repeat(40);
export const COMMIT_E = "e".repeat(40);
export const COMMIT_F = "f".repeat(40);

export function testConfig(root: string, prefix = join(root, "toolchain")): ZigManagerConfig {
  return {
    $schema: "./packages/zig-manager/schema/zig-manager.schema.json",
    sourceRoot: ".source-ref",
    repository: "https://codeberg.org/ziglang/zig.git",
    provider: "codeberg",
    name: "zig",
    selector: "0.16",
    build: {
      strategy: "cmake",
      profile: "release",
      generator: "Ninja",
      cmakePrefixPath: prefix,
      jobs: 4,
    },
    docs: { mega: true },
    tools: {
      cmake: join(root, "tools", "cmake"),
      cCompiler: join(root, "tools", "cc"),
      cxxCompiler: join(root, "tools", "c++"),
      llvmConfig: join(root, "tools", "llvm-config"),
      clang: join(root, "tools", "clang"),
      lld: join(root, "tools", "ld.lld"),
      generatorTool: join(root, "tools", "ninja"),
    },
  };
}

export async function createDevelopmentFiles(root: string): Promise<string> {
  const prefix = join(root, "toolchain");
  const headers = [
    join(prefix, "include", "llvm", "IR", "IRBuilder.h"),
    join(prefix, "include", "clang", "Frontend", "ASTUnit.h"),
    join(prefix, "include", "lld", "Common", "Driver.h"),
  ];
  for (const path of headers) {
    await Deno.mkdir(dirname(path), { recursive: true });
    await Deno.writeTextFile(path, "fixture\n");
  }
  await Deno.mkdir(join(prefix, "lib"), { recursive: true });
  for (const name of ["libLLVM.so", "libclang-cpp.so", "liblldCommon.a"]) {
    await Deno.writeTextFile(join(prefix, "lib", name), "fixture\n");
  }
  await Deno.mkdir(join(root, "tools"), { recursive: true });
  for (
    const name of [
      "cmake",
      "cc",
      "c++",
      "llvm-config",
      "llvm-objcopy",
      "clang",
      "ld.lld",
      "ninja",
    ]
  ) {
    const path = join(root, "tools", name);
    await Deno.writeTextFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    if (Deno.build.os !== "windows") await Deno.chmod(path, 0o755);
  }
  return prefix;
}

export function zigVersionMetadata(commit: string, version: string): ZigSourceVersion {
  return {
    kind: "release",
    base: version,
    text: version,
    taggedAncestor: version,
    commitsAfterTag: 0,
    commitAbbreviation: commit.slice(0, 9),
  };
}

export function elf64X86_64Fixture(interpreter: string | null = null): Uint8Array {
  const interpreterBytes = interpreter === null
    ? null
    : new TextEncoder().encode(`${interpreter}\0`);
  const programHeaderCount = interpreterBytes === null ? 0 : 2;
  const interpreterOffset = 64 + programHeaderCount * 56;
  const bytes = new Uint8Array(interpreterOffset + (interpreterBytes?.length ?? 0));
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(16, 2, true);
  view.setUint16(18, 62, true);
  view.setUint32(20, 1, true);
  if (programHeaderCount > 0) view.setBigUint64(32, 64n, true);
  view.setUint16(52, 64, true);
  view.setUint16(54, 56, true);
  view.setUint16(56, programHeaderCount, true);
  if (interpreterBytes !== null) {
    const interpreterHeader = new DataView(bytes.buffer, 64, 56);
    interpreterHeader.setUint32(0, 3, true);
    interpreterHeader.setBigUint64(8, BigInt(interpreterOffset), true);
    interpreterHeader.setBigUint64(32, BigInt(interpreterBytes.length), true);
    const dynamicHeader = new DataView(bytes.buffer, 120, 56);
    dynamicHeader.setUint32(0, 2, true);
    bytes.set(interpreterBytes, interpreterOffset);
  }
  return bytes;
}

export async function writeElf64X86_64(
  path: string,
  mode = 0o755,
  interpreter: string | null = null,
): Promise<void> {
  await Deno.writeFile(path, elf64X86_64Fixture(interpreter), { mode });
  if (Deno.build.os !== "windows") await Deno.chmod(path, mode);
}

export class FakeSourceRef implements SourceRefApi {
  readonly root: string;
  readonly repositoryHome: string;
  readonly checkoutPath: string;
  readonly calls: string[] = [];
  readonly zlsCalls: string[] = [];
  refs: RemoteRef[] = [
    { kind: "tag", name: "0.16.0", commit: COMMIT_A },
    { kind: "tag", name: "0.15.2", commit: COMMIT_C },
    { kind: "branch", name: "master", commit: COMMIT_B },
  ];
  failRemote = false;
  failZlsRemote = false;
  head: RemoteHead = { branch: "master", commit: COMMIT_B };
  dirty = false;
  locked: { ref: CheckoutResult["requested"]; commit: string } | null = null;
  zlsRefs: RemoteRef[] = [
    { kind: "tag", name: "0.16.0", commit: COMMIT_D },
    { kind: "tag", name: "0.16.2", commit: COMMIT_E },
    { kind: "tag", name: "0.15.3", commit: COMMIT_C },
    { kind: "branch", name: "master", commit: COMMIT_E },
  ];
  zlsHead: RemoteHead = { branch: "master", commit: COMMIT_E };
  zlsLocked: { ref: CheckoutResult["requested"]; commit: string } | null = null;
  readonly versions = new Map<string, { base: string; tag: string; distance: number }>([
    [COMMIT_A, { base: "0.16.0", tag: "0.16.0", distance: 0 }],
    [COMMIT_B, { base: "0.16.1", tag: "0.16.1", distance: 0 }],
    [COMMIT_C, { base: "0.15.2", tag: "0.15.2", distance: 0 }],
  ]);
  readonly zlsVersions = new Map<
    string,
    {
      declaredVersion: string;
      minimumBuildVersion: string;
      maximumBuildVersionExclusive: string | null;
      tag: string;
      distance: number;
    }
  >([
    [COMMIT_C, {
      declaredVersion: "0.15.3",
      minimumBuildVersion: "0.15.2",
      maximumBuildVersionExclusive: null,
      tag: "0.15.3",
      distance: 0,
    }],
    [COMMIT_D, {
      declaredVersion: "0.16.0",
      minimumBuildVersion: "0.16.0",
      maximumBuildVersionExclusive: null,
      tag: "0.16.0",
      distance: 0,
    }],
    [COMMIT_E, {
      declaredVersion: "0.16.2",
      minimumBuildVersion: "0.16.0",
      maximumBuildVersionExclusive: null,
      tag: "0.16.2",
      distance: 0,
    }],
    [COMMIT_F, {
      declaredVersion: "0.17.0-dev",
      minimumBuildVersion: "0.17.0-dev.1+aaaaaaaaa",
      maximumBuildVersionExclusive: null,
      tag: "0.16.2",
      distance: 8,
    }],
  ]);
  readonly zlsRepositoryHome: string;
  readonly zlsCheckoutPath: string;

  constructor(projectRoot: string, sourceRoot = join(projectRoot, ".source-ref")) {
    this.root = sourceRoot;
    this.repositoryHome = join(this.root, "codeberg", "zig");
    this.checkoutPath = join(this.repositoryHome, "git-src");
    this.zlsRepositoryHome = join(this.root, "github", "zls");
    this.zlsCheckoutPath = join(this.zlsRepositoryHome, "git-src");
  }

  resolveRemoteHead(
    request: Parameters<SourceRefApi["resolveRemoteHead"]>[0],
  ): Promise<RemoteHead> {
    if (request.url === ZLS_SOURCE_REPOSITORY_URL) {
      this.zlsCalls.push("resolveRemoteHead");
      if (this.failZlsRemote) return Promise.reject(new Error("ZLS remote unavailable"));
      return Promise.resolve({ ...this.zlsHead });
    }
    this.calls.push("resolveRemoteHead");
    if (this.failRemote) return Promise.reject(new Error("remote unavailable"));
    return Promise.resolve({ ...this.head });
  }

  listRemoteRefs(
    request: { readonly url: string; readonly kind?: "tag" | "branch" },
  ): Promise<RemoteRef[]> {
    if (request.url === ZLS_SOURCE_REPOSITORY_URL) {
      this.zlsCalls.push("listRemoteRefs");
      if (this.failZlsRemote) return Promise.reject(new Error("ZLS remote unavailable"));
      return Promise.resolve(
        this.zlsRefs.filter((ref) => request.kind === undefined || ref.kind === request.kind),
      );
    }
    this.calls.push("listRemoteRefs");
    if (this.failRemote) return Promise.reject(new Error("remote unavailable"));
    return Promise.resolve(
      this.refs.filter((ref) => request.kind === undefined || ref.kind === request.kind),
    );
  }

  describeRevision(selector: unknown): Promise<RevisionDescription> {
    const zls = isZlsRepository(selector);
    (zls ? this.zlsCalls : this.calls).push("describeRevision");
    const locked = zls ? this.zlsLocked : this.locked;
    if (!locked) {
      return Promise.reject(
        new RepositoryNotFoundError(zls ? ZLS_SOURCE_REPOSITORY_IDENTITY : "codeberg/zig"),
      );
    }
    if (zls) {
      const metadata = this.zlsVersions.get(locked.commit);
      if (!metadata) throw new Error(`missing fake ZLS version metadata for ${locked.commit}`);
      return Promise.resolve({
        commit: locked.commit,
        tag: metadata.tag,
        commitsSinceTag: metadata.distance,
        abbreviatedCommit: locked.commit.slice(0, 9),
      });
    }
    const metadata = this.versions.get(locked.commit);
    if (!metadata) throw new Error(`missing fake version metadata for ${locked.commit}`);
    return Promise.resolve({
      commit: locked.commit,
      tag: metadata.tag,
      commitsSinceTag: metadata.distance,
      abbreviatedCommit: locked.commit.slice(0, 9),
    });
  }

  async ensure(request: {
    readonly id: { readonly provider: string; readonly name: string };
    readonly url: string;
    readonly mode: "pinned" | "branch";
    readonly ref: CheckoutResult["requested"];
  }): Promise<CheckoutResult> {
    const zls = request.id.provider === "github" && request.id.name === "zls";
    (zls ? this.zlsCalls : this.calls).push("ensure");
    const locked = zls ? this.zlsLocked : this.locked;
    if (locked && !sameRef(locked.ref, request.ref)) {
      throw new LockedRequestMismatchError(zls ? ZLS_SOURCE_REPOSITORY_IDENTITY : "codeberg/zig");
    }
    const cloned = locked === null;
    const commit = locked?.commit ?? this.resolveRef(request.ref, zls);
    if (zls) this.zlsLocked ??= { ref: { ...request.ref }, commit };
    else this.locked ??= { ref: { ...request.ref }, commit };
    await this.writeSource(commit, zls);
    return this.result(request.ref, commit, cloned, zls);
  }

  async sync(): Promise<CheckoutResult[]> {
    this.calls.push("sync");
    if (!this.locked) throw new RepositoryNotFoundError("codeberg/zig");
    await this.writeSource(this.locked.commit);
    return [this.result(this.locked.ref, this.locked.commit, false)];
  }

  async update(
    selector: unknown,
    options: { readonly ref?: CheckoutResult["requested"] } = {},
  ): Promise<CheckoutResult> {
    const zls = isZlsRepository(selector);
    (zls ? this.zlsCalls : this.calls).push("update");
    const locked = zls ? this.zlsLocked : this.locked;
    if (!locked) {
      throw new RepositoryNotFoundError(zls ? ZLS_SOURCE_REPOSITORY_IDENTITY : "codeberg/zig");
    }
    const ref = options.ref ?? locked.ref;
    const commit = this.resolveRef(ref, zls);
    if (zls) this.zlsLocked = { ref: { ...ref }, commit };
    else this.locked = { ref: { ...ref }, commit };
    await this.writeSource(commit, zls);
    return this.result(ref, commit, false, zls);
  }

  doctor(): Promise<SourceRefDoctorResult> {
    this.calls.push("doctor");
    return Promise.resolve({
      schemaVersion: 1,
      ok: true,
      git: {
        available: true,
        version: "2.50.0",
        minimumVersion: "2.20.0",
        supported: true,
        message: null,
      },
      projectRoot: dirname(this.root),
      root: this.root,
      lockFile: join(dirname(this.root), "source-ref.lock.json"),
    });
  }

  status(selector?: unknown): Promise<RepositoryStatus[]> {
    const zls = isZlsRepository(selector);
    (zls ? this.zlsCalls : this.calls).push("status");
    const locked = zls ? this.zlsLocked : this.locked;
    if (!locked) {
      return Promise.reject(
        new RepositoryNotFoundError(zls ? ZLS_SOURCE_REPOSITORY_IDENTITY : "codeberg/zig"),
      );
    }
    return Promise.resolve([{
      id: zls ? { provider: "github", name: "zls" } : { provider: "codeberg", name: "zig" },
      repositoryHome: zls ? this.zlsRepositoryHome : this.repositoryHome,
      checkoutPath: zls ? this.zlsCheckoutPath : this.checkoutPath,
      url: zls ? ZLS_SOURCE_REPOSITORY_URL : "https://codeberg.org/ziglang/zig.git",
      mode: "pinned",
      requested: { ...locked.ref },
      lockedCommit: locked.commit,
      checkoutExists: true,
      currentCommit: locked.commit,
      currentBranch: null,
      dirty: this.dirty,
      changes: this.dirty ? [" M fixture.zig"] : [],
      aheadBehind: null,
      matchesLock: true,
    }]);
  }

  path(selector: unknown, options: { readonly repositoryRoot?: boolean } = {}): string {
    const zls = isZlsRepository(selector);
    (zls ? this.zlsCalls : this.calls).push("path");
    if (zls) return options.repositoryRoot ? this.zlsRepositoryHome : this.zlsCheckoutPath;
    return options.repositoryRoot ? this.repositoryHome : this.checkoutPath;
  }

  private resolveRef(ref: CheckoutResult["requested"], zls = false): string {
    if (ref.kind === "commit") return ref.value.toLowerCase();
    const refs = zls ? this.zlsRefs : this.refs;
    const remote = refs.find((item) => item.kind === ref.kind && item.name === ref.value);
    if (!remote) throw new Error(`missing fake ref ${ref.kind}:${ref.value}`);
    return remote.commit;
  }

  private async writeSource(commit: string, zls = false): Promise<void> {
    if (zls) {
      const metadata = this.zlsVersions.get(commit);
      if (!metadata) throw new Error(`missing fake ZLS version metadata for ${commit}`);
      await Deno.mkdir(this.zlsCheckoutPath, { recursive: true });
      await Deno.writeTextFile(
        join(this.zlsCheckoutPath, "build.zig.zon"),
        `.{\n    .name = .zls,\n    .version = "${metadata.declaredVersion}",\n    .minimum_zig_version = "${metadata.minimumBuildVersion}",\n}\n`,
      );
      await Deno.writeTextFile(
        join(this.zlsCheckoutPath, "build.zig"),
        [
          'const std = @import("std");',
          'const builtin = @import("builtin");',
          'const minimum_build_zig_version = @import("build.zig.zon").minimum_zig_version;',
          ...(metadata.maximumBuildVersionExclusive === null ? [] : [
            "const Build = blk: {",
            `    const version = std.SemanticVersion.parse("${metadata.maximumBuildVersionExclusive}") catch unreachable;`,
            "    if (builtin.zig_version.order(version) != .lt) {",
            '        @compileError("The used Zig version is not yet supported by ZLS.");',
            "    }",
            "};",
          ]),
          "",
        ].join("\n"),
      );
      return;
    }
    const metadata = this.versions.get(commit);
    if (!metadata) throw new Error(`missing fake version metadata for ${commit}`);
    const [major, minor, patch] = metadata.base.split(".");
    await Deno.mkdir(this.checkoutPath, { recursive: true });
    await Deno.writeTextFile(
      join(this.checkoutPath, "CMakeLists.txt"),
      [
        "cmake_minimum_required(VERSION 3.15)",
        `set(ZIG_VERSION_MAJOR ${major})`,
        `set(ZIG_VERSION_MINOR ${minor})`,
        `set(ZIG_VERSION_PATCH ${patch})`,
        'set(ZIG_VERSION "" CACHE STRING "Override Zig version")',
        'set(ZIG_USE_LLVM_CONFIG ON CACHE BOOL "use llvm-config")',
        "find_package(llvm 21)",
        "find_package(clang 21)",
        "find_package(lld 21)",
        "set(ZIG_BUILD_ARGS",
        "  -Dno-langref",
        ")",
        'set(ZIG_EXTRA_BUILD_ARGS "" CACHE STRING "Extra zig build args")',
        "if(ZIG_EXTRA_BUILD_ARGS)",
        "  list(APPEND ZIG_BUILD_ARGS ${ZIG_EXTRA_BUILD_ARGS})",
        "endif()",
        "install(SCRIPT cmake/install.cmake)",
        "",
      ].join("\n"),
    );
  }

  private result(
    ref: CheckoutResult["requested"],
    commit: string,
    cloned: boolean,
    zls = false,
  ): CheckoutResult {
    return {
      operationId: "fake-operation",
      id: zls ? { provider: "github", name: "zls" } : { provider: "codeberg", name: "zig" },
      repositoryHome: zls ? this.zlsRepositoryHome : this.repositoryHome,
      checkoutPath: zls ? this.zlsCheckoutPath : this.checkoutPath,
      url: zls ? ZLS_SOURCE_REPOSITORY_URL : "https://codeberg.org/ziglang/zig.git",
      mode: "pinned",
      requested: { ...ref },
      resolvedCommit: commit,
      cloned,
      fetched: true,
      checkoutChanged: true,
    };
  }
}

export class FakeProcessRunner implements ProcessRunner, ZlsLspProtocolVerifier {
  readonly contractVersion = ZLS_INSTALL_VERIFIER_CONTRACT_VERSION;
  readonly requests: ProcessRequest[] = [];
  readonly prefix: string;
  runExit: ProcessResult | null = null;
  wrongZigVersion = false;
  wrongZlsVersion = false;
  zigVersion = "0.16.0";
  failZlsBuild = false;
  failZlsProtocol = false;
  zlsBuildCount = 0;
  zlsProtocolCalls = 0;
  omitLib = false;
  failDocs = false;
  omitDocsAsset: string | null = null;
  docsStarted: (() => void) | null = null;
  docsGate: Promise<void> | null = null;
  buildStarted: (() => void) | null = null;
  buildGate: Promise<void> | null = null;
  llvmTargets =
    "AArch64 AMDGPU ARM AVR BPF Hexagon Lanai LoongArch Mips MSP430 NVPTX PowerPC RISCV SPIRV Sparc SystemZ VE WebAssembly X86 XCore";
  toolVersions: Partial<Record<"cmake" | "llvm" | "clang" | "lld", string>> = {};
  #installs = new Map<string, string>();
  #zlsVersions = new Map<string, string>();
  #latestZlsVersion: string | null = null;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  verify(
    _input: ZlsLspProtocolVerifierInput,
  ): Promise<ZlsLspProtocolVerification> {
    this.zlsProtocolCalls++;
    if (this.failZlsProtocol) return Promise.reject(new Error("synthetic ZLS protocol failure"));
    return Promise.resolve({ initialized: true, shutdown: true });
  }

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.requests.push({ ...request, args: [...request.args], env: { ...(request.env ?? {}) } });
    const executable = request.executable;
    const name = executable.replaceAll("\\", "/").split("/").at(-1) ?? executable;
    const docsExecutable = name === "prlimit" && request.args[0] === "--core=1:" &&
        request.args[1] === "--"
      ? request.args[2] ?? ""
      : executable;
    const docsArgs = docsExecutable === executable ? request.args : request.args.slice(3);
    const docsName = docsExecutable.replaceAll("\\", "/").split("/").at(-1) ?? docsExecutable;
    if (request.args[0] === "version" && /zig(?:\.exe)?$/.test(name)) {
      return await this.result(request, this.wrongZigVersion ? "0.15.2\n" : `${this.zigVersion}\n`);
    }
    if (request.args[0] === "env" && /zig(?:\.exe)?$/.test(name)) {
      const install = dirname(dirname(executable));
      return await this.result(
        request,
        `.{\n    .lib_dir = ${
          JSON.stringify(join(install, "lib", "zig"))
        },\n    .target = "x86_64-unknown-linux-gnu",\n}\n`,
      );
    }
    if (request.args[0] === "build-exe" && /zig(?:\.exe)?$/.test(name)) {
      const output = request.args.find((arg) => arg.startsWith("-femit-bin="))?.slice(
        "-femit-bin=".length,
      );
      if (output === undefined) throw new Error("fake compile omitted output path");
      await writeElf64X86_64(output);
      return await this.result(request, "compiled\n");
    }
    if (
      request.args[0] === "build" && /zig(?:\.exe)?$/.test(name) &&
      request.args.some((argument) => argument.startsWith("-Dversion-string="))
    ) {
      this.zlsBuildCount++;
      if (this.failZlsBuild) return await this.result(request, "", "ZLS build failed\n", 2);
      const prefixIndex = request.args.indexOf("--prefix");
      if (prefixIndex < 0 || request.args[prefixIndex + 1] === undefined) {
        throw new Error("fake ZLS build omitted --prefix");
      }
      const install = request.args[prefixIndex + 1];
      const executablePath = join(install, "bin", "zls");
      const version = request.args.find((argument) => argument.startsWith("-Dversion-string="))!
        .slice("-Dversion-string=".length);
      const installationId = install.split(/[\\/]/).findLast((segment) =>
        /^[0-9a-f]{64}$/.test(segment)
      );
      if (installationId === undefined) {
        throw new Error("fake ZLS build path omitted installation ID");
      }
      this.#zlsVersions.set(installationId, version);
      this.#latestZlsVersion = version;
      await Deno.mkdir(dirname(executablePath), { recursive: true });
      await writeElf64X86_64(executablePath);
      return await this.result(request, "built ZLS\n");
    }
    if (request.args[0] === "--version" && /zls(?:\.exe)?$/.test(name)) {
      const installationId = executable.split(/[\\/]/).findLast((segment) =>
        /^[0-9a-f]{64}$/.test(segment)
      );
      const version = installationId === undefined
        ? this.#latestZlsVersion ?? undefined
        : this.#zlsVersions.get(installationId) ?? this.#latestZlsVersion ?? undefined;
      if (version === undefined) throw new Error("fake ZLS version has no build record");
      if (installationId !== undefined) this.#zlsVersions.set(installationId, version);
      return await this.result(request, `${this.wrongZlsVersion ? "0.0.0" : version}\n`);
    }
    if (docsArgs[0] === "build" && docsArgs[1] === "docs" && /zig(?:\.exe)?$/.test(docsName)) {
      this.docsStarted?.();
      if (this.docsGate !== null) await this.docsGate;
      if (this.failDocs) return await this.result(request, "", "docs failed\n", 2);
      const prefix = docsArgs[docsArgs.indexOf("-p") + 1];
      await createDocsFixture(join(prefix, "doc"), this.omitDocsAsset);
      return await this.result(request, "docs complete\n");
    }
    if (this.runExit && /zig(?:\.exe)?$/.test(name)) return this.runExit;

    if (request.args[0] === "--version") {
      if (name.includes("cmake")) {
        return await this.result(request, `cmake version ${this.toolVersions.cmake ?? "3.30.0"}\n`);
      }
      if (name.includes("llvm-config")) {
        return await this.result(request, `${this.toolVersions.llvm ?? "21.1.0"}\n`);
      }
      if (name.includes("clang")) {
        return await this.result(request, `clang version ${this.toolVersions.clang ?? "21.1.0"}\n`);
      }
      if (name.includes("lld")) {
        return await this.result(request, `LLD ${this.toolVersions.lld ?? "21.1.0"}\n`);
      }
      return await this.result(request, `${name} version 15.0.0\n`);
    }
    if (executable === "/usr/bin/pacman" && request.args[0] === "-Q") {
      return await this.result(request, `${request.args[1]} 21.1.0-1\n`);
    }
    if (request.args[0] === "--help" && name.includes("cmake")) {
      return await this.result(request, "Generators\n  Ninja = Generates build.ninja files.\n");
    }
    if (name.includes("llvm-config")) {
      if (request.args[0] === "--targets-built") {
        return await this.result(request, `${this.llvmTargets}\n`);
      }
      if (request.args[0] === "--prefix") return await this.result(request, `${this.prefix}\n`);
      if (request.args[0] === "--includedir") {
        return await this.result(request, `${join(this.prefix, "include")}\n`);
      }
      if (request.args[0] === "--libdir") {
        return await this.result(request, `${join(this.prefix, "lib")}\n`);
      }
    }
    if (name.includes("cmake") && request.args[0] === "-S") {
      const build = request.args[request.args.indexOf("-B") + 1];
      const installArg = request.args.find((arg) => arg.startsWith("-DCMAKE_INSTALL_PREFIX="));
      if (!installArg) throw new Error("fake configure command omitted install prefix");
      this.#installs.set(build, installArg.slice("-DCMAKE_INSTALL_PREFIX=".length));
      return await this.result(request, "configured\n");
    }
    if (name.includes("cmake") && request.args[0] === "--build") {
      this.buildStarted?.();
      if (this.buildGate !== null) await this.buildGate;
      if (request.signal?.aborted) {
        throw new ZigOperationAbortedError("fake CMake build", {}, {
          cause: request.signal.reason,
        });
      }
      const install = this.#installs.get(request.args[1]);
      if (!install) throw new Error("fake build has no configure record");
      const executablePath = join(install, "bin", Deno.build.os === "windows" ? "zig.exe" : "zig");
      await Deno.mkdir(dirname(executablePath), { recursive: true });
      await writeElf64X86_64(executablePath);
      if (!this.omitLib) {
        await Deno.mkdir(join(install, "lib", "zig", "std"), { recursive: true });
        await Deno.writeTextFile(
          join(install, "lib", "zig", "std", "std.zig"),
          "pub const fixture = true;\n",
        );
      }
      return await this.result(request, "built\n");
    }
    return await this.result(request, `${name} 1.0.0\n`);
  }

  private async result(
    request: ProcessRequest,
    stdout = "",
    stderr = "",
    code = 0,
    signal: Deno.Signal | null = null,
  ): Promise<ProcessResult> {
    const encoder = new TextEncoder();
    if (stdout && request.onStdout) await request.onStdout(encoder.encode(stdout));
    if (stderr && request.onStderr) await request.onStderr(encoder.encode(stderr));
    return {
      success: code === 0 && signal === null,
      code,
      signal,
      stdout,
      stderr,
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  }
}

export async function createDocsFixture(root: string, omit: string | null = null): Promise<void> {
  const files: Readonly<Record<string, string | Uint8Array>> = {
    "langref.html":
      "<!doctype html><html><body><h1>Zig 0.16.0 Language Reference</h1></body></html>",
    "std/index.html":
      '<!doctype html><html><body><h1>Standard</h1><script src="main.js"></script></body></html>',
    "std/main.js":
      'let wasm_promise = fetch("main.wasm");\nlet sources_promise = fetch("sources.tar").then(function(response) { return response.arrayBuffer(); });\n',
    "std/main.wasm": new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
    "std/sources.tar": new Uint8Array(1024),
  };
  for (const [path, value] of Object.entries(files)) {
    if (path === omit) continue;
    const destination = join(root, ...path.split("/"));
    await Deno.mkdir(dirname(destination), { recursive: true });
    if (typeof value === "string") await Deno.writeTextFile(destination, value);
    else await Deno.writeFile(destination, value);
  }
}

export async function cleanup(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound)) throw cause;
  }
}

export function okResult(stdout = ""): ProcessResult {
  return {
    success: true,
    code: 0,
    signal: null,
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function sameRef(
  left: CheckoutResult["requested"],
  right: CheckoutResult["requested"],
): boolean {
  return left.kind === right.kind && left.value === right.value;
}

function isZlsRepository(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const repository = value as { readonly provider?: unknown; readonly name?: unknown };
  return repository.provider === "github" && repository.name === "zls";
}
