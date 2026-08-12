import { dirname, isAbsolute, join, relative, resolve } from "@std/path";
import {
  isZlsBuildRecipe,
  validateZlsBuildRecipe,
  ZLS_BUILD_CONTRACT_VERSION,
  ZLS_BUILD_RECIPE_ADAPTER_ID,
  ZLS_INSTALL_VERIFIER_CONTRACT_VERSION,
  type ZlsBuildRecipeV1,
} from "./build_recipe.ts";
import { type Elf64X86_64Info, inspectElf64X86_64 } from "./elf.ts";
import { ZigOperationAbortedError } from "./errors.ts";
import { assertPathContained, canonicalJson, fileMetadata, isPathContained } from "./filesystem.ts";
import {
  computeInstallationId,
  type InstalledObject,
  type InstallManifestV3,
  type InstallPublishResult,
  type InstallStaging,
  InstallStore,
  InstallStoreError,
  type RuntimeDependencyInspector,
  type RuntimeLinkageRecord,
  validateInstallManifest,
} from "./install_store.ts";
import type { ProcessResult, ProcessRunner } from "./types.ts";
import { type ResolvedZlsSource, validateResolvedZlsSource } from "./zls_source_workspace.ts";
import { validateZlsBuildManifest, type ZlsBuildManifestV1 } from "./zls_build.ts";

