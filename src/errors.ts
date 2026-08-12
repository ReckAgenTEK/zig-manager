import type { DiagnosticFinding } from "./types.ts";

export type ZigManagerErrorCode =
  | "ZIG_CONFIG_NOT_FOUND"
  | "ZIG_CONFIG_INVALID"
  | "ZIG_PATH_OUTSIDE_ROOT"
  | "ZIG_VERSION_SELECTOR_INVALID"
  | "ZIG_VERSION_NOT_FOUND"
  | "ZIG_RELEASE_UNSUPPORTED"
  | "ZIG_STATE_INVALID"
  | "ZIG_SOURCE_NOT_READY"
  | "ZIG_BUILD_PREREQUISITE_MISSING"
  | "ZIG_BUILD_FAILED"
  | "ZIG_BUILD_MANIFEST_INVALID"
  | "ZIG_BINARY_NOT_BUILT"
  | "ZIG_BINARY_VERIFICATION_FAILED"
  | "ZIG_DOCS_BUILD_REQUIRED"
  | "ZIG_DOCS_BUILD_FAILED"
  | "ZIG_DOCS_OUTPUT_INVALID"
  | "ZIG_DOCS_MANIFEST_INVALID"
  | "ZIG_MEGA_DOCS_UNSUPPORTED_FORMAT"
  | "ZIG_OPERATION_ABORTED"
  | "ZIG_PROCESS_FAILED"
  | "ZIG_IO"
  | "ZIG_INVALID_ARGUMENT"
  | "ZIG_HOST_UNSUPPORTED"
  | "ZIG_SCOPE_NOT_PINNED"
  | "ZIG_SCOPE_LOCKED"
  | "ZIG_PROFILE_NOT_FOUND"
  | "ZIG_PROFILE_INVALID"
  | "ZIG_INSTALL_NOT_FOUND"
  | "ZIG_INSTALL_CORRUPT"
  | "ZIG_INSTALL_LOCKED"
  | "ZIG_INSTALL_IN_USE"
  | "ZIG_DEPENDENCY_IN_USE"
  | "ZIG_FALLBACK_NOT_FOUND"
  | "ZIG_SHELL_UNSUPPORTED"
  | "ZIG_PURGE_CONFIRMATION_REQUIRED"
  | "ZLS_COMPATIBILITY_NOT_FOUND";

export class ZigManagerError extends Error {
  readonly code: ZigManagerErrorCode;
  readonly details: Readonly<Record<string, unknown>>;
  readonly remediation: string | null;

  constructor(
    code: ZigManagerErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
    remediation: string | null = null,
  ) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
    this.remediation = remediation;
  }
}

export class ConfigNotFoundError extends ZigManagerError {
  constructor(path: string, options?: ErrorOptions) {
    super(
      "ZIG_CONFIG_NOT_FOUND",
      `Zig manager configuration was not found: ${path}`,
      { path },
      options,
    );
  }
}

export class ConfigValidationError extends ZigManagerError {
  constructor(path: string, reason: string, options?: ErrorOptions) {
    super(
      "ZIG_CONFIG_INVALID",
      `Invalid Zig manager configuration '${path}': ${reason}`,
      { path, reason },
      options,
    );
  }
}

export class ZigPathOutsideRootError extends ZigManagerError {
  constructor(root: string, candidate: string) {
    super(
      "ZIG_PATH_OUTSIDE_ROOT",
      `Managed path escapes its allowed root: ${candidate}`,
      { root, candidate },
    );
  }
}

export class InvalidZigSelectorError extends ZigManagerError {
  constructor(selector: string, reason: string) {
    super(
      "ZIG_VERSION_SELECTOR_INVALID",
      `Invalid Zig selector '${selector}': ${reason}`,
      { selector, reason },
    );
  }
}

export class ZigVersionNotFoundError extends ZigManagerError {
  constructor(selector: string) {
    super(
      "ZIG_VERSION_NOT_FOUND",
      `No remote Zig reference matches selector '${selector}'`,
      { selector },
    );
  }
}

export class ZigReleaseUnsupportedError extends ZigManagerError {
  constructor(
    version: string | null,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(
      "ZIG_RELEASE_UNSUPPORTED",
      `No release adapter supports Zig ${version ?? "with an unknown exact version"}`,
      { version, ...details },
      undefined,
      "Use a Zig source version with a tested release adapter or upgrade zig-manager for newer source support.",
    );
  }
}

export class ZigStateValidationError extends ZigManagerError {
  constructor(path: string, reason: string, options?: ErrorOptions) {
    super(
      "ZIG_STATE_INVALID",
      `Invalid Zig manager state '${path}': ${reason}`,
      { path, reason },
      options,
    );
  }
}

