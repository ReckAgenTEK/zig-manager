import { join } from "@std/path";
import { archInstallCommand, ArchPackageVerifier } from "./arch_packages.ts";
import { ZigOperationAbortedError } from "./errors.ts";
import type { ResolvedSource } from "./install_store.ts";
import type {
  ReleaseAdapter,
  ReleaseDevelopmentHeader,
  ReleaseDevelopmentLibrary,
  ReleaseGeneratorRequirement,
  ReleaseToolKey,
  ReleaseToolRequirement,
} from "./release_adapter.ts";
import {
  DenoDiagnosticProbe,
  type DiagnosticProbe,
  type DiagnosticResourcePaths,
  inspectDiagnosticResources,
} from "./resource_diagnostics.ts";
import type {
  BuildToolchain,
  DiagnosticCounts,
  DiagnosticFinding,
  DiagnosticResourceResult,
  DiagnosticSessionResult,
  ProcessResult,
  ProcessRunner,
  ResolvedZigManagerConfig,
  SourceRefDoctorResult,
  ToolProbeResult,
  ZigDoctorResult,
  ZigManagerHost,
  ZigManagerHostDiagnostic,
  ZigSourceVersion,
} from "./types.ts";

const FALLBACK_VERSION_MAX_BYTES = 4 * 1024;

export interface DoctorContext {
  readonly config: ResolvedZigManagerConfig;
  readonly adapter: ReleaseAdapter;
  readonly sourceRefDoctor: SourceRefDoctorResult | null;
  readonly sourceRefFailure?: unknown;
  readonly runner: ProcessRunner;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: "linux" | "darwin" | "windows";
  readonly resourcePaths?: DiagnosticResourcePaths;
  readonly resources?: DiagnosticResourceResult;
  /** Legacy direct-call fallback for the cache and staging probes. */
  readonly outputPath?: string;
  readonly diagnosticProbe?: DiagnosticProbe;
  readonly source?: ResolvedSource;
  readonly sourceVersion?: ZigSourceVersion;
  readonly arch?: boolean;
  readonly strict?: boolean;
  readonly signal?: AbortSignal;
}

interface CandidateSet {
  readonly values: readonly string[];
  readonly explicit: boolean;
}

interface PendingFinding {
  readonly finding: DiagnosticFinding;
  readonly archPackages: readonly string[];
  readonly allowPackageHint: boolean;
}

