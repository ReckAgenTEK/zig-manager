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
  | "ZIG_INVALID_ARGUMENT";

export class ZigManagerError extends Error {
  readonly code: ZigManagerErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ZigManagerErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
    this.details = details;
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
  constructor(version: string | null) {
    super(
      "ZIG_RELEASE_UNSUPPORTED",
      `No release adapter supports Zig ${version ?? "with an unknown exact version"}`,
      { version },
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
    super("ZIG_SOURCE_NOT_READY", `Selected Zig source is not ready: ${reason}`, {
      reason,
      ...details,
    });
  }
}

export class BuildPrerequisiteError extends ZigManagerError {
  constructor(issues: readonly unknown[]) {
    super(
      "ZIG_BUILD_PREREQUISITE_MISSING",
      "Zig build prerequisites are missing or incompatible",
      { issues },
    );
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
  constructor(operation: string, options?: ErrorOptions) {
    super(
      "ZIG_OPERATION_ABORTED",
      `Zig manager operation was aborted: ${operation}`,
      { operation },
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
