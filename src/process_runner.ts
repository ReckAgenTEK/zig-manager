import { DEFAULT_MAX_DIAGNOSTIC_BYTES } from "./constants.ts";
import { ZigOperationAbortedError, ZigProcessError } from "./errors.ts";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "./types.ts";

export interface DenoProcessRunnerOptions {
  readonly terminationGraceMs?: number;
}

export class DenoProcessRunner implements ProcessRunner {
  readonly #terminationGraceMs: number;

  constructor(options: DenoProcessRunnerOptions = {}) {
    const grace = options.terminationGraceMs ?? 2_000;
    if (!Number.isSafeInteger(grace) || grace < 0) {
      throw new TypeError("terminationGraceMs must be a nonnegative integer");
    }
    this.#terminationGraceMs = grace;
  }

  async run(request: ProcessRequest): Promise<ProcessResult> {
    validateRequest(request);
    throwIfAborted(request);
    let child: Deno.ChildProcess;
    try {
      child = new Deno.Command(request.executable, {
        args: [...request.args],
        cwd: request.cwd,
        env: request.env ? { ...request.env } : undefined,
        clearEnv: request.clearEnv ?? false,
        stdin: request.stdin ?? "null",
        stdout: "piped",
        stderr: "piped",
      }).spawn();
    } catch (cause) {
      if (request.signal?.aborted) throw abortedError(request);
      throw new ZigProcessError(request.executable, errorMessage(cause), { cause });
    }

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let terminationRequested = false;
    let terminationSignal: Deno.Signal = "SIGTERM";
    const abort = () => {
      if (terminationRequested) return;
      terminationRequested = true;
      terminationSignal = request.signal?.reason === "SIGINT" ? "SIGINT" : "SIGTERM";
      try {
        child.kill(terminationSignal);
      } catch {
        // The process may have exited between the abort and kill calls.
      }
      killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // The process exited during the termination grace period.
        }
      }, this.#terminationGraceMs);
    };
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted) abort();

    const max = request.maxDiagnosticBytes ?? DEFAULT_MAX_DIAGNOSTIC_BYTES;
    const stdout = consume(child.stdout, max, request.onStdout);
    const stderr = consume(child.stderr, max, request.onStderr);
    try {
      const [status, stdoutCapture, stderrCapture] = await Promise.all([
        child.status,
        stdout,
        stderr,
      ]);
      if (terminationRequested || request.signal?.aborted) throw abortedError(request);
      return {
        success: status.success,
        code: status.code,
        signal: status.signal,
        stdout: stdoutCapture.text,
        stderr: stderrCapture.text,
        stdoutTruncated: stdoutCapture.truncated,
        stderrTruncated: stderrCapture.truncated,
      };
    } catch (cause) {
      if (cause instanceof ZigOperationAbortedError) throw cause;
      if (terminationRequested || request.signal?.aborted) throw abortedError(request, cause);
      throw new ZigProcessError(request.executable, errorMessage(cause), { cause });
    } finally {
      if (killTimer !== undefined) clearTimeout(killTimer);
      request.signal?.removeEventListener("abort", abort);
    }
  }
}

function throwIfAborted(request: ProcessRequest): void {
  if (request.signal?.aborted) throw abortedError(request);
}

function abortedError(request: ProcessRequest, cause?: unknown): ZigOperationAbortedError {
  const reason = request.signal?.reason;
  return new ZigOperationAbortedError(
    `process ${request.executable}`,
    { signal: reason === "SIGINT" ? "SIGINT" : "SIGTERM" },
    { cause: cause ?? reason },
  );
}

interface Capture {
  readonly text: string;
  readonly truncated: boolean;
}

async function consume(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  callback?: (chunk: Uint8Array) => void | Promise<void>,
): Promise<Capture> {
  const chunks: Uint8Array[] = [];
  let captured = 0;
  let truncated = false;
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (callback) await callback(value);
      if (captured < maxBytes) {
        const remaining = maxBytes - captured;
        const kept = value.length <= remaining ? value.slice() : value.slice(0, remaining);
        chunks.push(kept);
        captured += kept.length;
        if (kept.length !== value.length) truncated = true;
      } else {
        truncated = true;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(captured);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { text: new TextDecoder().decode(bytes), truncated };
}

function validateRequest(request: ProcessRequest): void {
  if (request.executable.length === 0) throw new TypeError("process executable must not be empty");
  if (request.executable.includes("\0")) {
    throw new TypeError("process executable contains a NUL byte");
  }
  for (const arg of request.args) {
    if (arg.includes("\0")) throw new TypeError("process argument contains a NUL byte");
  }
  const max = request.maxDiagnosticBytes ?? DEFAULT_MAX_DIAGNOSTIC_BYTES;
  if (!Number.isSafeInteger(max) || max < 0) {
    throw new TypeError("maxDiagnosticBytes must be a nonnegative integer");
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