export async function inspectBuildPrerequisites(context: DoctorContext): Promise<ZigDoctorResult> {
  throwIfAborted(context.signal, "doctor");
  const { adapter, config, runner, signal } = context;
  const requirements = adapter.requirements;
  const pending: PendingFinding[] = [];
  const probes = new Map<ReleaseToolKey, ToolProbeResult>();

  for (const key of toolOrder()) {
    const requirement = requirements.tools[key];
    const configured = configuredTool(key, config, context.env);
    const probe = await probeTool(
      runner,
      requirement,
      candidates(configured, requirement.candidates[context.platform]),
      signal,
    );
    probes.set(key, probe);
    if (!probe.available) {
      pending.push({
        finding: createDiagnosticFinding({
          severity: "error",
          code: "ZIG_TOOL_MISSING",
          component: requirement.component,
          summary: probe.message ?? `${requirement.component} is unavailable`,
          required: requirement.required,
          found: null,
          checkedPaths: probe.checkedCandidates,
          remediation:
            `Install a compatible ${requirement.component} or configure its explicit executable path.`,
          details: { arguments: probe.arguments, explicit: probe.explicit },
        }),
        archPackages: requirement.archPackages,
        allowPackageHint: !probe.explicit,
      });
    } else if (!probe.supported) {
      pending.push({
        finding: createDiagnosticFinding({
          severity: "error",
          code: "ZIG_TOOL_VERSION_INCOMPATIBLE",
          component: requirement.component,
          summary: probe.message ?? `${requirement.component} is incompatible`,
          required: requirement.required,
          found: probe.version,
          checkedPaths: [probe.executable],
          remediation:
            `Select a ${requirement.component} executable that satisfies ${requirement.required}.`,
          details: { arguments: probe.arguments, explicit: probe.explicit },
        }),
        archPackages: requirement.archPackages,
        allowPackageHint: !probe.explicit,
      });
    }
  }

  const cmake = requiredProbe(probes, "cmake");
  const cCompiler = requiredProbe(probes, "cCompiler");
  const cxxCompiler = requiredProbe(probes, "cxxCompiler");
  const llvmConfig = requiredProbe(probes, "llvmConfig");
  const clang = requiredProbe(probes, "clang");
  const lld = requiredProbe(probes, "lld");

  const generatorRequirement = requirements.generators[config.build.generator];
  const explicitGenerator = firstNonempty(
    config.tools.generatorTool,
    context.env.ZIG_MANAGER_GENERATOR_TOOL,
  );
  const generatorTool = generatorRequirement === undefined ? null : await probeGenerator(
    runner,
    generatorRequirement,
    candidates(explicitGenerator, generatorRequirement.candidates[context.platform]),
    signal,
  );
  if (generatorTool !== null && !generatorTool.available) {
    pending.push({
      finding: createDiagnosticFinding({
        severity: "error",
        code: "ZIG_GENERATOR_UNAVAILABLE",
        component: generatorRequirement.component,
        summary: generatorTool.message ?? `${generatorRequirement.component} is unavailable`,
        required: generatorRequirement.required,
        found: null,
        checkedPaths: generatorTool.checkedCandidates,
        remediation:
          `Install the '${config.build.generator}' generator or select another adapter-supported generator.`,
        details: { arguments: generatorTool.arguments, explicit: generatorTool.explicit },
      }),
      archPackages: generatorRequirement.archPackages,
      allowPackageHint: !generatorTool.explicit,
    });
  } else if (generatorTool !== null && !generatorTool.supported) {
    pending.push({
      finding: createDiagnosticFinding({
        severity: "error",
        code: "ZIG_TOOL_VERSION_INCOMPATIBLE",
        component: generatorRequirement.component,
        summary: generatorTool.message ?? `${generatorRequirement.component} is incompatible`,
        required: generatorRequirement.required,
        found: generatorTool.version,
        checkedPaths: [generatorTool.executable],
        remediation:
          `Select a generator executable that satisfies ${generatorRequirement.required}.`,
        details: { arguments: generatorTool.arguments, explicit: generatorTool.explicit },
      }),
      archPackages: generatorRequirement.archPackages,
      allowPackageHint: !generatorTool.explicit,
    });
  }
  if (generatorRequirement === undefined && explicitGenerator !== null) {
    pending.push({
      finding: createDiagnosticFinding({
        severity: "warning",
        code: "ZIG_TOOL_OVERRIDE",
        component: "generator tool",
        summary: "An explicit generator executable is configured for an unrecognized generator",
        required: "adapter-owned generator candidate selection",
        found: explicitGenerator,
        checkedPaths: [explicitGenerator],
        remediation:
          "Verify the generator override and select an adapter-owned generator when possible.",
      }),
      archPackages: [],
      allowPackageHint: false,
    });
  }

  if (cmake.available && cmake.supported) {
    const generatorSupported = await cmakeSupportsGenerator(
      runner,
      cmake.executable,
      config.build.generator,
      signal,
    );
    if (!generatorSupported) {
      pending.push({
        finding: createDiagnosticFinding({
          severity: "error",
          code: "ZIG_GENERATOR_UNSUPPORTED",
          component: config.build.generator,
          summary: `CMake does not report generator '${config.build.generator}'`,
          required: config.build.generator,
          found: null,
          checkedPaths: [cmake.executable],
          remediation: "Select a generator reported by the configured CMake installation.",
          details: { arguments: ["--help"] },
        }),
        archPackages: generatorRequirement?.archPackages ?? [],
        allowPackageHint: explicitGenerator === null,
      });
    }
  }

  const llvmDetails = llvmConfig.available && llvmConfig.supported
    ? await probeLlvmDirectories(runner, llvmConfig.executable, signal)
    : { prefix: null, includeDir: null, libDir: null };
  const configuredPrefix = firstNonempty(
    config.build.cmakePrefixPath,
    context.env.ZIG_MANAGER_CMAKE_PREFIX_PATH,
  );
  const cmakePrefixPath = configuredPrefix ?? llvmDetails.prefix ??
    requirements.defaultCmakePrefix[context.platform] ?? "";

  if (llvmConfig.available && llvmConfig.supported) {
    const development = await inspectDevelopmentFiles(
      llvmDetails.includeDir,
      llvmDetails.libDir,
      requirements.developmentFiles.headers,
      requirements.developmentFiles.libraries,
    );
    if (!development.ok) {
      pending.push({
        finding: createDiagnosticFinding({
          severity: "error",
          code: "ZIG_DEVELOPMENT_FILES_MISSING",
          component: "LLVM/Clang/LLD development files",
          summary: development.message,
          required: requirements.developmentFiles.headers.map((item) => item.relativePath),
          found: development.found,
          checkedPaths: development.checkedPaths,
          remediation: "Install the adapter's matching LLVM, Clang, and LLD development files.",
          details: development.details,
        }),
        archPackages: development.archPackages,
        allowPackageHint: !llvmConfig.explicit && !clang.explicit && !lld.explicit &&
          configuredPrefix === null,
      });
    }

    const targets = await inspectLlvmTargets(
      runner,
      llvmConfig.executable,
      requirements.llvmTargets,
      signal,
    );
    if (!targets.ok) {
      pending.push({
        finding: createDiagnosticFinding({
          severity: "error",
          code: "ZIG_LLVM_TARGETS_MISSING",
          component: "LLVM targets",
          summary: targets.message,
          required: requirements.llvmTargets,
          found: targets.available,
          checkedPaths: [llvmConfig.executable],
          remediation:
            `Use an LLVM build satisfying ${requirements.tools.llvmConfig.required} and containing every target required by this Zig adapter.`,
          details: { missing: targets.missing, arguments: ["--targets-built"] },
        }),
        archPackages: requirements.tools.llvmConfig.archPackages,
        allowPackageHint: !llvmConfig.explicit,
      });
    }
  }

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

  for (const tool of [cmake, cCompiler, cxxCompiler, llvmConfig, clang, lld, generatorTool]) {
    if (tool?.explicit !== true) continue;
    pending.push({
      finding: createDiagnosticFinding({
        severity: "warning",
        code: "ZIG_TOOL_OVERRIDE",
        component: tool.name,
        summary: `${tool.name} uses an explicit executable override`,
        required: "adapter default candidate selection",
        found: tool.executable,
        checkedPaths: [tool.executable],
        remediation:
          "Verify that the override is intentional and remove it to restore adapter defaults.",
        details: { arguments: tool.arguments },
      }),
      archPackages: [],
      allowPackageHint: false,
    });
  }
  if (configuredPrefix !== null) {
    pending.push({
      finding: createDiagnosticFinding({
        severity: "warning",
        code: "ZIG_TOOL_OVERRIDE",
        component: "CMake prefix path",
        summary: "CMake package discovery uses an explicit prefix override",
        required: "adapter-derived LLVM prefix",
        found: configuredPrefix,
        checkedPaths: [configuredPrefix],
        remediation:
          "Verify that this prefix belongs to the exact LLVM release required by the adapter.",
      }),
      archPackages: [],
      allowPackageHint: false,
    });
  }

  const probe = context.diagnosticProbe ?? new DenoDiagnosticProbe();
  const resourcePaths = context.resourcePaths ?? {
    cacheBuild: context.outputPath ?? config.sourceRoot,
    dataStaging: context.outputPath ?? config.sourceRoot,
    cacheRoot: config.projectRoot,
  };
  const resources = context.resources ?? await inspectDiagnosticResources(
    probe,
    resourcePaths,
    config.warnings.cacheBytes,
  );
  for (const finding of resourceDiagnosticFindings(resources)) {
    pending.push({ finding, archPackages: [], allowPackageHint: false });
  }
  for (
    const finding of sourceRefDiagnosticFindings(
      context.sourceRefDoctor,
      context.sourceRefFailure,
    )
  ) {
    pending.push({
      finding,
      archPackages: finding.code === "ZIG_GIT_UNAVAILABLE" ||
          finding.code === "ZIG_GIT_INCOMPATIBLE"
        ? [requirements.archPackages.git]
        : [],
      allowPackageHint: finding.code === "ZIG_GIT_UNAVAILABLE" ||
        finding.code === "ZIG_GIT_INCOMPATIBLE",
    });
  }
  for (
    const finding of sourceDiagnosticWarnings(
      context.source,
      context.sourceVersion,
      config.warnings.movingSelectorMaxAgeHours,
      probe.now(),
    )
  ) {
    pending.push({ finding, archPackages: [], allowPackageHint: false });
  }

  const arch = context.arch ?? await isArch(probe);
  const verifier = arch ? new ArchPackageVerifier(runner, signal) : null;
  const findings: DiagnosticFinding[] = [];
  for (const item of pending) {
    findings.push(
      verifier !== null && item.allowPackageHint
        ? await addVerifiedPackageHints(
          item.finding,
          item.archPackages,
          verifier,
          (name, version) =>
            requirements.archPackageConstraints[name]?.acceptsVersion(version) === true,
        )
        : item.finding,
    );
  }
  const policy = applyDiagnosticPolicy(findings, context.strict === true);
  return {
    schemaVersion: 2,
    strict: context.strict === true,
    ...policy,
    adapter: adapter.id,
    sourceRef: context.sourceRefDoctor,
    toolchain,
    resources,
    findings,
  };
}

