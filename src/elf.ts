export const ELF_MACHINE_X86_64 = 62;

const ELF_HEADER_SIZE = 64;
const PROGRAM_HEADER_SIZE_64 = 56;
const MAX_PROGRAM_HEADERS = 1024;
const MAX_INTERPRETER_BYTES = 4096;

export interface Elf64X86_64Info {
  readonly format: "elf";
  readonly class: 64;
  readonly endianness: "little";
  readonly machine: "x86_64";
  readonly type: "executable" | "shared";
  readonly dynamicallyLinked: boolean;
  readonly interpreter: string | null;
}

/** Parse only the bounded ELF header/program-header data needed by install verification. */
export async function inspectElf64X86_64(path: string): Promise<Elf64X86_64Info> {
  const file = await Deno.open(path, { read: true });
  try {
    const stat = await file.stat();
    if (!stat.isFile || stat.size < ELF_HEADER_SIZE) {
      throw new TypeError("file is not a complete ELF header");
    }
    const header = await readExactlyAt(file, 0, ELF_HEADER_SIZE);
    if (header[0] !== 0x7f || header[1] !== 0x45 || header[2] !== 0x4c || header[3] !== 0x46) {
      throw new TypeError("file does not have ELF magic");
    }
    if (header[4] !== 2) throw new TypeError("ELF file is not 64-bit");
    if (header[5] !== 1) throw new TypeError("ELF file is not little-endian");
    if (header[6] !== 1) throw new TypeError("ELF identification version is invalid");
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const typeValue = view.getUint16(16, true);
    const type = typeValue === 2 ? "executable" : typeValue === 3 ? "shared" : null;
    if (type === null) {
      throw new TypeError("ELF file is not an executable or position-independent executable");
    }
    if (view.getUint16(18, true) !== ELF_MACHINE_X86_64) {
      throw new TypeError("ELF machine is not x86_64");
    }
    if (view.getUint32(20, true) !== 1) throw new TypeError("ELF version is invalid");
    const programOffset = safeNumber(view.getBigUint64(32, true), "ELF program header offset");
    const entrySize = view.getUint16(54, true);
    const entryCount = view.getUint16(56, true);
    if (entryCount > MAX_PROGRAM_HEADERS) throw new TypeError("ELF has too many program headers");
    if (entryCount > 0 && entrySize < PROGRAM_HEADER_SIZE_64) {
      throw new TypeError("ELF program header entries are too small");
    }
    const tableEnd = programOffset + entrySize * entryCount;
    if (!Number.isSafeInteger(tableEnd) || tableEnd > stat.size) {
      throw new TypeError("ELF program header table is outside the file");
    }

    let dynamicallyLinked = false;
    let interpreter: string | null = null;
    for (let index = 0; index < entryCount; index++) {
      const entry = await readExactlyAt(
        file,
        programOffset + index * entrySize,
        PROGRAM_HEADER_SIZE_64,
      );
      const entryView = new DataView(entry.buffer, entry.byteOffset, entry.byteLength);
      const programType = entryView.getUint32(0, true);
      if (programType === 2) dynamicallyLinked = true;
      if (programType !== 3) continue;
      if (interpreter !== null) throw new TypeError("ELF reports more than one interpreter");
      const offset = safeNumber(entryView.getBigUint64(8, true), "ELF interpreter offset");
      const size = safeNumber(entryView.getBigUint64(32, true), "ELF interpreter size");
      if (size < 2 || size > MAX_INTERPRETER_BYTES || offset + size > stat.size) {
        throw new TypeError("ELF interpreter record is invalid or unbounded");
      }
      const bytes = await readExactlyAt(file, offset, size);
      if (bytes.at(-1) !== 0 || bytes.slice(0, -1).includes(0)) {
        throw new TypeError("ELF interpreter is not one canonical NUL-terminated path");
      }
      interpreter = new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(0, -1));
      if (
        !interpreter.startsWith("/") || interpreter.includes("\n") || interpreter.includes("\r")
      ) {
        throw new TypeError("ELF interpreter is not an absolute path");
      }
    }
    return {
      format: "elf",
      class: 64,
      endianness: "little",
      machine: "x86_64",
      type,
      dynamicallyLinked,
      interpreter,
    };
  } finally {
    file.close();
  }
}

async function readExactlyAt(
  file: Deno.FsFile,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  await file.seek(offset, Deno.SeekMode.Start);
  const bytes = new Uint8Array(length);
  let read = 0;
  while (read < length) {
    const count = await file.read(bytes.subarray(read));
    if (count === null) throw new TypeError("ELF data ended unexpectedly");
    read += count;
  }
  return bytes;
}

function safeNumber(value: bigint, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new TypeError(`${label} is unsafe`);
  return result;
}
