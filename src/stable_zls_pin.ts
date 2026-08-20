import { dirname, isAbsolute, join, resolve } from "@std/path";
import { ZigOperationAbortedError, ZlsStablePinInvalidError } from "./errors.ts";
import { atomicWriteText } from "./filesystem.ts";
import { validateInstallationId } from "./install_store.ts";

export const STABLE_ZLS_PIN_SCHEMA_VERSION = 1;
const MAXIMUM_PIN_BYTES = 512;
const PIN_FILE = /^([0-9a-f]{64})\.json$/;

export interface StableZlsPinV1 {
  readonly schemaVersion: typeof STABLE_ZLS_PIN_SCHEMA_VERSION;
  readonly zigInstallationId: string;
  readonly zlsInstallationId: string;
}

export interface StoredStableZlsPin extends StableZlsPinV1 {
  readonly pinPath: string;
}

export interface StableZlsPinMutationOptions {
  readonly signal?: AbortSignal;
  readonly operationId?: string;
}

/** One manager-wide stable ZLS preference per exact immutable Zig installation. */
export class StableZlsPinStore {
  readonly root: string;

  constructor(root: string) {
    if (!isAbsolute(root) || resolve(root) === "/") {
      throw new TypeError("stable ZLS pin root must be an absolute non-root path");
    }
    this.root = resolve(root);
  }

  async read(zigInstallationIdValue: string): Promise<StoredStableZlsPin | null> {
    const zigInstallationId = validateInstallationId(
      zigInstallationIdValue,
      "zigInstallationId",
    );
    const pinPath = this.#pinPath(zigInstallationId);
    try {
      const rootInfo = await lstatIfPresent(this.root);
      if (rootInfo === null) return null;
      assertPhysicalDirectory(rootInfo);

      const info = await lstatIfPresent(pinPath);
      if (info === null) return null;
      assertPhysicalFile(info);
      if (info.size > MAXIMUM_PIN_BYTES) {
        throw new TypeError(`pin exceeds ${MAXIMUM_PIN_BYTES} bytes`);
      }
      const pin = parseStableZlsPin(await Deno.readTextFile(pinPath), pinPath);
      if (pin.zigInstallationId !== zigInstallationId) {
        throw new TypeError("zigInstallationId does not match pin filename");
      }
      return { ...pin, pinPath };
    } catch (cause) {
      if (cause instanceof ZlsStablePinInvalidError) throw cause;
      throw new ZlsStablePinInvalidError(pinPath, errorMessage(cause), { cause });
    }
  }

  async write(
    zigInstallationIdValue: string,
    zlsInstallationIdValue: string,
    options: StableZlsPinMutationOptions = {},
  ): Promise<StoredStableZlsPin> {
    const pin = validateStableZlsPin({
      schemaVersion: STABLE_ZLS_PIN_SCHEMA_VERSION,
      zigInstallationId: zigInstallationIdValue,
      zlsInstallationId: zlsInstallationIdValue,
    });
    const pinPath = this.#pinPath(pin.zigInstallationId);
    try {
      await ensurePhysicalDirectory(this.root);
      const current = await lstatIfPresent(pinPath);
      if (current !== null) assertPhysicalFile(current);
      await atomicWriteText(pinPath, `${JSON.stringify(pin, null, 2)}\n`, options);
      const published = await this.read(pin.zigInstallationId);
      if (published === null) throw new TypeError("pin disappeared after atomic publication");
      if (published.zlsInstallationId !== pin.zlsInstallationId) {
        throw new TypeError("pin changed during atomic publication");
      }
      return published;
    } catch (cause) {
      if (cause instanceof ZigOperationAbortedError) throw cause;
      if (cause instanceof ZlsStablePinInvalidError) throw cause;
      throw new ZlsStablePinInvalidError(pinPath, "pin could not be written atomically", {
        cause,
      });
    }
  }

  async list(): Promise<readonly StoredStableZlsPin[]> {
    try {
      const rootInfo = await lstatIfPresent(this.root);
      if (rootInfo === null) return [];
      assertPhysicalDirectory(rootInfo);
      const zigInstallationIds: string[] = [];
      for await (const entry of Deno.readDir(this.root)) {
        const match = PIN_FILE.exec(entry.name);
        if (match === null) continue;
        if (!entry.isFile || entry.isSymlink) {
          throw new ZlsStablePinInvalidError(
            join(this.root, entry.name),
            "pin is not a physical regular file",
          );
        }
        zigInstallationIds.push(match[1]);
      }
      zigInstallationIds.sort();
      const pins: StoredStableZlsPin[] = [];
      for (const zigInstallationId of zigInstallationIds) {
        const pin = await this.read(zigInstallationId);
        if (pin === null) {
          throw new ZlsStablePinInvalidError(
            this.#pinPath(zigInstallationId),
            "pin disappeared during enumeration",
          );
        }
        pins.push(pin);
      }
      return pins;
    } catch (cause) {
      if (cause instanceof ZlsStablePinInvalidError) throw cause;
      throw new ZlsStablePinInvalidError(this.root, errorMessage(cause), { cause });
    }
  }

