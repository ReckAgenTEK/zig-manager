import type {
  DiagnosticCommandData,
  ProcessResult,
  ProcessRunner,
  VerifiedArchPackageHint,
} from "./types.ts";
import { ZigOperationAbortedError } from "./errors.ts";

export const PACMAN_EXECUTABLE = "/usr/bin/pacman";
export const ARCH_INSTALL_WARNING =
  "This command performs a full system upgrade and may upgrade unrelated packages; review the transaction before continuing.";

const MAX_PACKAGE_METADATA_BYTES = 16 * 1024;
const PACKAGE_NAME = /^[a-z0-9][a-z0-9@._+-]*$/;

/** Read-only exact-name package metadata verifier. It never invokes an install or refresh form. */
export class ArchPackageVerifier {
  readonly #runner: ProcessRunner;
  readonly #signal?: AbortSignal;
  readonly #cache = new Map<string, Promise<VerifiedArchPackageHint | null>>();

  constructor(runner: ProcessRunner, signal?: AbortSignal) {
    this.#runner = runner;
    this.#signal = signal;
  }

  async verify(names: readonly string[]): Promise<VerifiedArchPackageHint[]> {
    const result: VerifiedArchPackageHint[] = [];
    for (const name of [...new Set(names)]) {
      if (!PACKAGE_NAME.test(name)) continue;
      const hint = await this.#verified(name);
      if (hint !== null) result.push(hint);
    }
    return result;
  }

  #verified(name: string): Promise<VerifiedArchPackageHint | null> {
    let pending = this.#cache.get(name);
    if (pending === undefined) {
      pending = this.#query(name);
      this.#cache.set(name, pending);
    }
    return pending;
  }

  async #query(name: string): Promise<VerifiedArchPackageHint | null> {
    this.#throwIfAborted();
    let installed: ProcessResult;
    let repository: ProcessResult;
    try {
      installed = await this.#runner.run({
        executable: PACMAN_EXECUTABLE,
        args: ["-Q", name],
        signal: this.#signal,
        maxDiagnosticBytes: MAX_PACKAGE_METADATA_BYTES,
      });
      repository = await this.#runner.run({
        executable: PACMAN_EXECUTABLE,
        args: ["-Si", name],
        signal: this.#signal,
        maxDiagnosticBytes: MAX_PACKAGE_METADATA_BYTES,
      });
    } catch {
      this.#throwIfAborted();
      return null;
    }
    this.#throwIfAborted();

    if (
      !repository.success || !boundedMetadata(repository)
    ) return null;
    const metadata = parseSyncInfo(repository.stdout, name);
    if (metadata === null) return null;

    let installedVersion: string | null = null;
    if (installed.success) {
      if (!boundedMetadata(installed)) return null;
      installedVersion = parseInstalledVersion(installed.stdout, name);
      if (installedVersion === null) return null;
    } else if (!boundedMetadata(installed)) {
      return null;
    }
    return {
      manager: "pacman",
      name,
      repository: metadata.repository,
      version: metadata.version,
      installedVersion,
      verified: true,
    };
  }

  #throwIfAborted(): void {
    if (this.#signal?.aborted) throw new ZigOperationAbortedError("verify Arch package metadata");
  }
}

export function archInstallCommand(
  hints: readonly VerifiedArchPackageHint[],
): DiagnosticCommandData | undefined {
  const packages = [
    ...new Set(
      hints.filter((hint) => hint.installedVersion !== hint.version).map((hint) => hint.name),
    ),
  ];
  if (packages.length === 0) return undefined;
  return {
    displayOnly: true,
    executable: "sudo",
    args: [PACMAN_EXECUTABLE, "-Syu", ...packages],
    warning: ARCH_INSTALL_WARNING,
  };
}

export function archPackageVersionAtLeast(version: string, minimum: string): boolean {
  const parsed = numericPackageVersion(version);
  if (parsed === null) return false;
  const left = parsed.split(".").map(Number);
  const right = minimum.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function parseInstalledVersion(output: string, expectedName: string): string | null {
  const lines = output.trim().split(/\r?\n/);
  if (lines.length !== 1) return null;
  const match = /^([^\s]+)\s+([^\s]+)$/.exec(lines[0]);
  return match?.[1] === expectedName ? match[2] : null;
}

function parseSyncInfo(
  output: string,
  expectedName: string,
): { readonly repository: string; readonly version: string } | null {
  const fields = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^([^:]+?)\s*:\s*(.*)$/.exec(line);
    if (match !== null) fields.set(match[1].trim(), match[2].trim());
  }
  const name = fields.get("Name");
  const version = fields.get("Version");
  const repository = fields.get("Repository");
  if (name !== expectedName || !version || !repository) return null;
  return { repository, version };
}

function numericPackageVersion(version: string): string | null {
  const withoutEpoch = version.includes(":") ? version.slice(version.indexOf(":") + 1) : version;
  return /^([0-9]+(?:\.[0-9]+)*)/.exec(withoutEpoch)?.[1] ?? null;
}

function boundedMetadata(result: ProcessResult): boolean {
  return !result.stdoutTruncated && !result.stderrTruncated &&
    new TextEncoder().encode(result.stdout).byteLength <= MAX_PACKAGE_METADATA_BYTES &&
    new TextEncoder().encode(result.stderr).byteLength <= MAX_PACKAGE_METADATA_BYTES;
}
