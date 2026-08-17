import { dirname, isAbsolute, join, relative, resolve } from "@std/path";
import {
  isAbsolute as windowsIsAbsolute,
  relative as windowsRelative,
  resolve as windowsResolve,
} from "@std/path/windows";
import { parseZigEnvLibDir, verifyBuildManifest } from "./build.ts";
import {
  validateZigBuildRecipe,
  ZIG_DOCS_BUILD_CONTRACT_VERSION,
  ZIG_INSTALL_VERIFIER_CONTRACT_VERSION,
} from "./build_recipe.ts";
import { type Elf64X86_64Info, inspectElf64X86_64 } from "./elf.ts";
import { ZigBinaryVerificationError, ZigOperationAbortedError } from "./errors.ts";
import { assertPathContained, canonicalJson, fileMetadata, isPathContained } from "./filesystem.ts";
import {
  computeInstallationId,
  type InstalledObject,
  type InstallIdentityV1,
  type InstallManifestV3,
  type InstallPublishResult,
  type InstallStaging,
  InstallStore,
  InstallStoreError,
  type ResolvedSource,
  type RuntimeDependencyInspector,
  type RuntimeLinkageRecord,
  validateInstallIdentity,
  validateInstallManifest,
  validateResolvedSource,
} from "./install_store.ts";
import { validateBuildManifest } from "./manifest.ts";
import { type ToolchainHostIdentity, validateHostIdentity } from "./profile_store.ts";
import type { ReleaseAdapter } from "./release_adapter.ts";
import type { BuildManifest, ProcessRunner } from "./types.ts";
import { verifyManagedSourceSnapshot } from "./source_snapshot.ts";

export const BUILD_MANIFEST_INSTALL_CONTRACT = "zig-build-manifest-v2/install-manifest-v3-v1";

const MAX_VERSION_OUTPUT_BYTES = 16 * 1024;
const MAX_ENV_OUTPUT_BYTES = 1024 * 1024;
const MAX_COMPILE_OUTPUT_BYTES = 1024 * 1024;
const MAX_RUN_OUTPUT_BYTES = 64 * 1024;
const VERIFY_MESSAGE = "zig-manager verification passed\n";
const OPERATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type InstallPipelinePlatform = "linux" | "darwin" | "windows";

export interface BuiltZigInstallIdentityInput {
  readonly buildManifest: BuildManifest;
  readonly source: ResolvedSource;
  readonly adapter: Pick<
    ReleaseAdapter,
    "id" | "buildContractVersion" | "verifierContractVersion"
  >;
  readonly host: ToolchainHostIdentity;
  readonly expectedHostTarget: string;
}

export interface InstallBuiltZigInput extends BuiltZigInstallIdentityInput {
  readonly adapter: ReleaseAdapter;
  readonly store: InstallBuiltZigStore;
  readonly runner: ProcessRunner;
  readonly platform: InstallPipelinePlatform;
  readonly runtimeDependencyInspector: RuntimeDependencyInspector;
  readonly cacheRoot: string;
  readonly operationId?: string;
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

export interface InstallBuiltZigStore {
  readonly dataRoot: string;
  readonly stagingRoot: string;
  installationPath(component: "zig", installationId: string): string;
  get(component: "zig", installationId: string): ReturnType<InstallStore["get"]>;
  createStaging(
    component: "zig",
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
    component: "zig",
    installationId: string,
    operationId: string,
    authorization: "corrupt" | "created",
    signal?: AbortSignal,
  ): ReturnType<InstallStore["quarantine"]>;
}

export interface ZigInstallVerification {
  readonly version: string;
  readonly libDir: string;
  readonly reportedHostTarget: string;
  readonly normalizedHostTarget: string;
  readonly executableFormat: Elf64X86_64Info;
  readonly compiledProgramFormat: Elf64X86_64Info;
  readonly compilesAndRuns: true;
  readonly runtime: RuntimeLinkageRecord;
}

export interface InstallBuiltZigResult extends InstallPublishResult {
  readonly installationId: string;
  /** False only when an existing immutable object was reused before staging. */
  readonly copied: boolean;
  readonly stagedVerification: ZigInstallVerification | null;
  readonly promotedVerification: ZigInstallVerification;
}

export interface ReuseInstalledZigInput {
  readonly recipe: InstallIdentityV1;
  readonly source: ResolvedSource;
  readonly store: Pick<InstallStore, "get" | "stagingRoot">;
  readonly runner: ProcessRunner;
  readonly runtimeDependencyInspector: RuntimeDependencyInspector;
  readonly cacheRoot: string;
  readonly platform: InstallPipelinePlatform;
  readonly operationId?: string;
  readonly signal?: AbortSignal;
}

interface PreparedIdentity {
  readonly buildManifest: BuildManifest;
  readonly source: ResolvedSource;
  readonly host: ToolchainHostIdentity;
  readonly identity: InstallIdentityV1;
}

/**
 * Construct the path-independent identity used for a BuildManifest-backed Zig install.
 * Build output paths, command paths, resolution time, and creation time are deliberately absent.
 */
export async function createBuiltZigInstallIdentity(
  input: BuiltZigInstallIdentityInput,
): Promise<InstallIdentityV1> {
  return (await prepareIdentity(input)).identity;
}

/** Convert a native build artifact path to the strict install/... manifest representation. */
export function canonicalInstallArtifactPath(
  installRoot: string,
  artifactPath: string,
  platform: InstallPipelinePlatform = currentInstallPipelinePlatform(),
): string {
  const pathApi = platform === "windows"
    ? {
      isAbsolute: windowsIsAbsolute,
      relative: windowsRelative,
      resolve: windowsResolve,
      separator: /[\\/]/,
    }
    : { isAbsolute, relative, resolve, separator: /\// };
  if (!pathApi.isAbsolute(installRoot) || !pathApi.isAbsolute(artifactPath)) {
    throw new TypeError("build install and artifact paths must be absolute");
  }
  const normalizedRoot = pathApi.resolve(installRoot);
  const normalizedArtifact = pathApi.resolve(artifactPath);
  if (normalizedRoot !== installRoot || normalizedArtifact !== artifactPath) {
    throw new TypeError("build install and artifact paths must be normalized");
  }
  const rel = pathApi.relative(normalizedRoot, normalizedArtifact);
  if (rel === "" || pathApi.isAbsolute(rel)) {
    throw new TypeError("build artifact must be strictly below the install directory");
  }
  const segments = rel.split(pathApi.separator);
  if (
    segments.some((segment) =>
      segment === "" || segment === "." || segment === ".." || segment.includes("\\") ||
      hasControlCharacter(segment)
    )
  ) {
    throw new TypeError("build artifact path escapes or cannot be represented canonically");
  }
  return ["install", ...segments].join("/");
}

/** Parse the optional target string from both legacy JSON and Zig 0.16 ZON env output. */
export function parseZigEnvTarget(output: string): string | null {
  try {
    const value: unknown = JSON.parse(output);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const target = (value as Record<string, unknown>).target;
      return typeof target === "string" && target.length > 0 ? target : null;
    }
  } catch {
    // Zig 0.16 intentionally emits ZON rather than JSON.
  }

  const matches = [
    ...output.matchAll(/(?:^|\n)\s*\.target\s*=\s*"((?:\\.|[^"\\])*)"\s*,?/g),
  ];
  if (matches.length === 0) return null;
  if (matches.length !== 1) {
    throw new ZigBinaryVerificationError("'zig env' reported more than one target");
  }
  try {
    const target = decodeZigString(matches[0][1]);
    return target.length > 0 ? target : null;
  } catch (cause) {
    throw new ZigBinaryVerificationError("'zig env' reported an invalid ZON target", {
      cause: message(cause),
    });
  }
}