export class ZigSourceNotReadyError extends ZigManagerError {
  constructor(reason: string, details: Readonly<Record<string, unknown>> = {}) {
    super(
      "ZIG_SOURCE_NOT_READY",
      `Selected Zig source is not ready: ${reason}`,
      {
        reason,
        ...details,
      },
      undefined,
      "Repair the exact source checkout or remove local changes before retrying.",
    );
  }
}

export class BuildPrerequisiteError extends ZigManagerError {
  readonly findings: readonly DiagnosticFinding[];

  constructor(findings: readonly DiagnosticFinding[]) {
    const errors = findings.filter((finding) => finding.severity === "error");
    super(
      "ZIG_BUILD_PREREQUISITE_MISSING",
      "Zig build preflight reported blocking diagnostic errors",
      { findings: errors },
      undefined,
      "Resolve every error finding reported by doctor before retrying the build.",
    );
    this.findings = errors;
  }
}

export class ZigBuildError extends ZigManagerError {
  constructor(message: string, details: Readonly<Record<string, unknown>>, options?: ErrorOptions) {
    super("ZIG_BUILD_FAILED", message, details, options);
  }
}

export class BuildManifestValidationError extends ZigManagerError {
  constructor(path: string, reason: string, options?: ErrorOptions) {
    super(
      "ZIG_BUILD_MANIFEST_INVALID",
      `Invalid Zig build manifest '${path}': ${reason}`,
      { path, reason },
      options,
    );
  }
}

export class ZigBinaryNotBuiltError extends ZigManagerError {
  constructor() {
    super("ZIG_BINARY_NOT_BUILT", "No verified managed Zig build is active");
  }
}

export class ZigBinaryVerificationError extends ZigManagerError {
  constructor(reason: string, details: Readonly<Record<string, unknown>> = {}) {
    super(
      "ZIG_BINARY_VERIFICATION_FAILED",
      `Managed Zig binary verification failed: ${reason}`,
      { reason, ...details },
      undefined,
      "Repair or rebuild the immutable Zig installation before selecting it.",
    );
  }
}

export class DocsBuildRequiredError extends ZigManagerError {
  constructor(sourceCommit: string, buildCommit: string | null) {
    super(
      "ZIG_DOCS_BUILD_REQUIRED",
      "Documentation requires a verified active build from the selected source commit",
      { sourceCommit, buildCommit },
    );
  }
}

export class ZigDocsBuildError extends ZigManagerError {
  constructor(message: string, details: Readonly<Record<string, unknown>>, options?: ErrorOptions) {
    super("ZIG_DOCS_BUILD_FAILED", message, details, options);
  }
}

export class ZigDocsOutputError extends ZigManagerError {
  constructor(reason: string, path: string) {
    super(
      "ZIG_DOCS_OUTPUT_INVALID",
      `Generated Zig documentation is invalid: ${reason}`,
      { reason, path },
    );
  }
}

export class DocsManifestValidationError extends ZigManagerError {
  constructor(path: string, reason: string, options?: ErrorOptions) {
    super(
      "ZIG_DOCS_MANIFEST_INVALID",
      `Invalid Zig docs manifest '${path}': ${reason}`,
      { path, reason },
      options,
    );
  }
}

export class MegaDocsUnsupportedFormatError extends ZigManagerError {
  constructor(reason: string, details: Readonly<Record<string, unknown>> = {}) {
    super(
      "ZIG_MEGA_DOCS_UNSUPPORTED_FORMAT",
      `Zig autodoc assets do not match mega format v1: ${reason}`,
      { reason, ...details },
    );
  }
}

export class ZigOperationAbortedError extends ZigManagerError {
  constructor(
    operation: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(
      "ZIG_OPERATION_ABORTED",
      `Zig manager operation was aborted: ${operation}`,
      { operation, ...details },
      options,
    );
  }
}

export class ZigProcessError extends ZigManagerError {
  constructor(executable: string, reason: string, options?: ErrorOptions) {
    super(
      "ZIG_PROCESS_FAILED",
      `Unable to run '${executable}': ${reason}`,
      { executable, reason },
      options,
    );
  }
}

export class ZigIoError extends ZigManagerError {
  constructor(action: string, path: string, options?: ErrorOptions) {
    super("ZIG_IO", `Failed to ${action}: ${path}`, { action, path }, options);
  }
}

export class ZigInvalidArgumentError extends ZigManagerError {
  constructor(message: string, details: Readonly<Record<string, unknown>> = {}) {
    super("ZIG_INVALID_ARGUMENT", message, details);
  }
}

export class ZigHostUnsupportedError extends ZigManagerError {
  constructor(reason: string, details: Readonly<Record<string, unknown>> = {}) {
    super(
      "ZIG_HOST_UNSUPPORTED",
      `Unsupported Zig manager host: ${reason}`,
      {
        reason,
        ...details,
      },
      undefined,
      "Run zig-manager on Arch Linux using the x86_64-unknown-linux-gnu Deno target.",
    );
  }
}

