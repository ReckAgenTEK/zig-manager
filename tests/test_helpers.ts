import { LockedRequestMismatchError, RepositoryNotFoundError } from "@source-ref/source-ref";
import { dirname, join } from "@std/path";
import type {
  CheckoutResult,
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
  RemoteRef,
  RepositoryStatus,
  RevisionDescription,
  SourceRefApi,
  SourceRefDoctorResult,
  ZigManagerConfig,
} from "../src/mod.ts";

export const COMMIT_A = "a".repeat(40);
export const COMMIT_B = "b".repeat(40);
export const COMMIT_C = "c".repeat(40);

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
  return prefix;
}

export class FakeSourceRef implements SourceRefApi {
  readonly root: string;
  readonly repositoryHome: string;
  readonly checkoutPath: string;
  readonly calls: string[] = [];
  refs: RemoteRef[] = [
    { kind: "tag", name: "0.16.0", commit: COMMIT_A },
    { kind: "tag", name: "0.15.2", commit: COMMIT_C },
    { kind: "branch", name: "master", commit: COMMIT_B },
  ];
  failRemote = false;
  dirty = false;
  locked: { ref: CheckoutResult["requested"]; commit: string } | null = null;
  readonly versions = new Map<string, { base: string; tag: string; distance: number }>([
    [COMMIT_A, { base: "0.16.0", tag: "0.16.0", distance: 0 }],
    [COMMIT_B, { base: "0.16.1", tag: "0.16.1", distance: 0 }],
    [COMMIT_C, { base: "0.15.2", tag: "0.15.2", distance: 0 }],
  ]);

  constructor(projectRoot: string) {
    this.root = join(projectRoot, ".source-ref");
    this.repositoryHome = join(this.root, "codeberg", "zig");
    this.checkoutPath = join(this.repositoryHome, "git-src");
  }

  listRemoteRefs(request: { readonly kind?: "tag" | "branch" }): Promise<RemoteRef[]> {
    this.calls.push("listRemoteRefs");
    if (this.failRemote) return Promise.reject(new Error("remote unavailable"));
    return Promise.resolve(
      this.refs.filter((ref) => request.kind === undefined || ref.kind === request.kind),
    );
  }

  describeRevision(): Promise<RevisionDescription> {
    this.calls.push("describeRevision");
    if (!this.locked) return Promise.reject(new RepositoryNotFoundError("codeberg/zig"));
    const metadata = this.versions.get(this.locked.commit);
    if (!metadata) throw new Error(`missing fake version metadata for ${this.locked.commit}`);
    return Promise.resolve({
      commit: this.locked.commit,
      tag: metadata.tag,
      commitsSinceTag: metadata.distance,
      abbreviatedCommit: this.locked.commit.slice(0, 9),
    });
  }

  async ensure(request: {
    readonly id: { readonly provider: string; readonly name: string };
    readonly url: string;
    readonly mode: "pinned" | "branch";
    readonly ref: CheckoutResult["requested"];
  }): Promise<CheckoutResult> {
    this.calls.push("ensure");
    if (this.locked && !sameRef(this.locked.ref, request.ref)) {
      throw new LockedRequestMismatchError("codeberg/zig");
    }
    const commit = this.locked?.commit ?? this.resolveRef(request.ref);
    this.locked ??= { ref: { ...request.ref }, commit };
    await this.writeSource(commit);
    return this.result(request.ref, commit, this.locked === null);
  }

  async sync(): Promise<CheckoutResult[]> {
    this.calls.push("sync");
    if (!this.locked) throw new RepositoryNotFoundError("codeberg/zig");
    await this.writeSource(this.locked.commit);
    return [this.result(this.locked.ref, this.locked.commit, false)];
  }