/** Fully revalidate an exact final installation using only its recipe and immutable data object. */
export async function reuseInstalledZig(
  input: ReuseInstalledZigInput,
): Promise<InstalledObject | null> {
  throwIfAborted(input.signal, "reuse immutable Zig installation");
  const operationId = operationUuid(input.operationId ?? crypto.randomUUID());
  const recipe = validateInstallIdentity(input.recipe);
  const source = validateResolvedSource(input.source);
  const installationId = await computeInstallationId(recipe);
  let installed: InstalledObject;
  try {
    installed = await input.store.get("zig", installationId);
  } catch (cause) {
    if (cause instanceof InstallStoreError && cause.code === "INSTALL_NOT_FOUND") return null;
    throw cause;
  }
  throwIfAborted(input.signal, "reuse immutable Zig installation");
  if (
    canonicalJson(installed.manifest.identity) !== canonicalJson(recipe) ||
    source.component !== "zig" || installed.manifest.source.component !== "zig" ||
    canonicalJson(installed.manifest.source.repository) !== canonicalJson(source.repository) ||
    installed.manifest.source.commit !== source.commit ||
    installed.manifest.source.version !== source.version ||
    canonicalJson(installed.manifest.source.versionMetadata) !==
      canonicalJson(source.versionMetadata)
  ) {
    verificationFailure("immutable installation does not match the canonical recipe source", {
      installationId,
    });
  }
  const library = installed.manifest.paths.libraries[0];
  if (library === undefined || installed.manifest.paths.libraries.length !== 1) {
    verificationFailure("Zig install manifest must contain exactly one managed library path", {
      installationId,
    });
  }
  await verifyInstalledZig({
    executablePath: installed.executablePath,
    installPath: join(installed.root, "install"),
    expectedLibPath: artifactPath(installed.root, library),
    expectedVersion: source.version,
    expectedHost: recipe.host,
    runner: input.runner,
    runtimeDependencyInspector: input.runtimeDependencyInspector,
    cacheRoot: input.cacheRoot,
    scratchRoot: input.store.stagingRoot,
    platform: input.platform,
    expectedRuntime: installed.manifest.runtime,
    operationId,
    signal: input.signal,
  });
  if (recipe.adapter.buildContractVersion >= ZIG_DOCS_BUILD_CONTRACT_VERSION) {
    await verifyManagedSourceSnapshot(
      join(installed.root, "install"),
      source.version,
      source.commit,
      input.signal,
    );
  }
  throwIfAborted(input.signal, "reuse immutable Zig installation");
  return installed;
}