export function createDiagnosticFinding(
  input: Omit<DiagnosticFinding, "packageHints" | "details"> & {
    readonly packageHints?: DiagnosticFinding["packageHints"];
    readonly details?: DiagnosticFinding["details"];
  },
): DiagnosticFinding {
  return {
    severity: input.severity,
    code: input.code,
    component: input.component,
    summary: input.summary,
    required: input.required,
    found: input.found,
    checkedPaths: [...input.checkedPaths],
    remediation: input.remediation,
    ...(input.command === undefined ? {} : { command: input.command }),
    packageHints: [...(input.packageHints ?? [])],
    details: { ...(input.details ?? {}) },
  };
}

export function applyDiagnosticPolicy(
  findings: readonly DiagnosticFinding[],
  strict: boolean,
): {
  readonly ok: boolean;
  readonly buildReady: boolean;
  readonly counts: DiagnosticCounts;
  readonly errors: number;
  readonly warnings: number;
  readonly info: number;
} {
  const counts = diagnosticCounts(findings);
  const buildReady = counts.errors === 0;
  return {
    counts,
    errors: counts.errors,
    warnings: counts.warnings,
    info: counts.info,
    buildReady,
    ok: buildReady && (!strict || counts.warnings === 0),
  };
}

export function diagnosticCounts(findings: readonly DiagnosticFinding[]): DiagnosticCounts {
  let errors = 0;
  let warnings = 0;
  let info = 0;
  for (const finding of findings) {
    if (finding.severity === "error") errors++;
    else if (finding.severity === "warning") warnings++;
    else info++;
  }
  return { errors, warnings, info };
}