  async update(
    _selector: unknown,
    options: { readonly ref?: CheckoutResult["requested"] } = {},
  ): Promise<CheckoutResult> {
    this.calls.push("update");
    if (!this.locked) throw new RepositoryNotFoundError("codeberg/zig");
    const ref = options.ref ?? this.locked.ref;
    const commit = this.resolveRef(ref);
    this.locked = { ref: { ...ref }, commit };
    await this.writeSource(commit);
    return this.result(ref, commit, false);
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

  status(): Promise<RepositoryStatus[]> {
    this.calls.push("status");
    if (!this.locked) return Promise.reject(new RepositoryNotFoundError("codeberg/zig"));
    return Promise.resolve([{
      id: { provider: "codeberg", name: "zig" },
      repositoryHome: this.repositoryHome,
      checkoutPath: this.checkoutPath,
      url: "https://codeberg.org/ziglang/zig.git",
      mode: "pinned",
      requested: { ...this.locked.ref },
      lockedCommit: this.locked.commit,
      checkoutExists: true,
      currentCommit: this.locked.commit,
      currentBranch: null,
      dirty: this.dirty,
      changes: this.dirty ? [" M fixture.zig"] : [],
      aheadBehind: null,
      matchesLock: true,
    }]);
  }

  path(_selector: unknown, options: { readonly repositoryRoot?: boolean } = {}): string {
    this.calls.push("path");
    return options.repositoryRoot ? this.repositoryHome : this.checkoutPath;
  }

  private resolveRef(ref: CheckoutResult["requested"]): string {
    if (ref.kind === "commit") return ref.value.toLowerCase();
    const remote = this.refs.find((item) => item.kind === ref.kind && item.name === ref.value);
    if (!remote) throw new Error(`missing fake ref ${ref.kind}:${ref.value}`);
    return remote.commit;
  }

  private async writeSource(commit: string): Promise<void> {
    const metadata = this.versions.get(commit);
    if (!metadata) throw new Error(`missing fake version metadata for ${commit}`);
    const [major, minor, patch] = metadata.base.split(".");
    await Deno.mkdir(this.checkoutPath, { recursive: true });
    await Deno.writeTextFile(
      join(this.checkoutPath, "CMakeLists.txt"),
      `set(ZIG_VERSION_MAJOR ${major})\nset(ZIG_VERSION_MINOR ${minor})\nset(ZIG_VERSION_PATCH ${patch})\n`,
    );
  }

  private result(
    ref: CheckoutResult["requested"],
    commit: string,
    cloned: boolean,
  ): CheckoutResult {
    return {
      operationId: "fake-operation",
      id: { provider: "codeberg", name: "zig" },
      repositoryHome: this.repositoryHome,
      checkoutPath: this.checkoutPath,
      url: "https://codeberg.org/ziglang/zig.git",
      mode: "pinned",
      requested: { ...ref },
      resolvedCommit: commit,
      cloned,
      fetched: true,
      checkoutChanged: true,
    };
  }
}

export class FakeProcessRunner implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];
  readonly prefix: string;
  runExit: ProcessResult | null = null;
  wrongZigVersion = false;
  zigVersion = "0.16.0";
  omitLib = false;
  failDocs = false;
  omitDocsAsset: string | null = null;
  docsStarted: (() => void) | null = null;
  docsGate: Promise<void> | null = null;
  llvmTargets =
    "AArch64 AMDGPU ARM AVR BPF Hexagon Lanai LoongArch Mips MSP430 NVPTX PowerPC RISCV SPIRV Sparc SystemZ VE WebAssembly X86 XCore";
  toolVersions: Partial<Record<"cmake" | "llvm" | "clang" | "lld", string>> = {};
  #installs = new Map<string, string>();

  constructor(prefix: string) {
    this.prefix = prefix;
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
        `.{\n    .lib_dir = ${JSON.stringify(join(install, "lib", "zig"))},\n}\n`,
      );
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
      const install = this.#installs.get(request.args[1]);
      if (!install) throw new Error("fake build has no configure record");
      const executablePath = join(install, "bin", Deno.build.os === "windows" ? "zig.exe" : "zig");
      await Deno.mkdir(dirname(executablePath), { recursive: true });
      await Deno.writeTextFile(executablePath, "synthetic managed zig\n");
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