/** Run bounded, relocation-sensitive checks against a staged or promoted Zig executable. */
export async function verifyInstalledZig(input: {
  readonly executablePath: string;
  readonly installPath: string;
  readonly expectedLibPath: string;
  readonly expectedVersion: string;
  readonly expectedHost: ToolchainHostIdentity;
  readonly runner: ProcessRunner;
  readonly runtimeDependencyInspector: RuntimeDependencyInspector;
  readonly cacheRoot: string;
  readonly scratchRoot: string;
  readonly platform: InstallPipelinePlatform;
  readonly expectedRuntime?: RuntimeLinkageRecord;
  readonly operationId?: string;
  readonly signal?: AbortSignal;
}): Promise<ZigInstallVerification> {
  throwIfAborted(input.signal, "verify managed Zig installation");
  const operationId = operationUuid(input.operationId ?? crypto.randomUUID());
  const installPath = normalizedAbsolute(input.installPath, "managed install path");
  const executablePath = normalizedAbsolute(input.executablePath, "managed Zig executable");
  const expectedLibPath = normalizedAbsolute(input.expectedLibPath, "managed Zig lib directory");
  assertPathContained(installPath, executablePath);
  assertPathContained(installPath, expectedLibPath);
  await assertPathChainWithoutSymlinks(installPath, executablePath, "executable");
  const executableStat = await lstat(executablePath, "inspect managed Zig executable");
  if (!executableStat.isFile || executableStat.isSymlink) {
    verificationFailure("managed Zig executable is not a regular file", { executablePath });
  }
  if (
    Deno.build.os !== "windows" && executableStat.mode !== null &&
    (executableStat.mode & 0o111) === 0
  ) {
    verificationFailure("managed Zig executable is not executable", { executablePath });
  }
  let executableFormat: Elf64X86_64Info;
  try {
    executableFormat = await inspectElf64X86_64(executablePath);
  } catch (cause) {
    verificationFailure("managed Zig executable is not ELF64 little-endian x86_64", {
      executablePath,
      cause: message(cause),
    });
  }
  throwIfAborted(input.signal, "verify managed Zig installation");

  const scratchRoot = normalizedAbsolute(input.scratchRoot, "verification scratch root");
  await ensurePhysicalDirectory(scratchRoot);
  throwIfAborted(input.signal, "create Zig verification staging");
  const operationRoot = join(scratchRoot, operationId);
  assertExactOperationRoot(scratchRoot, operationRoot, operationId);
  await ensurePhysicalDirectory(operationRoot);
  const scratch = await Deno.makeTempDir({ dir: operationRoot, prefix: "verify-" });
  try {
    const environment = await createVerificationEnvironment(scratch, executablePath);
    throwIfAborted(input.signal, "verify managed Zig installation");

    const versionResult = await input.runner.run({
      executable: executablePath,
      args: ["version"],
      clearEnv: true,
      env: environment,
      signal: input.signal,
      maxDiagnosticBytes: MAX_VERSION_OUTPUT_BYTES,
    });
    throwIfAborted(input.signal, "verify managed Zig installation");
    assertSuccessfulResult(versionResult, "'zig version'", executablePath);
    assertBoundedResult(versionResult, MAX_VERSION_OUTPUT_BYTES, "zig version");
    const version = versionResult.stdout.trim();
    if (version !== input.expectedVersion) {
      verificationFailure("compiler version does not match the resolved source", {
        expectedVersion: input.expectedVersion,
        actualVersion: version,
      });
    }

    const envResult = await input.runner.run({
      executable: executablePath,
      args: ["env"],
      cwd: installPath,
      clearEnv: true,
      env: environment,
      signal: input.signal,
      maxDiagnosticBytes: MAX_ENV_OUTPUT_BYTES,
    });
    throwIfAborted(input.signal, "verify managed Zig installation");
    assertSuccessfulResult(envResult, "'zig env'", executablePath);
    assertBoundedResult(envResult, MAX_ENV_OUTPUT_BYTES, "zig env");
    const reportedLib = parseZigEnvLibDir(envResult.stdout);
    const libDir = resolve(installPath, reportedLib);
    assertPathContained(installPath, libDir);
    if (libDir !== expectedLibPath) {
      verificationFailure("compiler lib_dir does not match the managed library path", {
        expectedLibPath,
        actualLibPath: libDir,
      });
    }
    await assertPathChainWithoutSymlinks(installPath, libDir, "lib directory");
    const libStat = await lstat(libDir, "inspect managed Zig lib directory");
    if (!libStat.isDirectory || libStat.isSymlink) {
      verificationFailure("managed Zig lib directory is missing", { libDir });
    }
    const stdPath = join(libDir, "std", "std.zig");
    await assertPathChainWithoutSymlinks(installPath, stdPath, "standard library");
    const stdStat = await lstat(stdPath, "inspect managed Zig standard library");
    if (!stdStat.isFile || stdStat.isSymlink) {
      verificationFailure("managed Zig lib/std/std.zig is missing", { stdPath });
    }

    const reportedHostTarget = parseZigEnvTarget(envResult.stdout);
    if (reportedHostTarget === null) verificationFailure("'zig env' did not report a host target");
    const normalizedHostTarget = normalizeHostTarget(reportedHostTarget);
    const expectedTarget = normalizeExpectedHost(input.expectedHost);
    if (normalizedHostTarget !== expectedTarget) {
      verificationFailure("compiler-reported target does not match the required host", {
        reportedHostTarget,
        normalizedHostTarget,
        expectedTarget,
      });
    }

    const sourcePath = join(scratch, "verify.zig");
    const outputPath = join(scratch, "verify-host");
    await Deno.writeTextFile(
      sourcePath,
      `const std = @import("std");\npub fn main() void {\n    std.debug.print("${
        VERIFY_MESSAGE.replace("\n", "\\n")
      }", .{});\n}\n`,
      { createNew: true },
    );
    throwIfAborted(input.signal, "verify managed Zig installation");
    const compileResult = await input.runner.run({
      executable: executablePath,
      args: [
        "build-exe",
        sourcePath,
        `-femit-bin=${outputPath}`,
        "-OReleaseSafe",
        "--cache-dir",
        join(scratch, "cache", "local"),
        "--global-cache-dir",
        join(scratch, "cache", "global"),
      ],
      cwd: scratch,
      clearEnv: true,
      env: environment,
      signal: input.signal,
      maxDiagnosticBytes: MAX_COMPILE_OUTPUT_BYTES,
    });
    throwIfAborted(input.signal, "verify managed Zig installation");
    assertSuccessfulResult(compileResult, "minimal host compilation", executablePath);
    assertBoundedResult(compileResult, MAX_COMPILE_OUTPUT_BYTES, "minimal host compilation");
    let compiledProgramFormat: Elf64X86_64Info;
    try {
      compiledProgramFormat = await inspectElf64X86_64(outputPath);
    } catch (cause) {
      verificationFailure("compiled host smoke-test program has the wrong ELF architecture", {
        outputPath,
        cause: message(cause),
      });
    }
    const runResult = await input.runner.run({
      executable: outputPath,
      args: [],
      cwd: scratch,
      clearEnv: true,
      env: environment,
      signal: input.signal,
      maxDiagnosticBytes: MAX_RUN_OUTPUT_BYTES,
    });
    throwIfAborted(input.signal, "verify managed Zig installation");
    assertSuccessfulResult(runResult, "compiled host smoke-test execution", outputPath);
    assertBoundedResult(runResult, MAX_RUN_OUTPUT_BYTES, "compiled host smoke-test execution");

    const runtime = await input.runtimeDependencyInspector.inspect({
      executablePath,
      installPath,
      cacheRoot: normalizedAbsolute(input.cacheRoot, "manager cache root"),
      platform: input.platform,
      signal: input.signal,
    });
    throwIfAborted(input.signal, "verify managed Zig installation");
    if (
      input.expectedRuntime !== undefined &&
      canonicalJson(runtime) !== canonicalJson(input.expectedRuntime)
    ) {
      verificationFailure("runtime dependency fingerprints differ from the immutable manifest", {
        expected: input.expectedRuntime,
        actual: runtime,
      });
    }

    return {
      version,
      libDir,
      reportedHostTarget,
      normalizedHostTarget,
      executableFormat,
      compiledProgramFormat,
      compilesAndRuns: true,
      runtime,
    };
  } finally {
    await Deno.remove(scratch, { recursive: true });
    await removeDirectoryIfEmpty(operationRoot);
  }
}

