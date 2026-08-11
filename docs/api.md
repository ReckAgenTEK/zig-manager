# zig-manager API

## `ZigManager`

`ZigManager` is the public facade for global immutable data and directory-scoped selection. Its
constructor does not require `zig-manager.json`:

```ts
const manager = new ZigManager({
  cwd: Deno.cwd(),
  env: capturedEnvironment,
  home: "/home/user",
});
```

Supported injections are `env`, `home`, `platform`, `architecture`, `hostTarget`, `cwd`,
`sourceRef`, `runner`, `diagnosticProbe`, `progress`, and component `services`. Defaults compose
`PlatformPaths`, `GlobalConfigStore`, `GlobalOperationLockManager`, `SourceWorkspace`,
`InstallStore`, `ToolchainProfileStore`, `GlobalCatalog`, `ScopeResolver`, `ScopePinStore`, and
`SessionShimManager`.

## Selection And Installation

- `versions()` returns strict stable remote tags in descending numeric order.
- `list({ remote? })` reports local installations/profiles and optionally stable remote tags.
- `install(selector, options?)` builds or reuses an immutable Zig without creating a pin.
- `uninstall(installationId, options?)` removes one unreferenced immutable installation. Retained
  profiles and dependent installations block removal.
- `use(selector, options?)` installs, creates/reuses a profile, updates the catalog, then writes the
  selected directory pin last.
- `useInstalled(id, options?)` validates and pins a local installation without source operations.
- `unuse(options?)` removes only the pin exactly at the selected physical directory.
- `sync(options?)` validates the exact pinned profile and attempts exact-source reconstruction only
  when its stored metadata can reproduce the same installation identity.
- `update(options?)` re-resolves the selector stored in the nearest profile. Exact tags and commits
  are reported as immutable.

Scope-changing transactions hold a physical-directory operation lock. Source-dependent work runs
under the shared source-workspace lock; immutable publication uses a per-install lock; catalog
updates use the catalog lock. Mutation callers wait abortably in strict
`scope -> source -> install -> catalog` order. The first lease UUID identifies every later lock,
staging path, scope temporary, and build log for that transaction. A scope pin is never written
before all preceding work succeeds.

## Resolution And Execution

- `current(options?)` and `status(options?)` report managed or fallback mode. Plain reads are
  offline; `{ check: true }` checks only moving selectors.
- `which(tool?, options?)` returns the effective managed or fallback executable.
- `run(args, options?)` runs the nearest pinned Zig, an explicit selector, or a local installation
  ID directly through the injected process runner.
- `shellActivate("bash")`, `shellDeactivate("bash")`, and `shellStatus()` expose session-only Bash
  resolver behavior without editing startup files. Shell status schema v2 also reports the bounded
  fallback `zig version` result and whether that fallback is usable.

A malformed or missing explicit pin/profile/install is an error. Managed resolution never silently
falls through to an unrelated Zig inside a pinned tree.

## Diagnostics And Cleanup

- `doctor(selector?, options?)` returns schema-v2 structured findings with stable severity/code,
  required/found values, checked paths, remediation, and verified package metadata. `buildReady`
  means there are no errors; `ok` also rejects warnings only when `strict` is requested.
- `doctor(undefined, { host: true })` is offline and limits itself to host, source-ref, resource,
  session, and fallback checks. A selector resolves and checks one exact source/adapter without
  configuring; no selector in a pin checks its stored exact source.
- `doctor(undefined, { verify: true })` is pin-only and reports `full-install` verification. It
  checks immutable hashes and layout, exact `zig version`/host target, ELF format, isolated minimal
  compilation and execution, and recorded runtime dependencies.
- `gc(options?)` removes abandoned build/install/profile staging only when its canonical operation
  UUID is absent from every strictly validated retained lock owner. Malformed or unverifiable lock
  and staging entries are retained. Explicit cache flags remove replaceable roots; final
  installations are always retained.
- `repair(options?)` regenerates shims/catalog metadata, validates the current scope, and can
  explicitly remove a lock whose owner is proven dead.
- `purge({ dryRun: true })` reports manager roots; `purge({ confirm: true })` removes those roots.
  It never removes external directory pins, Deno, the `zm` launcher, or an external Zig.

## Source And Build

`SourceRefApi` includes `resolveRemoteHead`, `listRemoteRefs`, checkout/status/revision operations,
and `doctor`. `latest` exclusively uses `resolveRemoteHead`; it never substitutes a stable tag or a
hard-coded branch.

The default source transaction derives an exact source version and adapter, runs the adapter-aware
doctor, fingerprints the complete pre-configure recipe, and uses its canonical SHA-256 as both the
build-cache key and immutable installation ID. `buildManagedZig` and `installBuiltZig` execute
direct argument arrays with an explicit cleared environment; ambient compiler, linker, CMake, and
package-discovery variables are not inherited.

Configure/build command JSON and complete stdout/stderr streams are flushed under
`<cache>/logs/<operation-id>/zig/<installation-id>/`. Failed and cancelled build logs are retained;
only explicit `gc({ buildCache: true })` removes the log root.

## Errors

Manager failures extend `ZigManagerError` and expose a stable `code`, concise `message`, separate
`remediation` where stable, and structured `details`. Store, lock, scope, shim, and `source-ref`
errors also retain stable codes. The CLI converts known low-level install/profile codes to their
public `ZIG_*` categories in JSON output.
