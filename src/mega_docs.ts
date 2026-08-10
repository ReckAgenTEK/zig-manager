import { join } from "@std/path";
import { MEGA_FORMAT_VERSION, SUPPORTED_DOCS_ASSET_CONTRACT } from "./constants.ts";
import { MegaDocsUnsupportedFormatError, ZigOperationAbortedError } from "./errors.ts";
import { atomicPublishFile, canonicalJson, fileMetadata, removeIfPresent } from "./filesystem.ts";
import type { DocsArtifact, MegaDocsRecord } from "./types.ts";

export interface MegaDocsOptions {
  readonly docsRoot: string;
  readonly version: string;
  readonly commit: string;
  readonly artifacts: readonly DocsArtifact[];
  readonly signal?: AbortSignal;
}

const SCRIPT_MARKER = SUPPORTED_DOCS_ASSET_CONTRACT.indexScriptTag;
const WASM_ID = "zig-manager-main-wasm";
const SOURCES_ID = "zig-manager-sources-tar";
const BASE64_TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export async function buildMegaDocs(options: MegaDocsOptions): Promise<MegaDocsRecord> {
  if (options.signal?.aborted) throw new ZigOperationAbortedError("mega docs");
  const langrefPath = join(options.docsRoot, "langref.html");
  const stdRoot = join(options.docsRoot, "std");
  const indexPath = join(stdRoot, "index.html");
  const mainJsPath = join(stdRoot, "main.js");
  const wasmPath = join(stdRoot, "main.wasm");
  const sourcesPath = join(stdRoot, "sources.tar");
  const [langref, index, mainJs] = await Promise.all([
    Deno.readTextFile(langrefPath),
    Deno.readTextFile(indexPath),
    Deno.readTextFile(mainJsPath),
  ]);
  validateAssetContract(index, mainJs);
  await validateBinaryContract(wasmPath, sourcesPath);

  const outputName = `zig-${safeVersion(options.version)}-all.html`;
  const outputPath = join(options.docsRoot, outputName);
  const temporary = `${outputPath}.tmp`;
  let file: Deno.FsFile | null = null;
  let temporaryCreated = false;
  try {
    file = await Deno.open(temporary, { createNew: true, write: true, mode: 0o644 });
    temporaryCreated = true;
    const markerIndex = index.indexOf(SCRIPT_MARKER);
    const indexBefore = index.slice(0, markerIndex);
    const indexAfter = index.slice(markerIndex + SCRIPT_MARKER.length);
    const provenance = canonicalJson({
      formatVersion: MEGA_FORMAT_VERSION,
      assetContract: SUPPORTED_DOCS_ASSET_CONTRACT.id,
      version: options.version,
      commit: options.commit,
      artifacts: options.artifacts,
    });
    await writeText(file, outerPrefix(options.version, options.commit, provenance));
    await writeText(file, escapeHtmlAttribute(langref));
    await writeText(file, '"></iframe><iframe id="standard" title="Zig Standard Library" srcdoc="');
    await writeText(file, escapeHtmlAttribute(indexBefore));
    await writeText(
      file,
      escapeHtmlAttribute(`<script type="application/octet-stream" id="${WASM_ID}">`),
    );
    await streamBase64(wasmPath, file, options.signal);
    await writeText(
      file,
      escapeHtmlAttribute(`</script><script type="application/octet-stream" id="${SOURCES_ID}">`),
    );
    await streamBase64(sourcesPath, file, options.signal);
    await writeText(
      file,
      escapeHtmlAttribute(
        `</script><script>${assetInterceptor()}</script><script>${mainJs}</script>`,
      ),
    );
    await writeText(file, escapeHtmlAttribute(indexAfter));
    await writeText(file, outerSuffix());
    await file.sync();
    file.close();
    file = null;
    await atomicPublishFile(temporary, outputPath);
  } catch (cause) {
    if (file !== null) file.close();
    if (temporaryCreated) await removeIfPresent(temporary);
    if (cause instanceof MegaDocsUnsupportedFormatError) throw cause;
    throw cause;
  }
  const metadata = await fileMetadata(outputPath);
  return {
    formatVersion: MEGA_FORMAT_VERSION,
    assetContract: SUPPORTED_DOCS_ASSET_CONTRACT.id,
    path: outputName,
    sha256: metadata.sha256,
    size: metadata.size,
  };
}