/** Copy and publish an existing verified BuildManifest output as an immutable Zig installation. */
export async function installBuiltZig(
  input: InstallBuiltZigInput,
): Promise<InstallBuiltZigResult> {
  throwIfAborted(input.signal, "install built Zig");
  const operationId = operationUuid(input.operationId ?? crypto.randomUUID());
  const prepared = await prepareIdentity(input);
  const { buildManifest, source, host, identity } = prepared;
  if (host.os !== input.platform) {
    throw new TypeError("host.os must match the install pipeline platform");
  }
  if (!input.adapter.supports(buildManifest.source.version)) {
    throw new TypeError(`release adapter '${input.adapter.id}' does not support this Zig source`);
  }

  const executableRelative = canonicalInstallArtifactPath(
    buildManifest.paths.install,
    buildManifest.paths.executable,
    input.platform,
  );
  const libraryRelative = canonicalInstallArtifactPath(
    buildManifest.paths.install,
    buildManifest.paths.lib,
    input.platform,
  );
  const installationId = await computeInstallationId(identity);
  const expectedPaths = { executable: executableRelative, library: libraryRelative };

  const existing = await getIfInstalled(input.store, installationId);
  throwIfAborted(input.signal, "install built Zig");
  if (existing !== null) {
    assertReusableInstall(existing, identity, source, input.expectedHostTarget, expectedPaths);
    const promotedVerification = await verifyInstalledZig({
      executablePath: existing.executablePath,
      installPath: join(existing.root, "install"),
      expectedLibPath: artifactPath(existing.root, libraryRelative),
      expectedVersion: source.version,
      expectedHost: host,
      runner: input.runner,
      runtimeDependencyInspector: input.runtimeDependencyInspector,
      cacheRoot: input.cacheRoot,
      scratchRoot: input.store.stagingRoot,
      platform: input.platform,
      expectedRuntime: existing.manifest.runtime,
      operationId,
      signal: input.signal,
    });
    if (buildManifest.recipe.adapter.buildContractVersion >= ZIG_DOCS_BUILD_CONTRACT_VERSION) {
      await verifyManagedSourceSnapshot(
        join(existing.root, "install"),
        source.version,
        source.commit,
        input.signal,
      );
    }
    return {
      ...existing,
      installationId,
      reused: true,
      copied: false,
      stagedVerification: null,
      promotedVerification,
    };
  }

  await assertSecureBuildInstallTree(buildManifest, input.signal);
  throwIfAborted(input.signal, "install built Zig");
  await verifyBuildManifest(
    buildManifest,
    input.runner,
    input.adapter,
    input.platform,
    buildManifest.identity,
    input.signal,
  );

  let staging: InstallStaging | undefined;
  let publishedByOperation = false;
  try {
    staging = await input.store.createStaging("zig", installationId, operationId, input.signal);
    await copyRegularTree(buildManifest.paths.install, staging.installPath, input.signal);
    throwIfAborted(input.signal, "copy built Zig into install staging");

    const stagedExecutable = artifactPath(staging.root, executableRelative);
    const stagedLib = artifactPath(staging.root, libraryRelative);
    const metadata = await fileMetadata(stagedExecutable, input.signal);
    if (
      metadata.size !== buildManifest.compiler.size ||
      metadata.sha256 !== buildManifest.compiler.sha256
    ) {
      verificationFailure("copied compiler metadata differs from the build manifest", {
        executablePath: stagedExecutable,
        expectedSize: buildManifest.compiler.size,
        actualSize: metadata.size,
        expectedSha256: buildManifest.compiler.sha256,
        actualSha256: metadata.sha256,
      });
    }
    const stagedVerification = await verifyInstalledZig({
      executablePath: stagedExecutable,
      installPath: staging.installPath,
      expectedLibPath: stagedLib,
      expectedVersion: source.version,
      expectedHost: host,
      runner: input.runner,
      runtimeDependencyInspector: input.runtimeDependencyInspector,
      cacheRoot: input.cacheRoot,
      scratchRoot: input.store.stagingRoot,
      platform: input.platform,
      operationId,
      signal: input.signal,
    });
    if (buildManifest.recipe.adapter.buildContractVersion >= ZIG_DOCS_BUILD_CONTRACT_VERSION) {
      await verifyManagedSourceSnapshot(
        staging.installPath,
        source.version,
        source.commit,
        input.signal,
      );
    }

    const finalRoot = input.store.installationPath("zig", installationId);
    const runtime = relocateRuntimeLinkage(
      stagedVerification.runtime,
      staging.root,
      finalRoot,
    );
    const manifest = createStrictManifest({
      installationId,
      identity,
      source,
      buildManifest,
      expectedHostTarget: input.expectedHostTarget,
      executableRelative,
      libraryRelative,
      metadata,
      format: relocateElfFormat(stagedVerification.executableFormat, staging.root, finalRoot),
      runtime,
      createdAt: (input.now ?? (() => new Date()))().toISOString(),
    });
    throwIfAborted(input.signal, "promote immutable Zig installation");
    const published = await input.store.publish(staging, manifest, input.signal);
    publishedByOperation = !published.reused;
    throwIfAborted(input.signal, "verify promoted Zig installation");
    assertReusableInstall(published, identity, source, input.expectedHostTarget, expectedPaths);
    const promotedVerification = await verifyInstalledZig({
      executablePath: published.executablePath,
      installPath: join(published.root, "install"),
      expectedLibPath: artifactPath(published.root, libraryRelative),
      expectedVersion: source.version,
      expectedHost: host,
      runner: input.runner,
      runtimeDependencyInspector: input.runtimeDependencyInspector,
      cacheRoot: input.cacheRoot,
      scratchRoot: input.store.stagingRoot,
      platform: input.platform,
      expectedRuntime: manifest.runtime,
      operationId,
      signal: input.signal,
    });
    if (buildManifest.recipe.adapter.buildContractVersion >= ZIG_DOCS_BUILD_CONTRACT_VERSION) {
      await verifyManagedSourceSnapshot(
        join(published.root, "install"),
        source.version,
        source.commit,
        input.signal,
      );
    }
    if (stagedVerification.normalizedHostTarget !== promotedVerification.normalizedHostTarget) {
      verificationFailure("compiler-reported target changed after installation promotion", {
        stagedTarget: stagedVerification.reportedHostTarget,
        promotedTarget: promotedVerification.reportedHostTarget,
      });
    }
    throwIfAborted(input.signal, "complete built Zig installation");
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
          "zig",
          installationId,
          staging.operationId,
          "created",
          input.signal,
        );
      } catch (quarantineCause) {
        throw new AggregateError(
          [cause, quarantineCause],
          "Promoted Zig verification failed and the created object could not be quarantined",
        );
      }
    }
    if (staging !== undefined) await cleanupOwnedStaging(input.store, staging, cause);
    if (input.signal?.aborted && !(cause instanceof ZigOperationAbortedError)) {
      throw new ZigOperationAbortedError("install built Zig", {}, {
        cause: input.signal.reason,
      });
    }
    throw cause;
  }
}