export async function inspectHostDiagnostics(
  host: ZigManagerHost,
  probe: DiagnosticProbe = new DenoDiagnosticProbe(),
): Promise<{ readonly host: ZigManagerHostDiagnostic; readonly findings: DiagnosticFinding[] }> {
  const findings: DiagnosticFinding[] = [];
  let distributionId: string | null = null;
  let osReleaseMessage: string | null = null;
  try {
    distributionId = parseOsReleaseId(await probe.readTextFile("/etc/os-release"));
    if (distributionId === null) osReleaseMessage = "ID is missing or malformed";
  } catch (cause) {
    osReleaseMessage = errorMessage(cause);
  }

  const tupleSupported = host.os === "linux" && host.architecture === "x86_64" &&
    host.abi === "gnu" && host.denoTarget === "x86_64-unknown-linux-gnu";
  if (!tupleSupported) {
    findings.push(createDiagnosticFinding({
      severity: "error",
      code: "ZIG_HOST_UNSUPPORTED",
      component: "host tuple",
      summary: "The runtime host tuple is not supported",
      required: {
        os: "linux",
        architecture: "x86_64",
        abi: "gnu",
        denoTarget: "x86_64-unknown-linux-gnu",
      },
      found: host,
      checkedPaths: [],
      remediation: "Run zig-manager on the exact supported Linux x86_64 GNU Deno target.",
    }));
  }
  if (distributionId !== "arch") {
    findings.push(createDiagnosticFinding({
      severity: "error",
      code: "ZIG_ARCH_ID_UNSUPPORTED",
      component: "operating system distribution",
      summary: osReleaseMessage === null
        ? `Unsupported distribution ID '${distributionId}'`
        : `Arch Linux identity could not be established: ${osReleaseMessage}`,
      required: "arch",
      found: distributionId,
      checkedPaths: ["/etc/os-release"],
      remediation: "Use an Arch Linux host with /etc/os-release ID=arch.",
      details: { message: osReleaseMessage },
    }));
  }
  const supported = tupleSupported && distributionId === "arch";
  return {
    host: {
      ...host,
      supported,
      distributionId,
      required: {
        os: "linux",
        architecture: "x86_64",
        abi: "gnu",
        denoTarget: "x86_64-unknown-linux-gnu",
        distributionId: "arch",
      },
      checkedPaths: ["/etc/os-release"],
    },
    findings,
  };
}