export function validateAssetContract(index: string, mainJs: string): void {
  if (count(index, SCRIPT_MARKER) !== 1) {
    throw new MegaDocsUnsupportedFormatError(
      "standard index must contain exactly one official main.js script tag",
    );
  }
  const scriptSources = [...index.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)]
    .map((match) => match[1]);
  if (scriptSources.length !== 1 || scriptSources[0] !== "main.js") {
    throw new MegaDocsUnsupportedFormatError(
      "standard index has an unsupported runtime script asset",
      { scriptSources },
    );
  }
  const runtimeAttributes = [...index.matchAll(/\b(src|href)\s*=\s*["']([^"']+)["']/gi)]
    .map((match) => ({ attribute: match[1].toLowerCase(), value: match[2] }));
  for (const asset of runtimeAttributes) {
    const supported = asset.attribute === "src"
      ? asset.value === "main.js"
      : asset.value.startsWith("#") || asset.value.startsWith("data:");
    if (!supported) {
      throw new MegaDocsUnsupportedFormatError(
        "standard index contains an unsupported runtime asset URL",
        { asset },
      );
    }
  }
  for (const match of index.matchAll(/\burl\(\s*["']?([^)'"\s]+)["']?\s*\)/gi)) {
    if (!match[1].startsWith("data:")) {
      throw new MegaDocsUnsupportedFormatError(
        "standard index CSS contains an unsupported runtime asset URL",
        { url: match[1] },
      );
    }
  }
  if (/@import\b/i.test(index)) {
    throw new MegaDocsUnsupportedFormatError("standard index contains an external CSS import");
  }
  if (/<\s*\/\s*script/i.test(mainJs)) {
    throw new MegaDocsUnsupportedFormatError(
      "main.js cannot be safely inlined because it contains a script closing tag",
    );
  }
  if (count(mainJs, SUPPORTED_DOCS_ASSET_CONTRACT.wasmFetch) !== 1) {
    throw new MegaDocsUnsupportedFormatError(
      "main.js does not contain the expected main.wasm fetch",
    );
  }
  if (count(mainJs, SUPPORTED_DOCS_ASSET_CONTRACT.sourcesFetch) !== 1) {
    throw new MegaDocsUnsupportedFormatError(
      "main.js does not contain the expected sources.tar fetch",
    );
  }
  const fetchCalls = [...mainJs.matchAll(/\bfetch\s*\(/g)];
  if (fetchCalls.length !== 2) {
    throw new MegaDocsUnsupportedFormatError(
      "main.js contains unsupported additional fetch calls",
      {
        fetchCount: fetchCalls.length,
      },
    );
  }
}

export function escapeHtmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replaceAll('"', "&quot;");
}

async function validateBinaryContract(wasmPath: string, sourcesPath: string): Promise<void> {
  const wasm = await Deno.open(wasmPath, { read: true });
  try {
    const header = new Uint8Array(8);
    let offset = 0;
    while (offset < header.length) {
      const count = await wasm.read(header.subarray(offset));
      if (count === null) break;
      offset += count;
    }
    const expected = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
    if (offset !== 8 || !expected.every((value, index) => header[index] === value)) {
      throw new MegaDocsUnsupportedFormatError("main.wasm does not have the WebAssembly v1 header");
    }
  } finally {
    wasm.close();
  }
  const sources = await Deno.stat(sourcesPath);
  if (!sources.isFile || sources.size < 512 || sources.size % 512 !== 0) {
    throw new MegaDocsUnsupportedFormatError(
      "sources.tar is not a nonempty block-aligned tar archive",
    );
  }
}

async function streamBase64(
  path: string,
  output: Deno.FsFile,
  signal?: AbortSignal,
): Promise<void> {
  const input = await Deno.open(path, { read: true });
  const buffer = new Uint8Array(192 * 1024);
  try {
    while (true) {
      if (signal?.aborted) throw new ZigOperationAbortedError("mega docs");
      let length = 0;
      while (length < buffer.length) {
        const count = await input.read(buffer.subarray(length));
        if (count === null) break;
        length += count;
      }
      if (length === 0) break;
      await writeText(output, encodeBase64(buffer.subarray(0, length)));
      if (length < buffer.length) break;
    }
  } finally {
    input.close();
  }
}

export function encodeBase64(bytes: Uint8Array): string {
  let result = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index];
    const hasB = index + 1 < bytes.length;
    const hasC = index + 2 < bytes.length;
    const b = hasB ? bytes[index + 1] : 0;
    const c = hasC ? bytes[index + 2] : 0;
    result += BASE64_TABLE[a >>> 2];
    result += BASE64_TABLE[((a & 0x03) << 4) | (b >>> 4)];
    result += hasB ? BASE64_TABLE[((b & 0x0f) << 2) | (c >>> 6)] : "=";
    result += hasC ? BASE64_TABLE[c & 0x3f] : "=";
  }
  return result;
}