async function prepareIdentity(input: BuiltZigInstallIdentityInput): Promise<PreparedIdentity> {
  const buildManifest = validateBuildManifest(input.buildManifest);
  const source = validateResolvedSource(input.source);
  const host = validateHostIdentity(input.host);
  const adapterId = requiredText(input.adapter.id, "adapter.id");
  const expectedHostTarget = requiredText(input.expectedHostTarget, "expectedHostTarget");
  const identity = validateZigBuildRecipe(buildManifest.recipe, "buildManifest.recipe");
  if (identity.component !== "zig" || source.component !== "zig") {
    throw new TypeError("built Zig identity and resolved source must use component 'zig'");
  }
  if (source.commit !== buildManifest.source.commit) {
    throw new TypeError("resolved source commit must match the build manifest source commit");
  }
  if (source.version !== buildManifest.source.version.text) {
    throw new TypeError("resolved source version must match the build manifest source version");
  }
  if (canonicalJson(source.versionMetadata) !== canonicalJson(buildManifest.source.version)) {
    throw new TypeError("resolved structured source version must match the build manifest");
  }
  if (buildManifest.hostTarget !== expectedHostTarget) {
    throw new TypeError("expectedHostTarget must match the build manifest host target");
  }
  if (host.denoTarget !== expectedHostTarget) {
    throw new TypeError("host.denoTarget must match expectedHostTarget");
  }
  if (
    identity.adapter.id !== adapterId ||
    identity.adapter.buildContractVersion !== input.adapter.buildContractVersion ||
    identity.adapter.verifierContractVersion !== input.adapter.verifierContractVersion ||
    canonicalJson(identity.host) !== canonicalJson(host) ||
    canonicalJson(identity.source.repository) !== canonicalJson(source.repository) ||
    identity.source.commit !== source.commit ||
    canonicalJson(identity.source.version) !== canonicalJson(source.versionMetadata) ||
    identity.host.denoTarget !== expectedHostTarget
  ) throw new TypeError("canonical build recipe does not match its source, adapter, or host");
  if (await computeInstallationId(identity) !== buildManifest.identity) {
    throw new TypeError("build manifest identity is not the canonical recipe hash");
  }
  return { buildManifest, source, host, identity };
}