export async function inspectSessionDiagnostics(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly expectedShimDirectory: string;
  readonly fallbackPath: string | null;
  readonly pinRelevant: boolean;
  readonly runner: ProcessRunner;
  readonly signal?: AbortSignal;
}): Promise<{ readonly session: DiagnosticSessionResult; readonly findings: DiagnosticFinding[] }> {
  const active = input.env.ZM_SESSION_ACTIVE === "1";
  const configuredShimDirectory = input.env.ZM_SHIM_DIR ?? null;
  const basePath = input.env.ZM_BASE_PATH ?? null;
  const firstPath = (input.env.PATH ?? "").split(":", 1)[0] ?? "";
  const pathStartsWithShim = firstPath === input.expectedShimDirectory;
  const baseContainsShim = basePath?.split(":").includes(input.expectedShimDirectory) === true;
  const coherent = !active || configuredShimDirectory === input.expectedShimDirectory &&
      basePath !== null && pathStartsWithShim && !baseContainsShim;
  const findings: DiagnosticFinding[] = [];

  if (active && !coherent) {
    findings.push(createDiagnosticFinding({
      severity: "warning",
      code: "ZIG_SESSION_INCOHERENT",
      component: "shell session",
      summary: "The active session does not match the expected shim and base PATH state",
      required: {
        shimDirectory: input.expectedShimDirectory,
        pathStartsWithShim: true,
        basePathExcludesShim: true,
      },
      found: { configuredShimDirectory, pathStartsWithShim, basePath, baseContainsShim },
      checkedPaths: [input.expectedShimDirectory],
      remediation:
        "Deactivate and reactivate the Bash session using zig-manager's generated shell code.",
    }));
  }
  if (!active && input.pinRelevant) {
    findings.push(createDiagnosticFinding({
      severity: "warning",
      code: "ZIG_SESSION_INACTIVE",
      component: "shell session",
      summary: "A managed or prospective pin exists but this shell is not activated",
      required: "ZM_SESSION_ACTIVE=1 for automatic directory switching",
      found: input.env.ZM_SESSION_ACTIVE ?? null,
      checkedPaths: [input.expectedShimDirectory],
      remediation: 'Activate this shell with eval "$(zm shell activate bash)".',
    }));
  }

  let fallbackVersion: string | null = null;
  let fallbackUsable = false;
  let fallbackMessage: string | null = null;
  if (input.fallbackPath !== null) {
    try {
      const result = await input.runner.run({
        executable: input.fallbackPath,
        args: ["version"],
        signal: input.signal,
        maxDiagnosticBytes: FALLBACK_VERSION_MAX_BYTES,
      });
      throwIfAborted(input.signal, "probe fallback Zig");
      const outputExceeded = result.stdoutTruncated || result.stderrTruncated ||
        new TextEncoder().encode(result.stdout).byteLength > FALLBACK_VERSION_MAX_BYTES ||
        new TextEncoder().encode(result.stderr).byteLength > FALLBACK_VERSION_MAX_BYTES;
      fallbackVersion = outputExceeded ? null : result.stdout.trim() || null;
      const versionWellFormed = fallbackVersion !== null && /^[^\s\p{Cc}]+$/u.test(fallbackVersion);
      fallbackUsable = result.success && versionWellFormed && !outputExceeded;
      if (!fallbackUsable) {
        fallbackMessage = outputExceeded
          ? "zig version output exceeded the diagnostic bound"
          : result.success && !versionWellFormed
          ? "zig version returned malformed output"
          : diagnostic(result) || `zig version exited with code ${result.code}`;
      }
    } catch (cause) {
      throwIfAborted(input.signal, "probe fallback Zig");
      fallbackMessage = errorMessage(cause);
    }
  }
  if (input.fallbackPath === null) {
    findings.push(createDiagnosticFinding({
      severity: "warning",
      code: "ZIG_FALLBACK_NOT_FOUND",
      component: "fallback Zig",
      summary: "No fallback Zig executable exists on the base PATH",
      required: "an executable Zig outside the managed shim directory",
      found: null,
      checkedPaths: (basePath ?? input.env.PATH ?? "").split(":").filter(Boolean),
      remediation: "Install or add the desired external Zig to PATH before activating zig-manager.",
      details: { arguments: ["version"] },
    }));
  } else if (!fallbackUsable) {
    findings.push(createDiagnosticFinding({
      severity: "warning",
      code: "ZIG_FALLBACK_UNUSABLE",
      component: "fallback Zig",
      summary: `Fallback Zig is unusable: ${fallbackMessage ?? "unknown failure"}`,
      required: "a bounded successful zig version invocation",
      found: fallbackVersion,
      checkedPaths: [input.fallbackPath],
      remediation: "Repair or replace the Zig executable on the base PATH.",
      details: { arguments: ["version"] },
    }));
  }

  const functionOverride = Object.keys(input.env).some((name) =>
    /^BASH_FUNC_zig(?:%%|\(\))$/.test(name) && input.env[name] !== undefined
  );
  if (functionOverride && (active || input.pinRelevant)) {
    findings.push(createDiagnosticFinding({
      severity: "info",
      code: "ZIG_SHELL_PRECEDENCE",
      component: "shell command precedence",
      summary: "An exported shell function named zig may take precedence over PATH shims",
      required: "PATH-based zig resolution",
      found: "shell function",
      checkedPaths: [input.expectedShimDirectory],
      remediation: "Remove the zig function when you want the managed PATH shim to resolve Zig.",
    }));
  }

  return {
    session: {
      active,
      pinRelevant: input.pinRelevant,
      expectedShimDirectory: input.expectedShimDirectory,
      configuredShimDirectory,
      basePath,
      pathStartsWithShim,
      coherent,
      fallback: {
        path: input.fallbackPath,
        version: fallbackVersion,
        usable: fallbackUsable,
        arguments: ["version"],
        message: fallbackMessage,
      },
      precedence: functionOverride ? "function" : "path",
    },
    findings,
  };
}

export function sourceRefDiagnosticFindings(
  sourceRef: SourceRefDoctorResult | null,
  failure?: unknown,
): DiagnosticFinding[] {
  if (sourceRef === null) {
    return [createDiagnosticFinding({
      severity: "error",
      code: "ZIG_SOURCE_REF_UNAVAILABLE",
      component: "Git/source-ref",
      summary: `Source diagnostics are unavailable${
        failure === undefined ? "" : `: ${errorMessage(failure)}`
      }`,
      required: "successful local source-ref diagnostics",
      found: null,
      checkedPaths: [],
      remediation: "Repair Git/source-ref availability and rerun doctor.",
      details: failure === undefined ? {} : { cause: errorMessage(failure) },
    })];
  }
  if (sourceRef.ok) return [];
  const git = sourceRef.git;
  const unavailable = !git.available;
  return [createDiagnosticFinding({
    severity: "error",
    code: unavailable ? "ZIG_GIT_UNAVAILABLE" : "ZIG_GIT_INCOMPATIBLE",
    component: "Git/source-ref",
    summary: git.message ?? (unavailable ? "Git is unavailable" : "Git is incompatible"),
    required: git.minimumVersion,
    found: git.version,
    checkedPaths: [],
    remediation: unavailable
      ? "Install Git and ensure it is directly executable by source-ref."
      : `Use Git ${git.minimumVersion} or newer.`,
  })];
}

