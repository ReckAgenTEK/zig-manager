import { MINIMUM_GIT_VERSION as SOURCE_REF_MINIMUM_GIT_VERSION } from "@source-ref/source-ref";

export const ZIG_MANAGER_VERSION = "0.0.0";

export const CONFIG_SCHEMA_VERSION = 1 as const;
export const STATE_SCHEMA_VERSION = 2 as const;
export const BUILD_MANIFEST_SCHEMA_VERSION = 2 as const;
export const DOCS_MANIFEST_SCHEMA_VERSION = 2 as const;
export const CLI_JSON_SCHEMA_VERSION = 2 as const;
export const MEGA_FORMAT_VERSION = 1 as const;

export const MINIMUM_DENO_VERSION = "2.0.0";
export const MINIMUM_GIT_VERSION = SOURCE_REF_MINIMUM_GIT_VERSION;
export const MINIMUM_CMAKE_VERSION = "3.15.0";
export const MINIMUM_FREE_DISK_BYTES = 20 * 1024 * 1024 * 1024;

export const INITIAL_ZIG_SELECTOR = "commit:9df02121d0d87c17173f79d55692bed9cb65722c";
export const REQUIRED_LLVM_MAJOR = 21 as const;
export const REQUIRED_CLANG_MAJOR = 21 as const;
export const REQUIRED_LLD_MAJOR = 21 as const;

export interface MinimumToolVersions {
  readonly deno: string;
  readonly git: string;
  readonly cmake: string;
  readonly llvmMajor: number;
  readonly clangMajor: number;
  readonly lldMajor: number;
}

export const MINIMUM_TOOLS: Readonly<MinimumToolVersions> = Object.freeze({
  deno: MINIMUM_DENO_VERSION,
  git: MINIMUM_GIT_VERSION,
  cmake: MINIMUM_CMAKE_VERSION,
  llvmMajor: REQUIRED_LLVM_MAJOR,
  clangMajor: REQUIRED_CLANG_MAJOR,
  lldMajor: REQUIRED_LLD_MAJOR,
});

export const ZIG_MANAGER_CONFIG_FILE = "zig-manager.json";
export const ZIG_MANAGER_STATE_FILE = "zig-manager-state.json";
export const BUILD_MANIFEST_FILE = "build-manifest.json";
export const DOCS_MANIFEST_FILE = "manifest.json";

export interface SupportedDocsAssetContract {
  readonly id: "zig-autodoc-v1";
  readonly zigLines: readonly ["0.16", "0.17"];
  readonly languageReference: "doc/langref.html";
  readonly standardDirectory: "doc/std";
  readonly standardAssets: readonly ["index.html", "main.js", "main.wasm", "sources.tar"];
  readonly indexScriptTag: '<script src="main.js"></script>';
  readonly wasmFetch: 'fetch("main.wasm")';
  readonly sourcesFetch: 'fetch("sources.tar")';
}

export const SUPPORTED_DOCS_ASSET_CONTRACT: Readonly<SupportedDocsAssetContract> = Object.freeze({
  id: "zig-autodoc-v1",
  zigLines: Object.freeze(["0.16", "0.17"] as const),
  languageReference: "doc/langref.html",
  standardDirectory: "doc/std",
  standardAssets: Object.freeze(
    [
      "index.html",
      "main.js",
      "main.wasm",
      "sources.tar",
    ] as const,
  ),
  indexScriptTag: '<script src="main.js"></script>',
  wasmFetch: 'fetch("main.wasm")',
  sourcesFetch: 'fetch("sources.tar")',
});

export const DEFAULT_MAX_DIAGNOSTIC_BYTES = 256 * 1024;
export const MAX_CONFIG_BYTES = 1024 * 1024;