function createStrictManifest(input: {
  readonly installationId: string;
  readonly identity: InstallIdentityV1;
  readonly source: ResolvedSource;
  readonly buildManifest: BuildManifest;
  readonly expectedHostTarget: string;
  readonly executableRelative: string;
  readonly libraryRelative: string;
  readonly metadata: { readonly size: number; readonly sha256: string };
  readonly format: Elf64X86_64Info;
  readonly runtime: RuntimeLinkageRecord;
  readonly createdAt: string;
}): InstallManifestV3 {
  return validateInstallManifest({
    schemaVersion: 3,
    installationId: input.installationId,
    component: "zig",
    identity: input.identity,
    source: input.source,
    paths: { executable: input.executableRelative, libraries: [input.libraryRelative] },
    executable: {
      version: input.source.version,
      hostTarget: input.expectedHostTarget,
      size: input.metadata.size,
      sha256: input.metadata.sha256,
      format: input.format,
    },
    runtime: input.runtime,
    commands: input.buildManifest.commands,
    dependencies: [],
    createdAt: input.createdAt,
    verifierContractVersion: ZIG_INSTALL_VERIFIER_CONTRACT_VERSION,
  });
}

async function getIfInstalled(store: InstallBuiltZigStore, installationId: string) {
  try {
    return await store.get("zig", installationId);
  } catch (cause) {
    if (cause instanceof InstallStoreError && cause.code === "INSTALL_NOT_FOUND") return null;
    throw cause;
  }
}

function assertReusableInstall(
  installed: Awaited<ReturnType<InstallStore["get"]>>,
  identity: InstallIdentityV1,
  source: ResolvedSource,
  expectedHostTarget: string,
  expectedPaths: { readonly executable: string; readonly library: string },
): void {
  const manifest = installed.manifest;
  if (
    canonicalJson(manifest.identity) !== canonicalJson(identity) ||
    manifest.source.component !== source.component ||
    canonicalJson(manifest.source.repository) !== canonicalJson(source.repository) ||
    manifest.source.commit !== source.commit || manifest.source.version !== source.version ||
    canonicalJson(manifest.source.versionMetadata) !== canonicalJson(source.versionMetadata) ||
    manifest.paths.executable !== expectedPaths.executable ||
    manifest.paths.libraries.length !== 1 ||
    manifest.paths.libraries[0] !== expectedPaths.library ||
    manifest.executable.version !== source.version ||
    manifest.executable.hostTarget !== expectedHostTarget ||
    manifest.verifierContractVersion !== identity.adapter.verifierContractVersion
  ) {
    verificationFailure("immutable installation does not match the requested build output", {
      installationId: manifest.installationId,
    });
  }
}

async function assertSecureBuildInstallTree(
  buildManifest: BuildManifest,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal, "inspect built Zig install tree");
  const root = normalizedAbsolute(buildManifest.paths.root, "build root");
  const install = normalizedAbsolute(buildManifest.paths.install, "build install path");
  assertPathContained(root, install);
  await assertPathChainWithoutSymlinks(root, install, "build install path");
  await inspectRegularTree(install, signal);
}

async function inspectRegularTree(root: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal, "inspect built Zig install tree");
  const rootStat = await lstat(root, "inspect build install tree");
  if (!rootStat.isDirectory || rootStat.isSymlink) {
    verificationFailure("build install root is not a real directory", { root });
  }
  const pending = [root];
  while (pending.length > 0) {
    throwIfAborted(signal, "inspect built Zig install tree");
    const directory = pending.pop()!;
    const entries = [];
    for await (const entry of Deno.readDir(directory)) entries.push(entry);
    entries.sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      throwIfAborted(signal, "inspect built Zig install tree");
      const path = containedChild(root, directory, entry.name);
      const stat = await lstat(path, "inspect build install entry");
      if (stat.isSymlink) {
        verificationFailure("build install tree contains a symlink", { path });
      }
      if (stat.isDirectory) pending.push(path);
      else if (!stat.isFile) {
        verificationFailure("build install tree contains a special filesystem entry", { path });
      }
    }
  }
}

async function copyRegularTree(
  sourceRoot: string,
  destinationRoot: string,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal, "copy built Zig install tree");
  const source = normalizedAbsolute(sourceRoot, "copy source");
  const destination = normalizedAbsolute(destinationRoot, "copy destination");
  const sourceStat = await lstat(source, "inspect copy source");
  const destinationStat = await lstat(destination, "inspect copy destination");
  if (!sourceStat.isDirectory || sourceStat.isSymlink) {
    verificationFailure("copy source is not a real directory", { source });
  }
  if (!destinationStat.isDirectory || destinationStat.isSymlink) {
    verificationFailure("copy destination is not a real directory", { destination });
  }
  for await (const _entry of Deno.readDir(destination)) {
    verificationFailure("copy destination must be empty", { destination });
  }

  const pending = [{ source, destination }];
  while (pending.length > 0) {
    throwIfAborted(signal, "copy built Zig install tree");
    const current = pending.pop()!;
    const entries = [];
    for await (const entry of Deno.readDir(current.source)) entries.push(entry);
    entries.sort((left, right) => compareText(left.name, right.name));
    for (let index = entries.length - 1; index >= 0; index--) {
      throwIfAborted(signal, "copy built Zig install tree");
      const entry = entries[index];
      const sourcePath = containedChild(source, current.source, entry.name);
      const destinationPath = containedChild(destination, current.destination, entry.name);
      const stat = await lstat(sourcePath, "copy build install entry");
      if (stat.isSymlink) {
        verificationFailure("build install tree contains a symlink", { path: sourcePath });
      }
      if (stat.isDirectory) {
        await Deno.mkdir(destinationPath);
        pending.push({ source: sourcePath, destination: destinationPath });
      } else if (stat.isFile) {
        await copyRegularFile(sourcePath, destinationPath, stat, signal);
      } else {
        verificationFailure("build install tree contains a special filesystem entry", {
          path: sourcePath,
        });
      }
    }
  }
}