export function resourceDiagnosticFindings(
  resources: DiagnosticResourceResult,
): DiagnosticFinding[] {
  const findings: DiagnosticFinding[] = [];
  for (const filesystem of resources.filesystems) {
    if (!filesystem.writable) {
      findings.push(createDiagnosticFinding({
        severity: "error",
        code: "ZIG_PATH_UNWRITABLE",
        component: `${filesystem.kind} filesystem`,
        summary: filesystem.message ?? "The prospective path is not writable without symlinks",
        required: "writable physical path",
        found: { path: filesystem.path, checkedPath: filesystem.checkedPath, writable: false },
        checkedPaths: [filesystem.path, filesystem.checkedPath],
        remediation:
          "Choose a writable physical manager or scope path and remove unsafe symlink traversal.",
      }));
    }
    if (filesystem.availableBytes === null) {
      findings.push(createDiagnosticFinding({
        severity: "warning",
        code: "ZIG_DISK_UNKNOWN",
        component: `${filesystem.kind} filesystem`,
        summary: "Available disk space could not be measured",
        required: filesystem.minimumBytes,
        found: null,
        checkedPaths: [filesystem.checkedPath],
        remediation: "Confirm that at least 20 GiB is available before starting a source build.",
      }));
    } else if (filesystem.availableBytes < filesystem.minimumBytes) {
      findings.push(createDiagnosticFinding({
        severity: "error",
        code: "ZIG_DISK_INSUFFICIENT",
        component: `${filesystem.kind} filesystem`,
        summary: "Available disk space is below the hard build minimum",
        required: filesystem.minimumBytes,
        found: filesystem.availableBytes,
        checkedPaths: [filesystem.checkedPath],
        remediation: "Free disk space or relocate the manager path before building Zig.",
      }));
    } else if (filesystem.availableBytes < filesystem.recommendedBytes) {
      findings.push(createDiagnosticFinding({
        severity: "warning",
        code: "ZIG_DISK_LOW",
        component: `${filesystem.kind} filesystem`,
        summary: "Available disk space is below the recommended build capacity",
        required: filesystem.recommendedBytes,
        found: filesystem.availableBytes,
        checkedPaths: [filesystem.checkedPath],
        remediation: "Consider freeing space or relocating this manager path before building.",
      }));
    }
  }

  const memory = resources.memory;
  if (memory.totalBytes === null || memory.availableBytes === null) {
    findings.push(createDiagnosticFinding({
      severity: "warning",
      code: "ZIG_MEMORY_UNKNOWN",
      component: "system memory",
      summary: `Memory capacity could not be measured${
        memory.message ? `: ${memory.message}` : ""
      }`,
      required: memory.recommendedBytes,
      found: null,
      checkedPaths: [],
      remediation: "Confirm that the host has sufficient memory before starting a source build.",
    }));
  } else if (
    memory.totalBytes < memory.recommendedBytes || memory.availableBytes < memory.recommendedBytes
  ) {
    findings.push(createDiagnosticFinding({
      severity: "warning",
      code: "ZIG_MEMORY_LOW",
      component: "system memory",
      summary: "Total or currently available memory is below the 16 GiB recommendation",
      required: memory.recommendedBytes,
      found: { totalBytes: memory.totalBytes, availableBytes: memory.availableBytes },
      checkedPaths: [],
      remediation:
        "Reduce parallelism or make more memory available; this warning does not block builds.",
    }));
  }

  const cache = resources.cache;
  if (cache.thresholdBytes !== null) {
    if (cache.measuredBytes !== null && cache.measuredBytes > cache.thresholdBytes) {
      findings.push(createDiagnosticFinding({
        severity: "warning",
        code: "ZIG_CACHE_LARGE",
        component: "replaceable cache",
        summary: "The replaceable manager cache exceeds its configured warning threshold",
        required: { maximumBytes: cache.thresholdBytes },
        found: { measuredBytes: cache.measuredBytes, complete: cache.complete },
        checkedPaths: [cache.path],
        remediation:
          "Review and remove replaceable cache data with zm gc when it is safe to do so.",
      }));
    } else if (cache.measuredBytes === null || cache.complete !== true) {
      findings.push(createDiagnosticFinding({
        severity: "warning",
        code: "ZIG_CACHE_SIZE_UNKNOWN",
        component: "replaceable cache",
        summary: `Cache size could not be established${cache.message ? `: ${cache.message}` : ""}`,
        required: { maximumBytes: cache.thresholdBytes },
        found: cache.measuredBytes,
        checkedPaths: [cache.path],
        remediation: "Inspect the physical cache tree and rerun doctor; symlinks are not followed.",
      }));
    }
  }
  return findings;
}

export async function addVerifiedPackageHints(
  finding: DiagnosticFinding,
  packages: readonly string[],
  verifier: ArchPackageVerifier,
  acceptsVersion: (name: string, version: string) => boolean = () => true,
): Promise<DiagnosticFinding> {
  const packageHints = (await verifier.verify(packages)).filter((hint) =>
    acceptsVersion(hint.name, hint.version)
  );
  const expectedPackages = [...new Set(packages)];
  const command = expectedPackages.every((name) => packageHints.some((hint) => hint.name === name))
    ? archInstallCommand(packageHints)
    : undefined;
  return {
    ...finding,
    packageHints,
    ...(command === undefined ? {} : { command }),
  };
}

