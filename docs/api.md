# zig-manager API

## `ZigManager`

`ZigManager` is the public facade for immutable paired installations and local/global selection:

```ts
const manager = new ZigManager({
  cwd: Deno.cwd(),
  env: capturedEnvironment,
  home: "/home/user",
});
```

The constructor composes `PlatformPaths`, `GlobalConfigStore`, `GlobalOperationLockManager`, Zig and
ZLS source workspaces, `InstallStore`, `ToolchainProfileStore`, `GlobalCatalog`,
`GlobalProfileStore`, scope stores, and `SessionShimManager`. All process, source, build,
verification, clock, progress, host, and store boundaries used by the facade are injectable for
offline tests.

## Selection And Installation

- `versions()` returns strict stable Zig tags in descending numeric order.
- `list({ remote? })` reports component-labelled installations, paired profiles, and optional Zig
  remote tags.
- `install(selector, options?)` builds or reuses Zig and compatible ZLS, then stores a schema-v2
  paired profile without selecting it.
- `use(selector, options?)` first reuses the newest matching installed pair without source work,
  then performs the paired install on a cache miss and atomically selects the profile locally or
  with `{ global: true }`. Reuse trusts immutable profile metadata by default; `{ verify: true }`
  performs full installation verification before selection. `{ clean: true }` replaces exact Zig/ZLS
  build and installation outputs from stored source metadata. Explicit build options bypass
  local-first reuse. `{ refreshZls: true }` forces stable-ZLS discovery.
- `useInstalled(id, options?)` selects an existing paired profile or Zig installation without any
  remote or source operations. A ZLS installation ID cannot define a selection. Strict schema-v1
  profiles remain readable.
- `unuse(options?)`, `sync(options?)`, and `update(options?)` accept `{ path }` or
  `{ global: true }`.
- `uninstall(installationId)` removes one unreferenced component. A Zig installation cannot be
  removed while an exact ZLS dependency or retained profile references it. Removing an otherwise
  unreferenced pinned ZLS clears its stable-ZLS pin first.

`UseOptions.verify` opts into full verification of a reused profile. `clean` forces an exact Zig/ZLS
rebuild while preserving a healthy prior installation if rebuilding fails. `profile` configures the
Zig CMake build. `jobs` is forwarded to both builds. ZLS uses its canonical release-safe profile
unless a lower-level recipe API explicitly chooses another profile.

The first stable use discovers the highest compatible ZLS tag and records a manager-wide stable-ZLS
pin for the exact Zig installation. Later stable uses select the newest matching installed profile
without Zig or ZLS remote/source work; `update()` re-resolves the moving Zig selector.
`UseOptions.refreshZls` forces discovery of the newest compatible stable ZLS and replaces the pin
only after the new pair builds and verifies successfully.

Global mutations acquire the global lock; local mutations acquire the physical scope lock. Later
work follows source, install, and catalog ordering under one operation UUID. Facade mutations use
fail-fast acquisition: live owners produce a busy error, while locks proven to have dead local PIDs
are atomically removed and retried. A profile pointer is published only after both immutable
installations, full verification, profile creation, catalog rebuild, and persistent resolver
installation succeed.

## Resolution And Execution

- `current()` and `status()` resolve local, then global, then external fallback. `{ global: true }`
  ignores local pins. Managed schema-v2 results contain `zig`, `zls`, `selection`, and `profileId`;
  top-level component fields are Zig compatibility aliases.
- `which("zig" | "zls", options?)` returns the tool from the same winning profile.
- `run(args, options?)` executes effective Zig directly. `{ global: true }` applies only when no
  explicit selector or Zig installation ID is supplied.
- `shellActivate`, `shellDeactivate`, and `shellStatus` expose optional Bash session integration.

The generated POSIX resolver scripts execute no Deno or Git code. They strictly parse local and
global two-line pointers, validate physical profile/executable paths under manager data, and execute
the selected component. Invalid explicit state blocks fallback.

`SessionShimManager.installPersistent()` writes owned `zig` and `zls` scripts to
`PlatformPaths.globalBinDir`, derived from `DENO_INSTALL_ROOT` or `$HOME/.deno/bin`. It refuses to
replace unrelated files. `removePersistent()` removes only files carrying the exact data-root
ownership marker.

## Profiles And Sources

`ToolchainProfileV2` records exact Zig and ZLS installation IDs and complete source observations.
`createToolchainProfileIdentity` and `computeProfileId` canonicalize both components. The public
profile validators retain strict schema-v1 read compatibility but all new source selections are v2.

`GlobalProfileStore` owns the manager-global pointer. Its protocol is exactly:

```text
zig-manager-global-v1
profile=<64-lowercase-hex>
```

Reads and writes reject symlinks, unsafe parents, extra fields, malformed IDs, and non-physical
paths. Publication is atomic.

Stable uses keep one atomic state pin per exact Zig installation under `PlatformPaths.stableZlsDir`.
Each pin names the exact verified ZLS installation preferred for that Zig. Profiles remain immutable
history; `refreshZls` replaces only this manager-wide preference.

`ZlsSourceWorkspace` uses only public `@reckagentek/source-ref` APIs. Stable selection tries strict
ZLS tags in Zig's major/minor cycle newest-first and selects the first source-compatible candidate.
Development selection follows literal symbolic remote HEAD. Exact reconstruction never advances a
stored commit.

## Build And Verification

`prepareZlsBuildRecipe` fingerprints the exact managed Zig dependency. `buildManagedZls` invokes
that executable with direct arguments, isolated HOME/TMP/cache paths, and a cleared explicit
environment. Recipe identity includes source, Zig dependency, profile, optimization, jobs, host,
arguments, environment, and verifier contracts.

`installBuiltZls`, `reuseInstalledZls`, and `verifyInstalledZls` enforce immutable layout, hashes,
version, ELF/runtime metadata, exact dependency identity, and a bounded LSP initialize/shutdown
exchange. There are no downloaded binaries, alternate build strategies, or host Zig fallback.

Each Zig build runs the selected source tree's `zig build docs` target with the just-built compiler
before immutable publication. Build verification requires complete language-reference and standard
autodoc assets plus a self-contained HTML bundle and machine-readable `doc/ai-index.json` with exact
version, commit, paths, sizes, and hashes. Failed or incomplete docs therefore fail the Zig build;
they are not optional side data.

The same immutable installation retains a regular-file snapshot of the exact Zig checkout under
`install/src/zig` and provenance in `install/src/source.json`. Build and installed-object reuse both
verify this snapshot, so source-cache cleanup cannot leave a selected compiler without its matching
source. The CLI-only `use --codex-skills` integration writes a repository-scoped Codex skill that
references these immutable resources; it does not change the `ZigManager` facade contract.

## Diagnostics And Cleanup

- `doctor` uses the effective local/global profile. `{ global: true }` inspects only the global
  selection; `{ verify: true }` verifies both components.
- `gc` conservatively retains profiles referenced by local pins or the global pointer.
- `repair` reinstalls both resolver modes, rebuilds the catalog, repairs global pointer state, and
  reconciles one exact local pin.
- `purge` removes owned persistent resolvers and manager roots while preserving external pins and
  executables.

Known manager and ZLS source/build/verification failures expose stable codes and structured details.
The CLI preserves those codes in JSON errors and never emits credential-bearing repository URLs.