async function copyRegularFile(
  source: string,
  destination: string,
  inspected: Deno.FileInfo,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal, "copy built Zig install file");
  const input = await Deno.open(source, { read: true });
  let output: Deno.FsFile | undefined;
  try {
    const opened = await input.stat();
    if (!opened.isFile || !sameFileIdentity(inspected, opened) || opened.size !== inspected.size) {
      verificationFailure("build install file changed while it was being opened", { source });
    }
    const mode = inspected.mode === null ? undefined : inspected.mode & 0o7777;
    output = await Deno.open(destination, { createNew: true, write: true, mode });
    const buffer = new Uint8Array(128 * 1024);
    let copied = 0;
    while (true) {
      throwIfAborted(signal, "copy built Zig install file");
      const count = await input.read(buffer);
      if (count === null) break;
      await writeAll(output, buffer.subarray(0, count));
      copied += count;
      if (!Number.isSafeInteger(copied)) {
        verificationFailure("build install file is too large to copy safely", { source });
      }
    }
    throwIfAborted(signal, "copy built Zig install file");
    const finished = await input.stat();
    if (
      copied !== opened.size || finished.size !== opened.size ||
      !sameFileIdentity(opened, finished) || !sameTimestamp(opened.mtime, finished.mtime)
    ) {
      verificationFailure("build install file changed while it was being copied", { source });
    }
    const pathAfterCopy = await lstat(source, "reinspect copied build install file");
    if (
      pathAfterCopy.isSymlink || !pathAfterCopy.isFile || !sameFileIdentity(opened, pathAfterCopy)
    ) {
      verificationFailure("build install file path changed while it was being copied", { source });
    }
    await output.sync();
    if (mode !== undefined && Deno.build.os !== "windows") await Deno.chmod(destination, mode);
  } finally {
    output?.close();
    input.close();
  }
}

function relocateRuntimeLinkage(
  runtime: RuntimeLinkageRecord,
  stagingRoot: string,
  finalRoot: string,
): RuntimeLinkageRecord {
  if (runtime.linkage === "static") return runtime;
  const record = (value: typeof runtime.interpreter) => {
    let path = value.path;
    if (!isAbsolute(path) || resolve(path) !== path) {
      throw new TypeError("runtime dependency paths must be absolute and normalized");
    }
    if (isPathContained(stagingRoot, path)) {
      path = join(finalRoot, relative(resolve(stagingRoot), path));
    }
    return { ...value, path };
  };
  const dependencies = runtime.dependencies.map(record);
  dependencies.sort((left, right) =>
    compareText(left.name, right.name) || compareText(left.path, right.path)
  );
  return { linkage: "dynamic", interpreter: record(runtime.interpreter), dependencies };
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

async function assertPathChainWithoutSymlinks(
  root: string,
  candidate: string,
  label: string,
): Promise<void> {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = assertPathContained(normalizedRoot, candidate);
  const rel = relative(normalizedRoot, normalizedCandidate);
  const segments = rel === "" ? [] : rel.split(/[\\/]/);
  let current = normalizedRoot;
  for (const segment of ["", ...segments]) {
    if (segment !== "") current = join(current, segment);
    const stat = await lstat(current, `inspect ${label}`);
    if (stat.isSymlink) verificationFailure(`${label} contains a symlink`, { path: current });
  }
}

async function cleanupOwnedStaging(
  store: InstallBuiltZigStore,
  staging: InstallStaging,
  operationCause: unknown,
): Promise<void> {
  const expected = resolve(join(store.stagingRoot, staging.operationId));
  if (resolve(staging.root) !== expected || dirname(expected) !== resolve(store.stagingRoot)) {
    throw new AggregateError(
      [operationCause, new Error("refused to clean a staging path not owned by this operation")],
      "Zig install failed and its staging ownership could not be established",
    );
  }
  try {
    const stat = await Deno.lstat(expected);
    await Deno.remove(expected, { recursive: stat.isDirectory && !stat.isSymlink });
  } catch (cleanupCause) {
    if (cleanupCause instanceof Deno.errors.NotFound) return;
    throw new AggregateError(
      [operationCause, cleanupCause],
      "Zig install failed and its owned staging directory could not be removed",
    );
  }
}

function artifactPath(root: string, canonicalPath: string): string {
  const path = join(root, ...canonicalPath.split("/"));
  assertPathContained(join(root, "install"), path);
  return path;
}

function containedChild(root: string, parent: string, name: string): string {
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\0")) {
    verificationFailure("filesystem entry has an unsafe name", { parent, name });
  }
  const path = join(parent, name);
  assertPathContained(root, path);
  return path;
}

function normalizedAbsolute(path: string, label: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new TypeError(`${label} must be an absolute normalized path`);
  }
  return path;
}

function currentInstallPipelinePlatform(): InstallPipelinePlatform {
  if (Deno.build.os === "linux" || Deno.build.os === "darwin" || Deno.build.os === "windows") {
    return Deno.build.os;
  }
  throw new TypeError(`install pipeline paths are unsupported on ${Deno.build.os}`);
}

async function lstat(path: string, action: string): Promise<Deno.FileInfo> {
  try {
    return await Deno.lstat(path);
  } catch (cause) {
    verificationFailure(`unable to ${action}`, { path, cause: message(cause) });
  }
}

function assertSuccessfulResult(
  result: Awaited<ReturnType<ProcessRunner["run"]>>,
  operation: string,
  executablePath: string,
): void {
  if (!result.success) {
    verificationFailure(`${operation} failed`, {
      executablePath,
      exitCode: result.code,
      signal: result.signal,
      stderr: result.stderr,
      stderrTruncated: result.stderrTruncated,
    });
  }
}

function assertBoundedResult(
  result: Awaited<ReturnType<ProcessRunner["run"]>>,
  maximum: number,
  operation: string,
): void {
  if (
    result.stdoutTruncated || result.stderrTruncated ||
    new TextEncoder().encode(result.stdout).length > maximum ||
    new TextEncoder().encode(result.stderr).length > maximum
  ) {
    verificationFailure(`${operation} output exceeded its verification limit`, { maximum });
  }
}