export function sourceDiagnosticWarnings(
  source: ResolvedSource | undefined,
  version: ZigSourceVersion | undefined,
  movingSelectorMaxAgeHours: number,
  now: Date,
): DiagnosticFinding[] {
  const findings: DiagnosticFinding[] = [];
  if (
    version?.kind === "development" || version === undefined && source?.version.includes("-dev.")
  ) {
    findings.push(createDiagnosticFinding({
      severity: "warning",
      code: "ZIG_DEVELOPMENT_SOURCE",
      component: "Zig source",
      summary: "The selected source is a development snapshot",
      required: "a tagged release for reproducible release behavior",
      found: version?.text ?? source?.version ?? null,
      checkedPaths: [],
      remediation:
        "Use an exact release selector when development snapshot behavior is not intended.",
      details: version === undefined
        ? {}
        : { taggedAncestor: version.taggedAncestor, commitsAfterTag: version.commitsAfterTag },
    }));
  }
  if (source === undefined || !isMovingSelector(source.requestedSelector)) return findings;
  const resolvedAt = new Date(source.resolvedAt).getTime();
  const nowTime = now.getTime();
  if (!Number.isFinite(resolvedAt) || !Number.isFinite(nowTime) || resolvedAt > nowTime) {
    findings.push(createDiagnosticFinding({
      severity: "warning",
      code: "ZIG_MOVING_SELECTOR_AGE_UNKNOWN",
      component: "moving selector",
      summary: "The age of the last moving-selector resolution could not be established",
      required: { maximumAgeHours: movingSelectorMaxAgeHours },
      found: source.resolvedAt,
      checkedPaths: [],
      remediation:
        "Run zm update when remote access is appropriate to refresh the moving selector.",
    }));
    return findings;
  }
  const ageHours = (nowTime - resolvedAt) / (60 * 60 * 1000);
  if (ageHours > movingSelectorMaxAgeHours) {
    findings.push(createDiagnosticFinding({
      severity: "warning",
      code: "ZIG_MOVING_SELECTOR_STALE",
      component: "moving selector",
      summary: "The stored moving selector has not been remotely checked recently",
      required: { maximumAgeHours: movingSelectorMaxAgeHours },
      found: { resolvedAt: source.resolvedAt, ageHours },
      checkedPaths: [],
      remediation:
        "Run zm update when remote access is appropriate; doctor does not refresh moving selectors.",
    }));
  }
  return findings;
}

function configuredTool(
  key: ReleaseToolKey,
  config: ResolvedZigManagerConfig,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  switch (key) {
    case "cmake":
      return firstNonempty(config.tools.cmake, env.ZIG_MANAGER_CMAKE);
    case "cCompiler":
      return firstNonempty(config.tools.cCompiler, env.ZIG_MANAGER_CC, env.CC);
    case "cxxCompiler":
      return firstNonempty(config.tools.cxxCompiler, env.ZIG_MANAGER_CXX, env.CXX);
    case "llvmConfig":
      return firstNonempty(config.tools.llvmConfig, env.ZIG_MANAGER_LLVM_CONFIG);
    case "clang":
      return firstNonempty(config.tools.clang, env.ZIG_MANAGER_CLANG);
    case "lld":
      return firstNonempty(config.tools.lld, env.ZIG_MANAGER_LLD);
  }
}

function toolOrder(): readonly ReleaseToolKey[] {
  return ["cmake", "cCompiler", "cxxCompiler", "llvmConfig", "clang", "lld"];
}

function requiredProbe(
  probes: ReadonlyMap<ReleaseToolKey, ToolProbeResult>,
  key: ReleaseToolKey,
): ToolProbeResult {
  const probe = probes.get(key);
  if (probe === undefined) throw new TypeError(`missing internal ${key} probe`);
  return probe;
}

async function probeTool(
  runner: ProcessRunner,
  requirement: ReleaseToolRequirement,
  set: CandidateSet,
  signal?: AbortSignal,
): Promise<ToolProbeResult> {
  return await probeCandidateSet(
    runner,
    requirement.component,
    set,
    requirement.arguments,
    requirement.required,
    requirement.parseVersion,
    requirement.acceptsVersion,
    signal,
  );
}

async function probeGenerator(
  runner: ProcessRunner,
  requirement: ReleaseGeneratorRequirement,
  set: CandidateSet,
  signal?: AbortSignal,
): Promise<ToolProbeResult> {
  return await probeCandidateSet(
    runner,
    requirement.component,
    set,
    requirement.arguments,
    requirement.required,
    requirement.parseVersion,
    requirement.acceptsVersion,
    signal,
  );
}