export class ZigScopeNotPinnedError extends ZigManagerError {
  constructor(path: string, inheritedFrom: string | null = null) {
    super(
      "ZIG_SCOPE_NOT_PINNED",
      inheritedFrom === null
        ? `No toolchain profile pointer exists exactly at '${path}'`
        : `No toolchain profile pointer exists exactly at '${path}'; the effective pointer is inherited from '${inheritedFrom}'`,
      { path, inheritedFrom },
    );
  }
}

export class ZigProfileNotFoundError extends ZigManagerError {
  constructor(profileId: string, scopeRoot?: string, options?: ErrorOptions) {
    super(
      "ZIG_PROFILE_NOT_FOUND",
      `Selected Zig/ZLS toolchain profile was not found: ${profileId}`,
      { profileId, ...(scopeRoot === undefined ? {} : { scopeRoot }) },
      options,
      "Repair or replace the explicit local or global profile pointer.",
    );
  }
}

export class ZigProfileInvalidError extends ZigManagerError {
  constructor(profileId: string, reason: string, options?: ErrorOptions) {
    super(
      "ZIG_PROFILE_INVALID",
      `Selected Zig/ZLS toolchain profile '${profileId}' is invalid: ${reason}`,
      { profileId, reason },
      options,
      "Repair or replace the invalid profile and its explicit local or global pointer.",
    );
  }
}

export class ZigInstallNotFoundError extends ZigManagerError {
  constructor(installationId: string, options?: ErrorOptions) {
    super(
      "ZIG_INSTALL_NOT_FOUND",
      `Managed Zig installation was not found: ${installationId}`,
      { installationId },
      options,
      "Rebuild the exact source or select an existing immutable installation.",
    );
  }
}

export class ZigInstallCorruptError extends ZigManagerError {
  constructor(installationId: string, reason: string, options?: ErrorOptions) {
    super(
      "ZIG_INSTALL_CORRUPT",
      `Managed Zig installation '${installationId}' is invalid: ${reason}`,
      { installationId, reason },
      options,
      "Rebuild the immutable installation; zig-manager will not silently use another Zig.",
    );
  }
}

export class ZigInstallInUseError extends ZigManagerError {
  constructor(
    component: "zig" | "zls",
    installationId: string,
    profileIds: readonly string[],
  ) {
    super(
      "ZIG_INSTALL_IN_USE",
      `Managed ${component.toUpperCase()} installation '${installationId}' is referenced by retained profiles`,
      { component, installationId, profileIds: [...profileIds] },
    );
  }
}

export class ZigDependencyInUseError extends ZigManagerError {
  constructor(installationId: string, dependentInstallationIds: readonly string[]) {
    super(
      "ZIG_DEPENDENCY_IN_USE",
      `Managed Zig installation '${installationId}' is required by retained ZLS installations`,
      {
        component: "zig",
        installationId,
        dependentInstallationIds: [...dependentInstallationIds],
      },
    );
  }
}

export class ZigFallbackNotFoundError extends ZigManagerError {
  constructor(tool: "zig" | "zls") {
    super(
      "ZIG_FALLBACK_NOT_FOUND",
      `No fallback ${tool} executable exists on the external PATH`,
      { tool },
      undefined,
      `Add the desired external ${tool} to PATH before activating zig-manager.`,
    );
  }
}

export class ZigShellUnsupportedError extends ZigManagerError {
  constructor(shell: string) {
    super("ZIG_SHELL_UNSUPPORTED", `Unsupported shell '${shell}'; only Bash is supported`, {
      shell,
    });
  }
}

export class ZigPurgeConfirmationError extends ZigManagerError {
  constructor() {
    super(
      "ZIG_PURGE_CONFIRMATION_REQUIRED",
      "Purging manager-owned data requires explicit confirmation or --dry-run",
    );
  }
}

export class ZlsCompatibilityNotFoundError extends ZigManagerError {
  constructor(subject: string, details: Readonly<Record<string, unknown>> = {}) {
    const compatibilityFailure = typeof details.reason === "string";
    super(
      "ZLS_COMPATIBILITY_NOT_FOUND",
      compatibilityFailure
        ? `No compatible source-built ZLS was found for Zig '${subject}': ${details.reason}`
        : `Toolchain profile '${subject}' has no managed ZLS provenance`,
      compatibilityFailure ? { subject, ...details } : { profileId: subject, ...details },
      undefined,
      compatibilityFailure
        ? "Use a Zig release cycle with a strict matching ZLS tag, or a development cycle matching ZLS remote HEAD."
        : "Select or migrate to a complete schema-v2 paired toolchain profile.",
    );
  }
}