async function createVerificationEnvironment(
  scratch: string,
  executablePath: string,
): Promise<Readonly<Record<string, string>>> {
  const home = join(scratch, "home");
  const temp = join(scratch, "tmp");
  const cache = join(scratch, "cache");
  await Promise.all([
    Deno.mkdir(home),
    Deno.mkdir(temp),
    Deno.mkdir(join(cache, "local"), { recursive: true }),
    Deno.mkdir(join(cache, "global"), { recursive: true }),
    Deno.mkdir(join(cache, "xdg"), { recursive: true }),
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
    HOME: home,
    TMPDIR: temp,
    XDG_CACHE_HOME: join(cache, "xdg"),
    ZIG_LOCAL_CACHE_DIR: join(cache, "local"),
    ZIG_GLOBAL_CACHE_DIR: join(cache, "global"),
  };
}

function normalizeHostTarget(value: string): string {
  const normalized = value.toLowerCase();
  const segments = normalized.split("-").filter(Boolean);
  const architecture = segments.find((segment) =>
    segment === "x86_64" || segment === "amd64" || segment === "aarch64"
  );
  const os = segments.find((segment) => segment === "linux" || segment.startsWith("linux."));
  const abi = segments.find((segment) =>
    segment === "gnu" || segment.startsWith("gnu.") || segment === "musl" ||
    segment.startsWith("musl.")
  );
  if (architecture === undefined || os === undefined || abi === undefined) {
    verificationFailure("compiler-reported host target cannot be normalized", { target: value });
  }
  return `${architecture === "amd64" ? "x86_64" : architecture}-linux-${
    abi.startsWith("gnu") ? "gnu" : "musl"
  }`;
}

function normalizeExpectedHost(host: ToolchainHostIdentity): string {
  if (host.os !== "linux" || (host.abi !== "gnu" && host.abi !== "musl")) {
    verificationFailure("verification host is unsupported", { host });
  }
  const architecture = host.architecture === "amd64" ? "x86_64" : host.architecture;
  const normalized = `${architecture}-${host.os}-${host.abi}`;
  if (normalizeHostTarget(host.denoTarget) !== normalized) {
    verificationFailure("Deno target does not match the structured host identity", { host });
  }
  return normalized;
}

async function ensurePhysicalDirectory(path: string): Promise<void> {
  try {
    await Deno.mkdir(path, { recursive: true });
  } catch (cause) {
    if (!(cause instanceof Deno.errors.AlreadyExists)) throw cause;
  }
  const info = await Deno.lstat(path);
  if (!info.isDirectory || info.isSymlink || resolve(await Deno.realPath(path)) !== path) {
    verificationFailure("verification scratch root is not a physical directory", { path });
  }
}

function verificationFailure(
  reason: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new ZigBinaryVerificationError(reason, details);
}

function requiredText(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || hasControlCharacter(value)) {
    throw new TypeError(`${path} must be nonempty text without control characters`);
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code <= 0x1f || code >= 0x7f && code <= 0x9f) return true;
  }
  return false;
}

function sameFileIdentity(left: Deno.FileInfo, right: Deno.FileInfo): boolean {
  if (left.dev === null || left.ino === null || right.dev === null || right.ino === null) {
    return true;
  }
  return left.dev === right.dev && left.ino === right.ino;
}

function sameTimestamp(left: Date | null, right: Date | null): boolean {
  return left === null || right === null || left.getTime() === right.getTime();
}

async function writeAll(file: Deno.FsFile, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) offset += await file.write(bytes.subarray(offset));
}

function operationUuid(value: string): string {
  if (!OPERATION_ID.test(value)) throw new TypeError("operationId must be a canonical UUID");
  return value;
}

function assertExactOperationRoot(root: string, candidate: string, operationId: string): void {
  const expected = resolve(join(root, operationUuid(operationId)));
  if (resolve(candidate) !== expected || dirname(expected) !== resolve(root)) {
    throw new TypeError("verification staging does not match its operation UUID");
  }
}

async function removeDirectoryIfEmpty(path: string): Promise<void> {
  try {
    for await (const _entry of Deno.readDir(path)) return;
    await Deno.remove(path);
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound)) {
      // Verification cleanup must not remove or obscure sibling operation staging.
    }
  }
}

function throwIfAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted) {
    throw new ZigOperationAbortedError(operation, {}, { cause: signal.reason });
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function decodeZigString(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character !== "\\") {
      result += character;
      continue;
    }
    const escape = value[++index];
    if (escape === undefined) throw new Error("incomplete escape");
    if (escape === "n") result += "\n";
    else if (escape === "r") result += "\r";
    else if (escape === "t") result += "\t";
    else if (escape === "\\" || escape === '"' || escape === "'") result += escape;
    else if (escape === "x") {
      const digits = value.slice(index + 1, index + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(digits)) throw new Error("invalid hexadecimal escape");
      result += String.fromCharCode(Number.parseInt(digits, 16));
      index += 2;
    } else if (escape === "u" && value[index + 1] === "{") {
      const end = value.indexOf("}", index + 2);
      if (end < 0) throw new Error("unterminated Unicode escape");
      const digits = value.slice(index + 2, end);
      if (!/^[0-9a-fA-F]{1,6}$/.test(digits)) throw new Error("invalid Unicode escape");
      const codePoint = Number.parseInt(digits, 16);
      if (codePoint > 0x10ffff || codePoint >= 0xd800 && codePoint <= 0xdfff) {
        throw new Error("invalid Unicode code point");
      }
      result += String.fromCodePoint(codePoint);
      index = end;
    } else {
      throw new Error(`unsupported escape \\${escape}`);
    }
  }
  return result;
}
