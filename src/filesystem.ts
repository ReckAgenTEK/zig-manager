import { dirname, isAbsolute, relative, resolve } from "@std/path";
import { ZigIoError, ZigPathOutsideRootError } from "./errors.ts";

const encoder = new TextEncoder();

export function isPathContained(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  const rel = relative(normalizedRoot, normalizedCandidate);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${separator()}`));
}

export function assertPathContained(root: string, candidate: string): string {
  const normalized = resolve(candidate);
  if (!isPathContained(root, normalized)) {
    throw new ZigPathOutsideRootError(resolve(root), normalized);
  }
  return normalized;
}

export function assertPathBelow(root: string, candidate: string): string {
  const normalizedRoot = resolve(root);
  const normalized = assertPathContained(normalizedRoot, candidate);
  if (normalized === normalizedRoot) throw new ZigPathOutsideRootError(normalizedRoot, normalized);
  return normalized;
}

export async function assertRealPathContained(root: string, candidate: string): Promise<void> {
  const realRoot = await Deno.realPath(root);
  let existing = resolve(candidate);
  while (true) {
    try {
      const realCandidate = await Deno.realPath(existing);
      assertPathContained(realRoot, realCandidate);
      return;
    } catch (cause) {
      if (!(cause instanceof Deno.errors.NotFound)) throw cause;
    }
    const parent = dirname(existing);
    if (parent === existing) throw new ZigPathOutsideRootError(realRoot, resolve(candidate));
    existing = parent;
  }
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) return false;
    throw new ZigIoError("inspect path", path, { cause });
  }
}

export async function atomicWriteText(path: string, text: string): Promise<void> {
  const parent = dirname(path);
  const temporary = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    await Deno.mkdir(parent, { recursive: true });
    const file = await Deno.open(temporary, { createNew: true, write: true, mode: 0o644 });
    try {
      await writeAll(file, encoder.encode(text));
      await file.sync();
    } finally {
      file.close();
    }
    await atomicReplacePath(temporary, path);
  } catch (cause) {
    await removeIfPresent(temporary);
    if (cause instanceof ZigIoError) throw cause;
    throw new ZigIoError("write file atomically", path, { cause });
  }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteText(path, `${canonicalJson(value, 2)}\n`);
}

export async function atomicReplaceDirectory(
  stagedPath: string,
  destination: string,
): Promise<void> {
  if (dirname(resolve(stagedPath)) !== dirname(resolve(destination))) {
    throw new ZigIoError("replace directory atomically", destination, {
      cause: new Error("staging and destination directories must be siblings"),
    });
  }
  try {
    const stat = await Deno.lstat(stagedPath);
    if (!stat.isDirectory) throw new Error("staged path is not a directory");
    await atomicReplacePath(stagedPath, destination);
  } catch (cause) {
    if (cause instanceof ZigIoError) throw cause;
    throw new ZigIoError("replace directory atomically", destination, { cause });
  }
}

export async function atomicPublishFile(stagedPath: string, destination: string): Promise<void> {
  if (dirname(resolve(stagedPath)) !== dirname(resolve(destination))) {
    throw new ZigIoError("publish file atomically", destination, {
      cause: new Error("staging and destination files must be siblings"),
    });
  }
  try {
    const stat = await Deno.lstat(stagedPath);
    if (!stat.isFile) throw new Error("staged path is not a regular file");
    await atomicReplacePath(stagedPath, destination);
  } catch (cause) {
    if (cause instanceof ZigIoError) throw cause;
    throw new ZigIoError("publish file atomically", destination, { cause });
  }
}

async function atomicReplacePath(stagedPath: string, destination: string): Promise<void> {
  if (!await pathExists(destination)) {
    await Deno.rename(stagedPath, destination);
    return;
  }

  try {
    await Deno.rename(stagedPath, destination);
    return;
  } catch (cause) {
    // Existing nonempty destinations map to different errno classes by platform.
    // Enter the backup path only when the destination survived the failed rename.
    if (!await pathExists(destination)) throw cause;
  }

  const backup = `${destination}.old-${crypto.randomUUID()}`;
  await Deno.rename(destination, backup);
  try {
    await Deno.rename(stagedPath, destination);
  } catch (cause) {
    try {
      await Deno.rename(backup, destination);
    } catch (restoreCause) {
      throw new ZigIoError("restore prior artifact after failed replacement", destination, {
        cause: new AggregateError([cause, restoreCause]),
      });
    }
    throw cause;
  }
  await removeIfPresent(backup, true);
}

export async function removeIfPresent(path: string, recursive = false): Promise<void> {
  try {
    await Deno.remove(path, { recursive });
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound)) {
      // Cleanup must not hide the operation that already succeeded or failed.
    }
  }
}

export function canonicalJson(value: unknown, space?: number): string {
  return JSON.stringify(canonicalize(value), null, space);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) result[key] = canonicalize(source[key]);
    }
    return result;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("canonical JSON cannot contain a non-finite number");
  }
  return value;
}

export function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const hash = new Sha256();
  hash.update(bytes);
  return Promise.resolve(bytesToHex(hash.digest()));
}

export async function sha256Text(text: string): Promise<string> {
  return await sha256Bytes(encoder.encode(text));
}

export async function sha256File(path: string): Promise<string> {
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch (cause) {
    throw new ZigIoError("open file for hashing", path, { cause });
  }
  try {
    const hash = new Sha256();
    const buffer = new Uint8Array(1024 * 1024);
    while (true) {
      const count = await file.read(buffer);
      if (count === null) break;
      hash.update(buffer.subarray(0, count));
    }
    return bytesToHex(hash.digest());
  } finally {
    file.close();
  }
}

export async function fileMetadata(
  path: string,
): Promise<{ readonly size: number; readonly sha256: string }> {
  try {
    const stat = await Deno.stat(path);
    if (!stat.isFile) throw new Error("path is not a regular file");
    if (!Number.isSafeInteger(stat.size)) throw new Error("file size is not safely representable");
    return { size: stat.size, sha256: await sha256File(path) };
  } catch (cause) {
    if (cause instanceof ZigIoError) throw cause;
    throw new ZigIoError("inspect file", path, { cause });
  }
}

async function writeAll(file: Deno.FsFile, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) offset += await file.write(bytes.subarray(offset));
}

function separator(): string {
  return Deno.build.os === "windows" ? "\\" : "/";
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const SHA256_K = new Uint32Array([
  0x428a2f98,
  0x71374491,
  0xb5c0fbcf,
  0xe9b5dba5,
  0x3956c25b,
  0x59f111f1,
  0x923f82a4,
  0xab1c5ed5,
  0xd807aa98,
  0x12835b01,
  0x243185be,
  0x550c7dc3,
  0x72be5d74,
  0x80deb1fe,
  0x9bdc06a7,
  0xc19bf174,
  0xe49b69c1,
  0xefbe4786,
  0x0fc19dc6,
  0x240ca1cc,
  0x2de92c6f,
  0x4a7484aa,
  0x5cb0a9dc,
  0x76f988da,
  0x983e5152,
  0xa831c66d,
  0xb00327c8,
  0xbf597fc7,
  0xc6e00bf3,
  0xd5a79147,
  0x06ca6351,
  0x14292967,
  0x27b70a85,
  0x2e1b2138,
  0x4d2c6dfc,
  0x53380d13,
  0x650a7354,
  0x766a0abb,
  0x81c2c92e,
  0x92722c85,
  0xa2bfe8a1,
  0xa81a664b,
  0xc24b8b70,
  0xc76c51a3,
  0xd192e819,
  0xd6990624,
  0xf40e3585,
  0x106aa070,
  0x19a4c116,
  0x1e376c08,
  0x2748774c,
  0x34b0bcb5,
  0x391c0cb3,
  0x4ed8aa4a,
  0x5b9cca4f,
  0x682e6ff3,
  0x748f82ee,
  0x78a5636f,
  0x84c87814,
  0x8cc70208,
  0x90befffa,
  0xa4506ceb,
  0xbef9a3f7,
  0xc67178f2,
]);

class Sha256 {
  readonly #state = new Uint32Array([
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
  ]);
  readonly #buffer = new Uint8Array(64);
  #bufferLength = 0;
  #bytesHashed = 0n;
  #finished = false;

  update(data: Uint8Array): void {
    if (this.#finished) throw new TypeError("SHA-256 digest is already finalized");
    this.#bytesHashed += BigInt(data.length);
    let offset = 0;
    if (this.#bufferLength > 0) {
      const count = Math.min(64 - this.#bufferLength, data.length);
      this.#buffer.set(data.subarray(0, count), this.#bufferLength);
      this.#bufferLength += count;
      offset += count;
      if (this.#bufferLength === 64) {
        this.#compress(this.#buffer);
        this.#bufferLength = 0;
      }
    }
    while (offset + 64 <= data.length) {
      this.#compress(data.subarray(offset, offset + 64));
      offset += 64;
    }
    if (offset < data.length) {
      this.#buffer.set(data.subarray(offset), 0);
      this.#bufferLength = data.length - offset;
    }
  }

  digest(): Uint8Array {
    if (this.#finished) throw new TypeError("SHA-256 digest is already finalized");
    this.#finished = true;
    const finalBlocks = new Uint8Array(this.#bufferLength < 56 ? 64 : 128);
    finalBlocks.set(this.#buffer.subarray(0, this.#bufferLength));
    finalBlocks[this.#bufferLength] = 0x80;
    const bitLength = BigInt.asUintN(64, this.#bytesHashed * 8n);
    for (let index = 0; index < 8; index++) {
      finalBlocks[finalBlocks.length - 1 - index] = Number(
        (bitLength >> BigInt(index * 8)) & 0xffn,
      );
    }
    for (let offset = 0; offset < finalBlocks.length; offset += 64) {
      this.#compress(finalBlocks.subarray(offset, offset + 64));
    }
    const output = new Uint8Array(32);
    const view = new DataView(output.buffer);
    for (let index = 0; index < 8; index++) view.setUint32(index * 4, this.#state[index]);
    return output;
  }

  #compress(block: Uint8Array): void {
    const words = new Uint32Array(64);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    for (let index = 0; index < 16; index++) words[index] = view.getUint32(index * 4);
    for (let index = 16; index < 64; index++) {
      const a = words[index - 15];
      const b = words[index - 2];
      const sigma0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3);
      const sigma1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }
    let a = this.#state[0];
    let b = this.#state[1];
    let c = this.#state[2];
    let d = this.#state[3];
    let e = this.#state[4];
    let f = this.#state[5];
    let g = this.#state[6];
    let h = this.#state[7];
    for (let index = 0; index < 64; index++) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choose + SHA256_K[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    this.#state[0] = (this.#state[0] + a) >>> 0;
    this.#state[1] = (this.#state[1] + b) >>> 0;
    this.#state[2] = (this.#state[2] + c) >>> 0;
    this.#state[3] = (this.#state[3] + d) >>> 0;
    this.#state[4] = (this.#state[4] + e) >>> 0;
    this.#state[5] = (this.#state[5] + f) >>> 0;
    this.#state[6] = (this.#state[6] + g) >>> 0;
    this.#state[7] = (this.#state[7] + h) >>> 0;
  }
}

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}