function assetInterceptor(): string {
  return `(()=>{const original=window.fetch.bind(window);const bytes=(id)=>{const raw=document.getElementById(id).textContent;const binary=atob(raw);const value=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)value[i]=binary.charCodeAt(i);return value};window.fetch=(input,init)=>{if(input==="main.wasm")return Promise.resolve(new Response(bytes("${WASM_ID}"),{status:200,headers:{"Content-Type":"application/wasm"}}));if(input==="sources.tar")return Promise.resolve(new Response(bytes("${SOURCES_ID}"),{status:200,headers:{"Content-Type":"application/x-tar"}}));return original(input,init)}})();`;
}

function outerPrefix(version: string, commit: string, provenance: string): string {
  const safeVersionText = escapeHtmlText(version);
  const safeCommit = escapeHtmlText(commit);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Zig ${safeVersionText} complete documentation</title><style>html,body{height:100%;margin:0;background:#111;color:#eee;font-family:system-ui,sans-serif}header{height:4rem;display:flex;align-items:center;gap:1rem;padding:0 1rem;border-bottom:1px solid #3d3d3d;box-sizing:border-box}header strong{color:#f7a41d}nav{display:flex;gap:.5rem;margin-left:auto}button{border:1px solid #777;background:#222;color:#eee;padding:.55rem .9rem;cursor:pointer}button[aria-pressed="true"]{border-color:#f7a41d;color:#f7a41d}iframe{width:100%;height:calc(100% - 4rem);border:0;background:white;display:none}iframe.active{display:block}.commit{font:12px ui-monospace,monospace;color:#aaa;overflow:hidden;text-overflow:ellipsis}</style></head><body><header><strong>Zig ${safeVersionText}</strong><span class="commit">commit ${safeCommit}</span><nav><button id="show-language" aria-pressed="true">Language Reference</button><button id="show-standard" aria-pressed="false">Standard Library</button></nav></header><script type="application/json" id="zig-manager-provenance">${
    escapeScriptData(provenance)
  }</script><iframe class="active" id="language" title="Zig Language Reference" srcdoc="`;
}

function outerSuffix(): string {
  return `"></iframe><script>(()=>{const language=document.getElementById("language");const standard=document.getElementById("standard");const languageButton=document.getElementById("show-language");const standardButton=document.getElementById("show-standard");const show=(selected)=>{const lang=selected==="language";language.classList.toggle("active",lang);standard.classList.toggle("active",!lang);languageButton.setAttribute("aria-pressed",String(lang));standardButton.setAttribute("aria-pressed",String(!lang))};languageButton.addEventListener("click",()=>show("language"));standardButton.addEventListener("click",()=>show("standard"))})()</script></body></html>`;
}

function escapeScriptData(value: string): string {
  return value.replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}

function safeVersion(version: string): string {
  if (
    !/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
      .test(
        version,
      )
  ) {
    throw new MegaDocsUnsupportedFormatError("Zig version is not valid semantic version text", {
      version,
    });
  }
  return version;
}

function count(text: string, needle: string): number {
  let result = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(needle, offset);
    if (index < 0) return result;
    result++;
    offset = index + needle.length;
  }
}

async function writeText(file: Deno.FsFile, text: string): Promise<void> {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  while (offset < bytes.length) offset += await file.write(bytes.subarray(offset));
}