async function probeCandidateSet(
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
      result = await runner.run({ executable, args: [...args], signal });
    } catch (cause) {
      throwIfAborted(signal, `probe ${name}`);
      lastMessage = errorMessage(cause);
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
        arguments: [...args],
        checkedCandidates: [...set.values],
        explicit: set.explicit,
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
      arguments: [...args],
      checkedCandidates: [...set.values],
      explicit: set.explicit,
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
    arguments: [...args],
    checkedCandidates: [...set.values],
    explicit: set.explicit,
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
  } catch {
    throwIfAborted(signal, "probe CMake generator");
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
    } catch {
      throwIfAborted(signal, "probe LLVM directories");
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
  headers: readonly ReleaseDevelopmentHeader[],
  libraries: readonly ReleaseDevelopmentLibrary[],
): Promise<{
  readonly ok: boolean;
  readonly message: string;
  readonly checkedPaths: readonly string[];
  readonly archPackages: readonly string[];
  readonly found: unknown;
  readonly details: Readonly<Record<string, unknown>>;
}> {
  if (includeDir === null || libDir === null) {
    return {
      ok: false,
      message: "llvm-config did not report include and library directories",
      checkedPaths: [],
      archPackages: [
        ...new Set([
          ...headers.flatMap((item) => item.archPackages),
          ...libraries.flatMap((item) => item.archPackages),
        ]),
      ],
      found: { includeDir, libDir },
      details: {},
    };
  }

  const checkedPaths: string[] = [];
  const missing: string[] = [];
  const packages = new Set<string>();
  for (const requirement of headers) {
    const path = join(includeDir, ...requirement.relativePath.split("/"));
    checkedPaths.push(path);
    try {
      const info = await Deno.lstat(path);
      if (!info.isFile || info.isSymlink) throw new Error("not a physical file");
    } catch {
      missing.push(requirement.component);
      for (const name of requirement.archPackages) packages.add(name);
    }
  }

  const libraryNames: string[] = [];
  try {
    for await (const entry of Deno.readDir(libDir)) {
      if (entry.isFile) libraryNames.push(entry.name);
    }
  } catch {
    missing.push("LLVM library directory");
    for (const requirement of libraries) {
      for (const name of requirement.archPackages) packages.add(name);
    }
  }
  checkedPaths.push(libDir);
  for (const requirement of libraries) {
    if (!libraryNames.some((name) => requirement.namePattern.test(name))) {
      missing.push(requirement.component);
      for (const name of requirement.archPackages) packages.add(name);
    }
  }
  return missing.length === 0
    ? {
      ok: true,
      message: "all adapter development files are present",
      checkedPaths,
      archPackages: [],
      found: { includeDir, libDir },
      details: {},
    }
    : {
      ok: false,
      message: `Required development files are missing: ${missing.join(", ")}`,
      checkedPaths,
      archPackages: [...packages],
      found: { includeDir, libDir },
      details: { missing, libraryNames },
    };
}

async function inspectLlvmTargets(
  runner: ProcessRunner,
  executable: string,
  requiredTargets: readonly string[],
  signal?: AbortSignal,
): Promise<{
  readonly ok: boolean;
  readonly message: string;
  readonly available: readonly string[];
  readonly missing: readonly string[];
}> {
  try {
    const result = await runner.run({ executable, args: ["--targets-built"], signal });
    throwIfAborted(signal, "probe LLVM targets");
    if (!result.success) {
      return {
        ok: false,
        message: diagnostic(result) || "llvm-config --targets-built failed",
        available: [],
        missing: [...requiredTargets],
      };
    }
    const available = [...new Set(result.stdout.trim().split(/\s+/).filter(Boolean))];
    const availableSet = new Set(available);
    const missing = requiredTargets.filter((target) => !availableSet.has(target));
    return {
      ok: missing.length === 0,
      message: missing.length === 0
        ? "all Zig-required LLVM targets are present"
        : `LLVM is missing required targets: ${missing.join(", ")}`,
      available,
      missing,
    };
  } catch (cause) {
    throwIfAborted(signal, "probe LLVM targets");
    return {
      ok: false,
      message: errorMessage(cause),
      available: [],
      missing: [...requiredTargets],
    };
  }
}

function candidates(value: string | null, defaults: readonly string[]): CandidateSet {
  return value === null
    ? { values: [...defaults], explicit: false }
    : { values: [value], explicit: true };
}

function firstNonempty(...values: readonly (string | null | undefined)[]): string | null {
  for (const value of values) {
    if (value !== null && value !== undefined && value.length > 0) return value;
  }
  return null;
}

function diagnostic(result: ProcessResult): string {
  return (result.stderr.trim() || result.stdout.trim()).slice(0, 1000);
}

function parseOsReleaseId(text: string): string | null {
  const match = /^ID=(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s#]+))\s*$/m.exec(text);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

async function isArch(probe: DiagnosticProbe): Promise<boolean> {
  try {
    return parseOsReleaseId(await probe.readTextFile("/etc/os-release")) === "arch";
  } catch {
    return false;
  }
}

function isMovingSelector(selector: string): boolean {
  return selector === "latest" || selector === "stable" || selector.startsWith("branch:") ||
    /^[0-9]+\.[0-9]+$/.test(selector);
}

function throwIfAborted(signal: AbortSignal | undefined, operation: string): void {
  if (signal?.aborted) throw new ZigOperationAbortedError(operation);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