  async removeReferences(
    component: "zig" | "zls",
    installationIdValue: string,
    options: StableZlsPinMutationOptions = {},
  ): Promise<readonly StoredStableZlsPin[]> {
    const installationId = validateInstallationId(installationIdValue);
    const candidates = component === "zig"
      ? [await this.read(installationId)].filter(
        (pin): pin is StoredStableZlsPin => pin !== null,
      )
      : (await this.list()).filter((pin) => pin.zlsInstallationId === installationId);
    for (const pin of candidates) {
      throwIfAborted(options.signal, "remove stable ZLS pin", pin.pinPath);
      try {
        const current = await this.read(pin.zigInstallationId);
        if (
          current === null ||
          current.zlsInstallationId !== pin.zlsInstallationId
        ) {
          throw new TypeError("pin changed before removal");
        }
        await Deno.remove(pin.pinPath);
      } catch (cause) {
        if (cause instanceof ZigOperationAbortedError) throw cause;
        if (cause instanceof ZlsStablePinInvalidError) throw cause;
        throw new ZlsStablePinInvalidError(pin.pinPath, "pin could not be removed safely", {
          cause,
        });
      }
    }
    return candidates;
  }

  #pinPath(zigInstallationId: string): string {
    const path = join(this.root, `${zigInstallationId}.json`);
    if (dirname(path) !== this.root) {
      throw new ZlsStablePinInvalidError(path, "pin path escapes its managed root");
    }
    return path;
  }
}

export function parseStableZlsPin(
  text: string,
  path = "<stable-zls-pin>",
): StableZlsPinV1 {
  try {
    if (new TextEncoder().encode(text).byteLength > MAXIMUM_PIN_BYTES) {
      throw new TypeError(`pin exceeds ${MAXIMUM_PIN_BYTES} bytes`);
    }
    return validateStableZlsPin(JSON.parse(text));
  } catch (cause) {
    if (cause instanceof ZlsStablePinInvalidError) throw cause;
    throw new ZlsStablePinInvalidError(path, errorMessage(cause), { cause });
  }
}

export function validateStableZlsPin(value: unknown): StableZlsPinV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("pin must be an object");
  }
  const root = value as Record<string, unknown>;
  const keys = Object.keys(root).sort();
  const expected = ["schemaVersion", "zigInstallationId", "zlsInstallationId"].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new TypeError(`pin keys must be exactly ${expected.join(", ")}`);
  }
  if (root.schemaVersion !== STABLE_ZLS_PIN_SCHEMA_VERSION) {
    throw new TypeError(`schemaVersion must be ${STABLE_ZLS_PIN_SCHEMA_VERSION}`);
  }
  return {
    schemaVersion: STABLE_ZLS_PIN_SCHEMA_VERSION,
    zigInstallationId: validateInstallationId(
      root.zigInstallationId,
      "zigInstallationId",
    ),
    zlsInstallationId: validateInstallationId(
      root.zlsInstallationId,
      "zlsInstallationId",
    ),
  };
}

async function ensurePhysicalDirectory(path: string): Promise<void> {
  let info = await lstatIfPresent(path);
  if (info === null) {
    try {
      await Deno.mkdir(path, { recursive: true, mode: 0o700 });
    } catch (cause) {
      if (!(cause instanceof Deno.errors.AlreadyExists)) throw cause;
    }
    info = await lstatIfPresent(path);
  }
  if (info === null) throw new TypeError("stable ZLS pin root is missing");
  assertPhysicalDirectory(info);
}

function assertPhysicalDirectory(info: Deno.FileInfo): void {
  if (!info.isDirectory || info.isSymlink) {
    throw new TypeError("stable ZLS pin root is not a physical directory");
  }
}

function assertPhysicalFile(info: Deno.FileInfo): void {
  if (!info.isFile || info.isSymlink) {
    throw new TypeError("stable ZLS pin is not a physical regular file");
  }
}

async function lstatIfPresent(path: string): Promise<Deno.FileInfo | null> {
  try {
    return await Deno.lstat(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return null;
    throw cause;
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function throwIfAborted(
  signal: AbortSignal | undefined,
  operation: string,
  path: string,
): void {
  if (signal?.aborted) {
    throw new ZigOperationAbortedError(operation, { path }, { cause: signal.reason });
  }
}