const MAX_VERSION_OUTPUT_BYTES = 16 * 1024;
const MAX_LSP_MESSAGE_BYTES = 1024 * 1024;
const MAX_LSP_STDERR_BYTES = 64 * 1024;
const MAX_LSP_MESSAGES = 64;
const DEFAULT_LSP_TIMEOUT_MS = 5_000;
const MAX_CONFIGURED_LSP_TIMEOUT_MS = 60_000;
const MAX_CONFIGURED_LSP_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_CONFIGURED_LSP_STDERR_BYTES = 1024 * 1024;
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ZlsLspProtocolVerifierInput {
  readonly executablePath: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface ZlsLspProtocolVerification {
  readonly initialized: true;
  readonly shutdown: true;
}

/** Interactive seam kept separate because ProcessRunner intentionally has no stdin protocol API. */
export interface ZlsLspProtocolVerifier {
  readonly contractVersion: number;
  verify(input: ZlsLspProtocolVerifierInput): Promise<ZlsLspProtocolVerification>;
}

export interface DenoZlsLspProtocolVerifierOptions {
  readonly timeoutMs?: number;
  readonly maxMessageBytes?: number;
  readonly maxStderrBytes?: number;
}

export interface VerifyInstalledZlsInput {
  readonly executablePath: string;
  readonly installPath: string;
  readonly expectedVersion: string;
  readonly expectedSize: number;
  readonly expectedSha256: string;
  readonly runner: ProcessRunner;
  readonly runtimeDependencyInspector: RuntimeDependencyInspector;
  readonly protocolVerifier?: ZlsLspProtocolVerifier;
  readonly cacheRoot: string;
  readonly scratchRoot: string;
  readonly platform: "linux" | "darwin" | "windows";
  readonly expectedFormat?: Elf64X86_64Info;
  readonly expectedRuntime?: RuntimeLinkageRecord;
  readonly operationId?: string;
  readonly signal?: AbortSignal;
}

export interface ZlsInstallVerification {
  readonly version: string;
  readonly executableSize: number;
  readonly executableSha256: string;
  readonly executableFormat: Elf64X86_64Info;
  readonly runtime: RuntimeLinkageRecord;
  readonly protocol: ZlsLspProtocolVerification;
}

export interface InstallBuiltZlsStore {
  readonly stagingRoot: string;
  installationPath(component: "zls", installationId: string): string;
  get(component: "zls", installationId: string): ReturnType<InstallStore["get"]>;
  createStaging(
    component: "zls",
    installationId: string,
    operationId?: string,
    signal?: AbortSignal,
  ): ReturnType<InstallStore["createStaging"]>;
  publish(
    staging: InstallStaging,
    manifest: InstallManifestV3,
    signal?: AbortSignal,
  ): ReturnType<InstallStore["publish"]>;
  quarantine(
    component: "zls",
    installationId: string,
    operationId: string,
    authorization: "corrupt" | "created",
    signal?: AbortSignal,
  ): ReturnType<InstallStore["quarantine"]>;
}

export interface InstallBuiltZlsInput {
  readonly buildManifest: ZlsBuildManifestV1;
  readonly source: ResolvedZlsSource;
  readonly zig: InstalledObject;
  readonly store: InstallBuiltZlsStore;
  readonly runner: ProcessRunner;
  readonly runtimeDependencyInspector: RuntimeDependencyInspector;
  readonly protocolVerifier?: ZlsLspProtocolVerifier;
  readonly cacheRoot: string;
  readonly platform: "linux" | "darwin" | "windows";
  readonly operationId?: string;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

export interface InstallBuiltZlsResult extends InstallPublishResult {
  readonly installationId: string;
  readonly copied: boolean;
  readonly stagedVerification: ZlsInstallVerification | null;
  readonly promotedVerification: ZlsInstallVerification;
}

export interface ReuseInstalledZlsInput {
  readonly recipe: ZlsBuildRecipeV1;
  readonly source: ResolvedZlsSource;
  readonly zig: InstalledObject;
  readonly store: Pick<InstallStore, "get" | "stagingRoot">;
  readonly runner: ProcessRunner;
  readonly runtimeDependencyInspector: RuntimeDependencyInspector;
  readonly protocolVerifier?: ZlsLspProtocolVerifier;
  readonly cacheRoot: string;
  readonly platform: "linux" | "darwin" | "windows";
  readonly operationId?: string;
  readonly signal?: AbortSignal;
}

interface PreparedZlsIdentity {
  readonly buildManifest: ZlsBuildManifestV1;
  readonly source: ResolvedZlsSource;
  readonly recipe: ZlsBuildRecipeV1;
  readonly installationId: string;
}

export class ZlsVerificationError extends Error {
  readonly code = "ZLS_VERIFICATION_FAILED";
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    reason: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(`ZLS verification failed: ${reason}`, options);
    this.name = "ZlsVerificationError";
    this.details = { reason, ...details };
  }
}

/** Production protocol verifier performing a real bounded LSP initialize/shutdown exchange. */
export class DenoZlsLspProtocolVerifier implements ZlsLspProtocolVerifier {
  readonly contractVersion = ZLS_INSTALL_VERIFIER_CONTRACT_VERSION;
  readonly #timeoutMs: number;
  readonly #maxMessageBytes: number;
  readonly #maxStderrBytes: number;

  constructor(options: DenoZlsLspProtocolVerifierOptions = {}) {
    this.#timeoutMs = boundedPositiveInteger(
      options.timeoutMs ?? DEFAULT_LSP_TIMEOUT_MS,
      "timeoutMs",
      MAX_CONFIGURED_LSP_TIMEOUT_MS,
    );
    this.#maxMessageBytes = boundedPositiveInteger(
      options.maxMessageBytes ?? MAX_LSP_MESSAGE_BYTES,
      "maxMessageBytes",
      MAX_CONFIGURED_LSP_MESSAGE_BYTES,
    );
    this.#maxStderrBytes = boundedPositiveInteger(
      options.maxStderrBytes ?? MAX_LSP_STDERR_BYTES,
      "maxStderrBytes",
      MAX_CONFIGURED_LSP_STDERR_BYTES,
    );
  }

  async verify(input: ZlsLspProtocolVerifierInput): Promise<ZlsLspProtocolVerification> {
    throwIfAborted(input.signal, "verify ZLS LSP protocol");
    const executablePath = normalizedAbsolute(input.executablePath, "ZLS executable");
    const cwd = normalizedAbsolute(input.cwd, "ZLS LSP working directory");
    let child: Deno.ChildProcess;
    try {
      child = new Deno.Command(executablePath, {
        args: [],
        cwd,
        env: { ...input.env },
        clearEnv: true,
        stdin: "piped",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
    } catch (cause) {
      verificationFailure("unable to start the ZLS protocol verifier", { executablePath }, cause);
    }

    let timedOut = false;
    let aborted = false;
    const terminate = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // The bounded child may have exited between status observation and termination.
      }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, this.#timeoutMs);
    const abort = () => {
      aborted = true;
      terminate();
    };
    input.signal?.addEventListener("abort", abort, { once: true });

    const writer = child.stdin.getWriter();
    const reader = new LspFrameReader(child.stdout.getReader(), this.#maxMessageBytes);
    const stderrPromise = consumeBounded(child.stderr, this.#maxStderrBytes);
    try {
      await writeLspMessage(writer, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          processId: null,
          clientInfo: { name: "zig-manager", version: "1" },
          rootUri: null,
          capabilities: {},
          trace: "off",
          workspaceFolders: null,
        },
      });
      const initialize = await readResponse(reader, 1);
      const initializeResult = requiredRecord(initialize.result, "initialize result");
      requiredRecord(initializeResult.capabilities, "initialize result capabilities");

      await writeLspMessage(writer, {
        jsonrpc: "2.0",
        method: "initialized",
        params: {},
      });
      await writeLspMessage(writer, {
        jsonrpc: "2.0",
        id: 2,
        method: "shutdown",
        params: null,
      });
      const shutdown = await readResponse(reader, 2);
      if (shutdown.result !== null) {
        verificationFailure("ZLS returned a non-null shutdown result");
      }
      await writeLspMessage(writer, { jsonrpc: "2.0", method: "exit", params: null });
      await writer.close();
      const [status, stderr] = await Promise.all([
        child.status,
        stderrPromise,
        reader.drain(),
      ]);
      if (aborted || input.signal?.aborted) {
        throw new ZigOperationAbortedError("verify ZLS LSP protocol", {}, {
          cause: input.signal?.reason,
        });
      }
      if (timedOut) {
        verificationFailure("ZLS LSP handshake timed out", { timeoutMs: this.#timeoutMs });
      }
      if (!status.success || status.signal !== null) {
        verificationFailure("ZLS did not exit cleanly after the LSP shutdown handshake", {
          exitCode: status.code,
          signal: status.signal,
          stderr: stderr.text,
        });
      }
      if (stderr.truncated) {
        verificationFailure("ZLS LSP stderr exceeded its verification bound", {
          maximum: this.#maxStderrBytes,
        });
      }
      return { initialized: true, shutdown: true };
    } catch (cause) {
      terminate();
      try {
        await writer.abort(cause);
      } catch {
        // The child can close stdin while protocol validation is rejecting its response.
      }
      try {
        await reader.cancel();
      } catch {
        // Child termination can close stdout before cancellation reaches the reader.
      }
      try {
        await child.status;
      } catch {
        // Preserve the protocol failure rather than process cleanup diagnostics.
      }
      await Promise.allSettled([stderrPromise]);
      if (aborted || input.signal?.aborted) {
        throw new ZigOperationAbortedError("verify ZLS LSP protocol", {}, {
          cause: input.signal?.reason ?? cause,
        });
      }
      if (timedOut) {
        verificationFailure("ZLS LSP handshake timed out", { timeoutMs: this.#timeoutMs });
      }
      if (cause instanceof ZlsVerificationError || cause instanceof ZigOperationAbortedError) {
        throw cause;
      }
      verificationFailure("ZLS LSP handshake failed", { cause: message(cause) }, cause);
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", abort);
    }
    throw new TypeError("unreachable ZLS protocol verifier state");
  }
}

/** The install identity is exactly the validated source-built recipe. */
export async function createBuiltZlsInstallIdentity(input: {
  readonly buildManifest: ZlsBuildManifestV1;
  readonly source: ResolvedZlsSource;
  readonly zig: InstalledObject;
}): Promise<ZlsBuildRecipeV1> {
  return (await prepareIdentity(input)).recipe;
}

/** Reuse an immutable ZLS object without consulting or copying its replaceable build cache. */
export async function reuseInstalledZls(
  input: ReuseInstalledZlsInput,
): Promise<InstalledObject | null> {
  throwIfAborted(input.signal, "reuse immutable ZLS installation");
  const recipe = validateZlsBuildRecipe(input.recipe);
  assertCurrentRecipe(recipe);
  const source = validateResolvedZlsSource(input.source);
  assertSourceAndDependency(recipe, source, input.zig);
  const installationId = await computeInstallationId(recipe);
  let installed: InstalledObject;
  try {
    installed = await input.store.get("zls", installationId);
  } catch (cause) {
    if (cause instanceof InstallStoreError && cause.code === "INSTALL_NOT_FOUND") return null;
    throw cause;
  }
  assertReusableInstall(installed, recipe, source, input.zig.manifest.installationId);
  await verifyInstalledZls({
    executablePath: installed.executablePath,
    installPath: join(installed.root, "install"),
    expectedVersion: source.versionMetadata.versionString,
    expectedSize: installed.manifest.executable.size,
    expectedSha256: installed.manifest.executable.sha256,
    runner: input.runner,
    runtimeDependencyInspector: input.runtimeDependencyInspector,
    ...(input.protocolVerifier === undefined ? {} : { protocolVerifier: input.protocolVerifier }),
    cacheRoot: input.cacheRoot,
    scratchRoot: input.store.stagingRoot,
    platform: input.platform,
    expectedFormat: installed.manifest.executable.format,
    expectedRuntime: installed.manifest.runtime,
    ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
    signal: input.signal,
  });
  return installed;
}

/** Copy one physical ZLS executable and publish it through the immutable InstallStore. */
export async function installBuiltZls(
  input: InstallBuiltZlsInput,
): Promise<InstallBuiltZlsResult> {
  throwIfAborted(input.signal, "install built ZLS");
  const operationId = operationUuid(input.operationId ?? crypto.randomUUID());
  const prepared = await prepareIdentity(input);
  const { buildManifest, source, recipe, installationId } = prepared;

  const existing = await getIfInstalled(input.store, installationId);
  throwIfAborted(input.signal, "reuse built ZLS installation");
  if (existing !== null) {
    assertReusableInstall(
      existing,
      recipe,
      source,
      input.zig.manifest.installationId,
      buildManifest,
    );
    const promotedVerification = await verifyInstalledZls({
      executablePath: existing.executablePath,
      installPath: join(existing.root, "install"),
      expectedVersion: source.versionMetadata.versionString,
      expectedSize: buildManifest.executable.size,
      expectedSha256: buildManifest.executable.sha256,
      runner: input.runner,
      runtimeDependencyInspector: input.runtimeDependencyInspector,
      ...(input.protocolVerifier === undefined ? {} : { protocolVerifier: input.protocolVerifier }),
      cacheRoot: input.cacheRoot,
      scratchRoot: input.store.stagingRoot,
      platform: input.platform,
      expectedFormat: existing.manifest.executable.format,
      expectedRuntime: existing.manifest.runtime,
      operationId,
      signal: input.signal,
    });
    return {
      ...existing,
      installationId,
      reused: true,
      copied: false,
      stagedVerification: null,
      promotedVerification,
    };
  }

  const buildMetadata = await inspectBuildExecutable(buildManifest, input.signal);
  let staging: InstallStaging | undefined;
  let publishedByOperation = false;
  try {
    staging = await input.store.createStaging("zls", installationId, operationId, input.signal);
    const stagedExecutable = join(
      staging.installPath,
      "bin",
      input.platform === "windows" ? "zls.exe" : "zls",
    );
    await ensurePhysicalDirectory(dirname(stagedExecutable));
    await copyPhysicalFile(
      buildManifest.paths.executable,
      stagedExecutable,
      buildMetadata.info,
      input.signal,
    );
    const copiedMetadata = await fileMetadata(stagedExecutable, input.signal);
    if (canonicalJson(copiedMetadata) !== canonicalJson(buildMetadata.metadata)) {
      verificationFailure("copied ZLS fingerprint differs from the build manifest", {
        expected: buildMetadata.metadata,
        actual: copiedMetadata,
      });
    }

    const stagedVerification = await verifyInstalledZls({
      executablePath: stagedExecutable,
      installPath: staging.installPath,
      expectedVersion: source.versionMetadata.versionString,
      expectedSize: buildManifest.executable.size,
      expectedSha256: buildManifest.executable.sha256,
      runner: input.runner,
      runtimeDependencyInspector: input.runtimeDependencyInspector,
      ...(input.protocolVerifier === undefined ? {} : { protocolVerifier: input.protocolVerifier }),
      cacheRoot: input.cacheRoot,
      scratchRoot: input.store.stagingRoot,
      platform: input.platform,
      operationId,
      signal: input.signal,
    });
    const finalRoot = input.store.installationPath("zls", installationId);
    const manifest = createManifest({
      installationId,
      recipe,
      source,
      buildManifest,
      executablePath: `install/bin/${input.platform === "windows" ? "zls.exe" : "zls"}`,
      metadata: copiedMetadata,
      format: relocateElfFormat(stagedVerification.executableFormat, staging.root, finalRoot),
      runtime: relocateRuntime(stagedVerification.runtime, staging.root, finalRoot),
      createdAt: canonicalTimestamp((input.now ?? (() => new Date()))()),
    });
    const published = await input.store.publish(staging, manifest, input.signal);
    publishedByOperation = !published.reused;
    assertReusableInstall(
      published,
      recipe,
      source,
      input.zig.manifest.installationId,
      buildManifest,
    );
    const promotedVerification = await verifyInstalledZls({
      executablePath: published.executablePath,
      installPath: join(published.root, "install"),
      expectedVersion: source.versionMetadata.versionString,
      expectedSize: buildManifest.executable.size,
      expectedSha256: buildManifest.executable.sha256,
      runner: input.runner,
      runtimeDependencyInspector: input.runtimeDependencyInspector,
      ...(input.protocolVerifier === undefined ? {} : { protocolVerifier: input.protocolVerifier }),
      cacheRoot: input.cacheRoot,
      scratchRoot: input.store.stagingRoot,
      platform: input.platform,
      expectedFormat: manifest.executable.format,
      expectedRuntime: manifest.runtime,
      operationId,
      signal: input.signal,
    });
    return {
      ...published,
      installationId,
      copied: true,
      stagedVerification,
      promotedVerification,
    };
  } catch (cause) {
    const cancellation = input.signal?.aborted || cause instanceof ZigOperationAbortedError;
    if (publishedByOperation && staging !== undefined && !cancellation) {
      try {
        await input.store.quarantine(
          "zls",
          installationId,
          staging.operationId,
          "created",
          input.signal,
        );
      } catch (quarantineCause) {
        throw new AggregateError(
          [cause, quarantineCause],
          "Promoted ZLS verification failed and its object could not be quarantined",
        );
      }
    }
    if (staging !== undefined) await cleanupOwnedStaging(input.store, staging, cause);
    if (input.signal?.aborted && !(cause instanceof ZigOperationAbortedError)) {
      throw new ZigOperationAbortedError("install built ZLS", {}, { cause: input.signal.reason });
    }
    throw cause;
  }
}

/** Physical/hash/ELF/runtime/version/protocol verification for staged and final ZLS objects. */
export async function verifyInstalledZls(
  input: VerifyInstalledZlsInput,
): Promise<ZlsInstallVerification> {
  throwIfAborted(input.signal, "verify managed ZLS installation");
  if (input.platform !== "linux") {
    throw new TypeError("source-built ZLS ELF verification currently supports Linux only");
  }
  const operationId = operationUuid(input.operationId ?? crypto.randomUUID());
  const installPath = normalizedAbsolute(input.installPath, "managed ZLS install path");
  const executablePath = normalizedAbsolute(input.executablePath, "managed ZLS executable");
  assertPathContained(installPath, executablePath);
  await assertPathWithoutSymlinks(installPath, executablePath);
  const info = await Deno.lstat(executablePath);
  if (!info.isFile || info.isSymlink) {
    verificationFailure("managed ZLS executable is not a physical regular file", {
      executablePath,
    });
  }
  if (info.mode !== null && (info.mode & 0o111) === 0) {
    verificationFailure("managed ZLS executable is not executable", { executablePath });
  }
  if (resolve(await Deno.realPath(executablePath)) !== executablePath) {
    verificationFailure("managed ZLS executable path is not physical", { executablePath });
  }
  const metadata = await fileMetadata(executablePath, input.signal);
  if (metadata.size !== input.expectedSize || metadata.sha256 !== input.expectedSha256) {
    verificationFailure("managed ZLS executable fingerprint differs from its expected build", {
      expectedSize: input.expectedSize,
      actualSize: metadata.size,
      expectedSha256: input.expectedSha256,
      actualSha256: metadata.sha256,
    });
  }
  let executableFormat: Elf64X86_64Info;
  try {
    executableFormat = await inspectElf64X86_64(executablePath);
  } catch (cause) {
    verificationFailure("managed ZLS executable is not ELF64 little-endian x86_64", {
      executablePath,
      cause: message(cause),
    }, cause);
  }
  if (
    input.expectedFormat !== undefined &&
    canonicalJson(executableFormat) !== canonicalJson(input.expectedFormat)
  ) verificationFailure("managed ZLS ELF metadata differs from its immutable manifest");

  const scratchRoot = normalizedAbsolute(input.scratchRoot, "ZLS verification scratch root");
  await ensurePhysicalDirectory(scratchRoot);
  const operationRoot = join(scratchRoot, operationId);
  assertOperationRoot(scratchRoot, operationRoot, operationId);
  await ensurePhysicalDirectory(operationRoot);
  const scratch = await Deno.makeTempDir({ dir: operationRoot, prefix: "verify-zls-" });
  try {
    const env = await createVerificationEnvironment(scratch, executablePath);
    const versionResult = await input.runner.run({
      executable: executablePath,
      args: ["--version"],
      cwd: scratch,
      clearEnv: true,
      env,
      signal: input.signal,
      maxDiagnosticBytes: MAX_VERSION_OUTPUT_BYTES,
    });
    throwIfAborted(input.signal, "verify managed ZLS version");
    assertBoundedSuccess(versionResult, MAX_VERSION_OUTPUT_BYTES, "'zls --version'");
    const version = versionResult.stdout.trim();
    if (version !== input.expectedVersion) {
      verificationFailure("ZLS version does not match its exact resolved source", {
        expectedVersion: input.expectedVersion,
        actualVersion: version,
      });
    }

    const runtime = await input.runtimeDependencyInspector.inspect({
      executablePath,
      installPath,
      cacheRoot: normalizedAbsolute(input.cacheRoot, "manager cache root"),
      platform: input.platform,
      signal: input.signal,
    });
    if (
      input.expectedRuntime !== undefined &&
      canonicalJson(runtime) !== canonicalJson(input.expectedRuntime)
    ) verificationFailure("ZLS runtime linkage differs from its immutable manifest");
    if ((runtime.linkage === "dynamic") !== executableFormat.dynamicallyLinked) {
      verificationFailure("ZLS runtime linkage contradicts its ELF metadata");
    }

    const protocolVerifier = input.protocolVerifier ?? new DenoZlsLspProtocolVerifier();
    if (protocolVerifier.contractVersion !== ZLS_INSTALL_VERIFIER_CONTRACT_VERSION) {
      throw new TypeError("ZLS protocol verifier contract does not match the install recipe");
    }
    const protocol = await protocolVerifier.verify({
      executablePath,
      cwd: scratch,
      env,
      signal: input.signal,
    });
    if (protocol.initialized !== true || protocol.shutdown !== true) {
      verificationFailure("ZLS protocol verifier returned an invalid result");
    }
    return {
      version,
      executableSize: metadata.size,
      executableSha256: metadata.sha256,
      executableFormat,
      runtime,
      protocol,
    };
  } finally {
    await Deno.remove(scratch, { recursive: true });
    await removeDirectoryIfEmpty(operationRoot);
  }
}

async function prepareIdentity(input: {
  readonly buildManifest: ZlsBuildManifestV1;
  readonly source: ResolvedZlsSource;
  readonly zig: InstalledObject;
}): Promise<PreparedZlsIdentity> {
  const buildManifest = validateZlsBuildManifest(input.buildManifest);
  const recipe = validateZlsBuildRecipe(buildManifest.recipe);
  const source = validateResolvedZlsSource(input.source);
  assertCurrentRecipe(recipe);
  assertSourceAndDependency(recipe, source, input.zig);
  if (buildManifest.command.executable !== input.zig.executablePath) {
    throw new TypeError("ZLS build manifest did not invoke the exact Zig dependency executable");
  }
  if (canonicalJson(buildManifest.source) !== canonicalJson(source)) {
    throw new TypeError("ZLS build manifest source does not match the exact resolved source");
  }
  const installationId = await computeInstallationId(recipe);
  if (installationId !== buildManifest.installationId) {
    throw new TypeError("ZLS build manifest ID is not its canonical recipe hash");
  }
  return { buildManifest, source, recipe, installationId };
}

function assertCurrentRecipe(recipe: ZlsBuildRecipeV1): void {
  if (
    !isZlsBuildRecipe(recipe) || recipe.adapter.id !== ZLS_BUILD_RECIPE_ADAPTER_ID ||
    recipe.adapter.buildContractVersion !== ZLS_BUILD_CONTRACT_VERSION ||
    recipe.adapter.verifierContractVersion !== ZLS_INSTALL_VERIFIER_CONTRACT_VERSION
  ) throw new TypeError("ZLS recipe contract does not match this install pipeline");
}

function assertSourceAndDependency(
  recipe: ZlsBuildRecipeV1,
  source: ResolvedZlsSource,
  zig: InstalledObject,
): void {
  if (canonicalJson(recipe.source.resolved) !== canonicalJson(source)) {
    throw new TypeError("ZLS recipe does not contain the exact resolved source");
  }
  if (zig.manifest.component !== "zig" || recipe.dependencies.length !== 1) {
    throw new TypeError("ZLS recipe must have exactly one Zig installation dependency");
  }
  const dependency = recipe.dependencies[0];
  if (dependency.component !== "zig" || dependency.installationId !== zig.manifest.installationId) {
    throw new TypeError("ZLS recipe names the wrong Zig installation dependency");
  }
  if (
    recipe.zig.executable.installPath !== zig.manifest.paths.executable ||
    recipe.zig.executable.size !== zig.manifest.executable.size ||
    recipe.zig.executable.sha256 !== zig.manifest.executable.sha256
  ) throw new TypeError("ZLS recipe has the wrong Zig executable fingerprint");
}

function createManifest(input: {
  readonly installationId: string;
  readonly recipe: ZlsBuildRecipeV1;
  readonly source: ResolvedZlsSource;
  readonly buildManifest: ZlsBuildManifestV1;
  readonly executablePath: string;
  readonly metadata: { readonly size: number; readonly sha256: string };
  readonly format: Elf64X86_64Info;
  readonly runtime: RuntimeLinkageRecord;
  readonly createdAt: string;
}): InstallManifestV3 {
  return validateInstallManifest({
    schemaVersion: 3,
    installationId: input.installationId,
    component: "zls",
    identity: input.recipe,
    source: input.source,
    paths: { executable: input.executablePath, libraries: [] },
    executable: {
      version: input.source.versionMetadata.versionString,
      hostTarget: input.recipe.host.denoTarget,
      size: input.metadata.size,
      sha256: input.metadata.sha256,
      format: input.format,
    },
    runtime: input.runtime,
    commands: [input.buildManifest.command],
    dependencies: input.recipe.dependencies,
    createdAt: input.createdAt,
    verifierContractVersion: ZLS_INSTALL_VERIFIER_CONTRACT_VERSION,
  });
}

function assertReusableInstall(
  installed: InstalledObject,
  recipe: ZlsBuildRecipeV1,
  source: ResolvedZlsSource,
  zigInstallationId: string,
  buildManifest?: ZlsBuildManifestV1,
): void {
  const manifest = installed.manifest;
  if (
    manifest.component !== "zls" || canonicalJson(manifest.identity) !== canonicalJson(recipe) ||
    canonicalJson(manifest.source) !== canonicalJson(source) ||
    manifest.paths.libraries.length !== 0 ||
    manifest.paths.executable !==
      `install/bin/${Deno.build.os === "windows" ? "zls.exe" : "zls"}` ||
    manifest.executable.version !== source.versionMetadata.versionString ||
    manifest.executable.hostTarget !== recipe.host.denoTarget ||
    manifest.dependencies.length !== 1 ||
    manifest.dependencies[0].component !== "zig" ||
    manifest.dependencies[0].installationId !== zigInstallationId ||
    manifest.verifierContractVersion !== recipe.adapter.verifierContractVersion ||
    buildManifest !== undefined &&
      (manifest.executable.size !== buildManifest.executable.size ||
        manifest.executable.sha256 !== buildManifest.executable.sha256)
  ) verificationFailure("immutable ZLS installation does not match the requested recipe");
}

async function inspectBuildExecutable(
  buildManifest: ZlsBuildManifestV1,
  signal?: AbortSignal,
): Promise<{
  readonly info: Deno.FileInfo;
  readonly metadata: { readonly size: number; readonly sha256: string };
}> {
  throwIfAborted(signal, "inspect built ZLS executable");
  const path = normalizedAbsolute(buildManifest.paths.executable, "built ZLS executable");
  assertPathContained(buildManifest.paths.install, path);
  await assertPathWithoutSymlinks(buildManifest.paths.install, path);
  const info = await Deno.lstat(path);
  if (!info.isFile || info.isSymlink || info.size < 1) {
    verificationFailure("built ZLS executable is not a physical regular file", { path });
  }
  if (resolve(await Deno.realPath(path)) !== path) {
    verificationFailure("built ZLS executable path traverses a symbolic link", { path });
  }
  if (info.mode !== null && (info.mode & 0o111) === 0) {
    verificationFailure("built ZLS executable is not executable", { path });
  }
  const metadata = await fileMetadata(path, signal);
  if (
    metadata.size !== buildManifest.executable.size ||
    metadata.sha256 !== buildManifest.executable.sha256
  ) verificationFailure("built ZLS executable fingerprint differs from its build manifest");
  return { info, metadata };
}

async function copyPhysicalFile(
  source: string,
  destination: string,
  inspected: Deno.FileInfo,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal, "copy built ZLS executable");
  const input = await Deno.open(source, { read: true });
  let output: Deno.FsFile | undefined;
  try {
    const opened = await input.stat();
    if (!opened.isFile || !sameFile(opened, inspected) || opened.size !== inspected.size) {
      verificationFailure("built ZLS executable changed while it was opened", { source });
    }
    const mode = inspected.mode === null ? undefined : inspected.mode & 0o7777;
    output = await Deno.open(destination, { createNew: true, write: true, mode });
    const buffer = new Uint8Array(128 * 1024);
    let copied = 0;
    while (true) {
      throwIfAborted(signal, "copy built ZLS executable");
      const count = await input.read(buffer);
      if (count === null) break;
      await writeAll(output, buffer.subarray(0, count));
      copied += count;
    }
    const finished = await input.stat();
    const pathInfo = await Deno.lstat(source);
    if (
      copied !== opened.size || finished.size !== opened.size || !sameFile(opened, finished) ||
      !pathInfo.isFile || pathInfo.isSymlink || !sameFile(opened, pathInfo)
    ) verificationFailure("built ZLS executable changed while it was copied", { source });
    await output.sync();
    if (mode !== undefined && Deno.build.os !== "windows") await Deno.chmod(destination, mode);
  } finally {
    output?.close();
    input.close();
  }
}

async function getIfInstalled(store: InstallBuiltZlsStore, installationId: string) {
  try {
    return await store.get("zls", installationId);
  } catch (cause) {
    if (cause instanceof InstallStoreError && cause.code === "INSTALL_NOT_FOUND") return null;
    throw cause;
  }
}

function relocateRuntime(
  runtime: RuntimeLinkageRecord,
  stagingRoot: string,
  finalRoot: string,
): RuntimeLinkageRecord {
  if (runtime.linkage === "static") return runtime;
  const relocateRecord = (record: typeof runtime.interpreter) => ({
    ...record,
    path: isPathContained(stagingRoot, record.path)
      ? join(finalRoot, relative(resolve(stagingRoot), record.path))
      : record.path,
  });
  const dependencies = runtime.dependencies.map(relocateRecord).sort((left, right) =>
    compare(left.name, right.name) || compare(left.path, right.path)
  );
  return {
    linkage: "dynamic",
    interpreter: relocateRecord(runtime.interpreter),
    dependencies,
  };
}

function relocateElfFormat(
  format: Elf64X86_64Info,
  stagingRoot: string,
  finalRoot: string,
): Elf64X86_64Info {
  if (format.interpreter === null || !isPathContained(stagingRoot, format.interpreter)) {
    return format;
  }
  return {
    ...format,
    interpreter: join(finalRoot, relative(resolve(stagingRoot), format.interpreter)),
  };
}

async function cleanupOwnedStaging(
  store: InstallBuiltZlsStore,
  staging: InstallStaging,
  operationCause: unknown,
): Promise<void> {
  const expected = resolve(join(store.stagingRoot, staging.operationId));
  if (resolve(staging.root) !== expected || dirname(expected) !== resolve(store.stagingRoot)) {
    throw new AggregateError(
      [operationCause, new Error("refused to clean unowned ZLS install staging")],
      "ZLS install failed and staging ownership could not be established",
    );
  }
  try {
    const info = await Deno.lstat(expected);
    await Deno.remove(expected, { recursive: info.isDirectory && !info.isSymlink });
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound)) {
      throw new AggregateError(
        [operationCause, cause],
        "ZLS install failed and its staging could not be removed",
      );
    }
  }
}

async function assertPathWithoutSymlinks(root: string, candidate: string): Promise<void> {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = assertPathContained(normalizedRoot, candidate);
  const rel = relative(normalizedRoot, normalizedCandidate);
  let current = normalizedRoot;
  for (const segment of ["", ...(rel === "" ? [] : rel.split(/[\\/]/))]) {
    if (segment !== "") current = join(current, segment);
    const info = await Deno.lstat(current);
    if (info.isSymlink) {
      verificationFailure("managed ZLS path contains a symlink", { path: current });
    }
  }
}

async function createVerificationEnvironment(
  scratch: string,
  executablePath: string,
): Promise<Readonly<Record<string, string>>> {
  await Promise.all([
    Deno.mkdir(join(scratch, "home")),
    Deno.mkdir(join(scratch, "tmp")),
    Deno.mkdir(join(scratch, "cache", "xdg"), { recursive: true }),
    Deno.mkdir(join(scratch, "cache", "zig-global"), { recursive: true }),
    Deno.mkdir(join(scratch, "cache", "zig-local"), { recursive: true }),
  ]);
  return {
    CFLAGS: "",
    CXXFLAGS: "",
    CPPFLAGS: "",
    LDFLAGS: "",
    CPATH: "",
    C_INCLUDE_PATH: "",
    CPLUS_INCLUDE_PATH: "",
    LIBRARY_PATH: "",
    CMAKE_PREFIX_PATH: "",
    PKG_CONFIG_PATH: "",
    LANG: "C",
    LC_ALL: "C",
    PATH: dirname(executablePath),
    HOME: join(scratch, "home"),
    TMPDIR: join(scratch, "tmp"),
    XDG_CACHE_HOME: join(scratch, "cache", "xdg"),
    ZIG_GLOBAL_CACHE_DIR: join(scratch, "cache", "zig-global"),
    ZIG_LOCAL_CACHE_DIR: join(scratch, "cache", "zig-local"),
  };
}

interface JsonRpcResponse extends Record<string, unknown> {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly result: unknown;
}

class LspFrameReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #maximum: number;
  #buffer = new Uint8Array();

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>, maximum: number) {
    this.#reader = reader;
    this.#maximum = maximum;
  }

  async read(): Promise<Record<string, unknown>> {
    const headerEnd = await this.#readUntilHeader();
    const header = new TextDecoder("ascii", { fatal: true }).decode(
      this.#buffer.subarray(0, headerEnd),
    );
    let contentLength: number | null = null;
    for (const line of header.split("\r\n")) {
      const separator = line.indexOf(":");
      if (separator < 1) verificationFailure("ZLS emitted a malformed LSP header");
      const name = line.slice(0, separator).trim().toLowerCase();
      const value = line.slice(separator + 1).trim();
      if (name === "content-length") {
        if (contentLength !== null || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
          verificationFailure("ZLS emitted an invalid LSP Content-Length header");
        }
        contentLength = Number(value);
      } else if (name !== "content-type") {
        verificationFailure("ZLS emitted an unsupported LSP header", { name });
      }
    }
    if (
      contentLength === null || !Number.isSafeInteger(contentLength) || contentLength < 1 ||
      contentLength > this.#maximum
    ) verificationFailure("ZLS LSP message length is missing or out of bounds");
    this.#buffer = this.#buffer.slice(headerEnd + 4);
    await this.#fill(contentLength);
    const body = this.#buffer.slice(0, contentLength);
    this.#buffer = this.#buffer.slice(contentLength);
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch (cause) {
      verificationFailure("ZLS emitted invalid JSON-RPC JSON", { cause: message(cause) }, cause);
    }
    return requiredRecord(value, "ZLS JSON-RPC message");
  }

  async cancel(): Promise<void> {
    await this.#reader.cancel();
  }

  async drain(): Promise<void> {
    let size = this.#buffer.length;
    this.#buffer = new Uint8Array();
    while (true) {
      const { value, done } = await this.#reader.read();
      if (done) return;
      size += value.length;
      if (size > this.#maximum) {
        verificationFailure("ZLS emitted excessive output after the LSP shutdown response");
      }
    }
  }

  async #readUntilHeader(): Promise<number> {
    while (true) {
      const index = indexOfSequence(this.#buffer, [13, 10, 13, 10]);
      if (index >= 0) return index;
      if (this.#buffer.length > 8192) verificationFailure("ZLS LSP header exceeded its bound");
      await this.#readChunk();
    }
  }

  async #fill(length: number): Promise<void> {
    while (this.#buffer.length < length) await this.#readChunk();
  }

  async #readChunk(): Promise<void> {
    const { value, done } = await this.#reader.read();
    if (done) verificationFailure("ZLS closed stdout during the LSP handshake");
    if (this.#buffer.length + value.length > this.#maximum + 8196) {
      verificationFailure("ZLS LSP output exceeded its bound");
    }
    const combined = new Uint8Array(this.#buffer.length + value.length);
    combined.set(this.#buffer);
    combined.set(value, this.#buffer.length);
    this.#buffer = combined;
  }
}

async function readResponse(reader: LspFrameReader, id: number): Promise<JsonRpcResponse> {
  for (let index = 0; index < MAX_LSP_MESSAGES; index++) {
    const messageValue = await reader.read();
    if (messageValue.jsonrpc !== "2.0") {
      verificationFailure("ZLS emitted a message with the wrong JSON-RPC version");
    }
    if (!("id" in messageValue)) continue;
    if (messageValue.id !== id) {
      verificationFailure("ZLS emitted an unexpected JSON-RPC response or request", {
        expectedId: id,
        actualId: messageValue.id,
      });
    }
    if ("error" in messageValue) {
      verificationFailure("ZLS rejected an LSP lifecycle request", { error: messageValue.error });
    }
    if (!("result" in messageValue)) {
      verificationFailure("ZLS JSON-RPC response omitted its result");
    }
    return messageValue as JsonRpcResponse;
  }
  verificationFailure("ZLS emitted too many messages before its lifecycle response");
}

async function writeLspMessage(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  value: unknown,
): Promise<void> {
  const body = new TextEncoder().encode(JSON.stringify(value));
  const header = new TextEncoder().encode(`Content-Length: ${body.length}\r\n\r\n`);
  const message = new Uint8Array(header.length + body.length);
  message.set(header);
  message.set(body, header.length);
  await writer.write(message);
}

async function consumeBounded(
  stream: ReadableStream<Uint8Array>,
  maximum: number,
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (size < maximum) {
        const kept = value.slice(0, maximum - size);
        chunks.push(kept);
        size += kept.length;
        if (kept.length !== value.length) truncated = true;
      } else truncated = true;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}

function indexOfSequence(bytes: Uint8Array, sequence: readonly number[]): number {
  outer:
  for (let index = 0; index <= bytes.length - sequence.length; index++) {
    for (let offset = 0; offset < sequence.length; offset++) {
      if (bytes[index + offset] !== sequence[offset]) continue outer;
    }
    return index;
  }
  return -1;
}

function assertBoundedSuccess(result: ProcessResult, maximum: number, operation: string): void {
  if (
    !result.success || result.signal !== null || result.stdoutTruncated || result.stderrTruncated ||
    byteLength(result.stdout) > maximum || byteLength(result.stderr) > maximum
  ) {
    verificationFailure(`${operation} failed or exceeded its output bound`, {
      exitCode: result.code,
      signal: result.signal,
      stderr: result.stderr,
      maximum,
    });
  }
}

async function ensurePhysicalDirectory(path: string): Promise<void> {
  await Deno.mkdir(path, { recursive: true });
  const info = await Deno.lstat(path);
  if (!info.isDirectory || info.isSymlink || resolve(await Deno.realPath(path)) !== path) {
    verificationFailure("ZLS verification directory is not physical", { path });
  }
}

function assertOperationRoot(root: string, candidate: string, operationId: string): void {
  const expected = join(resolve(root), operationUuid(operationId));
  if (resolve(candidate) !== expected || dirname(expected) !== resolve(root)) {
    throw new TypeError("ZLS verification staging is not owned by the exact operation");
  }
}

function canonicalTimestamp(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("ZLS install clock must return a valid Date");
  }
  return value.toISOString();
}

function normalizedAbsolute(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new TypeError(`${label} must be an absolute normalized path`);
  }
  return path;
}

function requiredRecord(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    verificationFailure(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function boundedPositiveInteger(value: number, path: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${path} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
}

function operationUuid(value: unknown): string {
  if (typeof value !== "string" || !OPERATION_ID.test(value)) {
    throw new TypeError("operationId must be a canonical UUID");
  }
  return value;
}

function sameFile(left: Deno.FileInfo, right: Deno.FileInfo): boolean {
  if (left.dev === null || left.ino === null || right.dev === null || right.ino === null) {
    return true;
  }
  return left.dev === right.dev && left.ino === right.ino;
}

async function writeAll(file: Deno.FsFile, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) offset += await file.write(bytes.subarray(offset));
}

async function removeDirectoryIfEmpty(path: string): Promise<void> {
  try {
    for await (const _entry of Deno.readDir(path)) return;
    await Deno.remove(path);
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound)) {
      // Verification cleanup must not obscure the verification result.
    }
  }
}

function verificationFailure(
  reason: string,
  details: Readonly<Record<string, unknown>> = {},
  cause?: unknown,
): never {
  throw new ZlsVerificationError(reason, details, cause === undefined ? undefined : { cause });
}

function throwIfAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted) {
    throw new ZigOperationAbortedError(operation, {}, { cause: signal.reason });
  }
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
