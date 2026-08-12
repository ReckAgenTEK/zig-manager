# Historical zig-manager: Directory-Scoped Source-Built Zig Toolchain Plan

> Superseded: this document describes the original Zig-only, session-scoped implementation. The
> current contract automatically builds paired Zig/ZLS profiles, supports a manager-global default,
> and installs owned persistent resolvers. Use `README.md`, `docs/cli.md`, and `docs/api.md` as the
> authoritative behavior and interface documentation.

Status: proposed architecture and implementation plan

Initial supported host: Arch Linux, x86_64

Distribution: Deno 2 CLI installed as `zm` without compiling or shipping native `zm` binaries

## 1. Outcome

`zig-manager` becomes a user-installed Deno CLI named `zm`. It builds and caches Zig toolchains from
Codeberg, but it never replaces, removes, rewrites, or globally selects the user's existing Zig.

Managed Zig selection has two independent parts:

1. A persistent directory pin stored at a chosen folder. The pin applies to that folder and every
   descendant unless a nearer descendant has its own pin.
2. A session-only shell activation. It makes the directory-aware `zig` and future `zls` resolver
   visible only in the current shell and processes launched from it.

The primary workflow is:

```bash
deno install --global --name zm \
  --allow-env --allow-read --allow-write --allow-run --allow-sys \
  jsr:@zignado/zig-manager@<version>/cli

eval "$(zm shell activate bash)"

cd ~/Projects/example
zm use latest
zig version
```

Expected behavior:

```bash
cd ~/Projects/example/subdirectory
zig version                 # managed Zig pinned by ~/Projects/example

cd ~/Projects/other
zig version                 # pre-existing Zig from the shell's original PATH
```

In a new shell that has not run `eval "$(zm shell activate bash)"`, `zig` remains the pre-existing
global command even inside a pinned folder. The directory pin persists, but it has no effect until
that shell session explicitly activates `zm`.

`zm use latest` must:

1. Resolve the current symbolic `HEAD` of Zig's canonical Codeberg repository. It must not interpret
   `latest` as the newest stable release.
2. Pin the exact resolved source commit through `source-ref`.
3. Inspect that source and select an exact compatible build adapter.
4. Block before an expensive build if required host tools or resources are missing.
5. Build Zig for the current host or reuse an identical verified installation.
6. Create an immutable local toolchain profile referencing that installation.
7. Atomically write the profile ID into the selected directory's scope file.
8. Leave the previous directory pin and every system/global Zig unchanged on any failure.

## 2. Non-Interference Contract

The following rules are non-negotiable:

- `zm` never writes to `/usr/bin`, `/usr/local/bin`, or another system tool directory.
- `zm` never changes a system Zig package or a Zig installed by another manager.
- `zm` never creates a user-wide "current Zig" pointer.
- `zm` never persistently prepends its Zig resolver to the user's shell startup files.
- `zm shell activate` emits shell code; it cannot and must not claim to mutate its parent shell by
  itself.
- Shell activation changes only the current shell environment after the user explicitly evaluates
  the emitted code.
- Outside a pinned directory tree, an activated session delegates `zig` to the executable found on
  the shell's original `PATH`.
- Without shell activation, `zm use` can build and persist a directory pin, but plain `zig` remains
  whatever it was before. `zm` prints the exact activation command in that case.
- A corrupt or unresolved directory pin is an error. The resolver never silently falls back to a
  global Zig inside a directory that explicitly claims a managed toolchain.
- Managed installations are immutable and are never automatically deleted.
- No command installs or upgrades system packages.
- No failed operation changes a directory's existing pin.

Installing the `zm` command globally through Deno is distinct from globally installing or selecting
Zig. Only the manager command is placed in Deno's executable bin directory.

## 3. Exact Scope Semantics

### 3.1 Session Scope

`eval "$(zm shell activate bash)"` prepends a manager-owned resolver directory to `PATH` in the
current Bash process. It also records the original `PATH` for fallback resolution.

- The current shell sees directory-aware `zig` and, later, `zls`.
- Child processes inherit that behavior.
- Independent shells are unchanged.
- Shell startup files are unchanged.
- `zm shell deactivate bash`, when explicitly evaluated, removes the resolver from that shell and
  restores the prior path contract.
- Repeated activation is idempotent and must preserve the first non-manager base `PATH`.

The behavior matrix is:

| Shell state   | Directory state | `zig` resolution                              |
| ------------- | --------------- | --------------------------------------------- |
| Not activated | Unpinned        | Existing command from normal `PATH`           |
| Not activated | Pinned          | Existing command from normal `PATH`           |
| Activated     | Unpinned        | Existing executable from captured base `PATH` |
| Activated     | Pinned          | Managed Zig from nearest directory profile    |

### 3.2 Directory Scope

`zm use <selector>` pins the current physical directory by default. `--path <directory>` selects a
different explicit scope root.

Resolution starts at the process's physical working directory and walks toward the filesystem root:

1. The first valid `.zig-manager/toolchain` file wins.
2. A nested pin overrides a parent pin.
3. The selected pin applies to its own directory and all descendants.
4. A malformed nearest pin blocks resolution. It is not skipped in favor of a parent or global Zig.
5. If no pin exists, the session resolver delegates to the pre-activation `PATH`.

Physical paths are used so symlink aliases cannot create inconsistent scope identity. Scope paths
containing control characters are rejected when `zm` creates a pin.

### 3.3 Persistence

The directory file persists across shells and reboots. It references an immutable toolchain profile
in the user's `zm` data store.

The initial scope file is intentionally host-local. It can be moved or committed, but another
machine will normally not have the referenced profile and will receive a clear `zm use ...` or
`zm sync` diagnostic. Portable, repository-committed source constraints can be added later as a
separate format; they must not be conflated with a host-specific built installation.

`zm` never edits `.gitignore` automatically. Documentation recommends ignoring
`.zig-manager/toolchain` when the pin is intended to remain local.

### 3.4 Latest

`latest` is a moving selector with this exact contract:

- Every online `install latest` or `use latest` queries symbolic remote `HEAD` through `source-ref`.
- An applicable `update` performs the same query.
- Record the resolved branch, immutable commit, and resolution timestamp.
- Build the exact commit observed during resolution.
- Never substitute a stable tag, older cached commit, prebuilt Zig, or previous successful commit.
- Never perform update checks from the runtime `zig` resolver.

The remote can advance while a source build is running. `latest` therefore means the exact remote
`HEAD` observed and printed at resolution time. This avoids an unbounded rebuild loop while ensuring
that `latest` means the development head rather than "latest stable."

## 4. Deno Distribution

### 4.1 Confirmed Deno Capability

Deno 2.9.5 exposes:

```text
deno install --global --name <name> <package-or-script>
```

The `--compile` flag is optional. Therefore `zm` can be distributed as TypeScript through JSR and
installed as a global Deno executable without publishing compiled Deno artifacts.

The release installation command is:

```bash
deno install --global --name zm \
  --allow-env --allow-read --allow-write --allow-run --allow-sys \
  jsr:@zignado/zig-manager@<version>/cli
```

Release documentation uses an explicit package version. A user intentionally upgrades with the same
command plus `--force` and a newer version:

```bash
deno install --global --force --name zm \
  --allow-env --allow-read --allow-write --allow-run --allow-sys \
  jsr:@zignado/zig-manager@<new-version>/cli
```

The CLI launcher is removed with:

```bash
deno uninstall --global zm
```

Removing the Deno launcher does not delete cached source, built Zig installations, profiles, or
directory pins. Destructive data removal remains a separate explicit `zm purge` operation.

### 4.2 Why The Permissions Are Required

- `--allow-env`: read `HOME`, XDG paths, `PATH`, tool overrides, and session state.
- `--allow-read`: inspect arbitrary selected project directories, source, manifests, tools, and
  build output.
- `--allow-write`: write directory pins and user-owned manager data/cache/state.
- `--allow-run`: invoke Git, CMake, compilers, LLVM tools, Ninja, managed Zig, and future ZLS. Tool
  paths are adapter/config dependent, so a static executable allowlist is not sufficient.
- `--allow-sys`: inspect supported host/resources and provide correct process/host diagnostics.

The implementation does not require `--allow-ffi`. Zig source network access remains delegated to
the installed Git executable through `source-ref`; `zm` does not add a separate application-level
download path.

The broad filesystem and subprocess permissions must be documented prominently. `zm` remains strict
about managed path containment despite having permission to access other paths.

### 4.3 Package Requirements

- Keep package name `@zignado/zig-manager`.
- Publish the CLI entry point as `./cli`.
- Use `import.meta.main` only in the CLI entry point so library imports remain inert.
- Keep Deno 2 as the only JavaScript/TypeScript runtime path.
- Do not add Node launchers or npm postinstall scripts.
- Do not require users to download a compiled `zm` executable.
- The runtime Zig resolver on Arch is a generated POSIX script, not a compiled Deno package.
- The JSR publish set includes source, schemas, docs, README, and license.

Deno's global bin directory must already be reachable through the user's normal Deno setup. `zm`
does not edit shell startup files to repair Deno's own installation.

## 5. Initial Scope

### 5.1 Included In The First Supported Release

- Deno-installed `zm` CLI.
- Arch Linux x86_64 runtime support.
- Explicit current-session Bash activation and deactivation.
- Persistent nearest-ancestor directory pins.
- Transparent fallback to a pre-existing PATH Zig outside pinned trees.
- `latest`, `stable`, exact version, minor line, tag, branch, and commit selectors.
- Source checkout through `source-ref` and Codeberg.
- Immutable host-specific Zig installations and permanent reuse.
- Actionable prerequisite errors and Arch-specific package hints when verified.
- Atomic directory pin replacement.
- Offline use by exact local installation/profile ID.
- Explicit uninstall, cache cleanup, repair, and purge commands.
- Data-model and resolver seams for future ZLS and Windows support.

### 5.2 Deferred

- Windows runtime support.
- macOS runtime support.
- Persistent automatic shell startup activation.
- A user-wide managed default Zig.
- Portable repository-committed version constraints.
- Cross-compiling Zig for a host other than the machine running `zm`.
- Automatic background updates.
- Automatic system package installation.
- Automatic import of the current project-local v2 state/builds.
- ZLS implementation. Its storage, compatibility, and scope model is designed now.

## 6. CLI Design

### 6.1 Commands

```text
zm shell activate bash
zm shell deactivate bash
zm shell status

zm install <selector> [build options]
zm use <selector> [--path <directory>] [build options]
zm use --installed <installation-id> [--path <directory>]
zm unuse [--path <directory>]
zm sync [--path <directory>] [build options]
zm update [--path <directory>] [build options]

zm list [--remote]
zm current [--path <directory>] [--check]
zm status [--path <directory>] [--check]
zm which [zig|zls] [--path <directory>]
zm run [<selector-or-installation-id>] -- <zig arguments>

zm doctor [selector] [--host] [--verify] [--strict]
zm uninstall <installation-id>
zm gc [--dry-run] [--sources] [--build-cache] [--profiles]
zm repair [--path <directory>] [--unlock <lock>]
zm purge [--dry-run]
```

All non-runtime commands support schema-versioned `--json` where output can remain isolated from
child process streams.

### 6.2 Command Semantics

`install <selector>`:

- Resolves the selector and builds or reuses a verified installation.
- Does not create or change any directory pin.
- Does not alter the current shell.

`use <selector>`:

- Runs the install/reuse pipeline.
- Creates or reuses an immutable profile.
- Atomically pins that profile to the current directory or explicit `--path`.
- Creates a nested override when a parent directory is already pinned.
- Does not edit `PATH`; an unactivated shell receives an activation reminder.

`use --installed <installation-id>`:

- Performs no network or source checkout.
- Verifies the local installation, creates/reuses a profile, and pins it.

`unuse`:

- Removes only the pin located exactly at the current directory or explicit `--path`.
- Does not silently remove an inherited parent pin.
- If only an inherited pin exists, reports its root and requires that root explicitly.
- Does not uninstall Zig.

`sync`:

- Revalidates the exact profile currently pinned at the selected scope.
- Rebuilds a missing/corrupt installation when the pinned profile manifest still supplies its exact
  immutable source metadata.
- Reports an unrecoverable local pin when the profile manifest itself is gone; it never guesses the
  prior selector.
- Does not advance a moving selector.
- Leaves the pin unchanged on failure.

`update`:

- Finds the nearest effective pin from the selected path and prints its scope root.
- Re-resolves the requested selector stored in that profile.
- Advances `latest`, `stable`, minor, or branch selectors when the remote changed.
- Reports exact tag/commit selections as immutable.
- Atomically changes only that directory pin after successful build and verification.

`current` and plain `status`:

- Are offline.
- Report the physical lookup path, winning scope root, profile, installation, selector, version, and
  commit.
- If no pin exists, report the pre-existing fallback Zig visible to an activated session.

`current --check` and `status --check`:

- Query the remote only for a moving selector.
- Report whether the pin can be updated without changing it.

`run`:

- With no selector, resolves the nearest directory pin and runs that Zig without requiring shell
  activation.
- With a selector, installs/reuses it for one execution without pinning it.
- With an installation ID, is fully local and network-free.
- Passes arguments and child status through exactly.

`uninstall`:

- Removes only manager-owned immutable data.
- Refuses to remove an installation referenced by any retained profile.
- Refuses to remove Zig while any ZLS installation depends on it.
- Requires explicit profile/dependency pruning before removal.

`gc`:

- Never removes final Zig/ZLS installations by default.
- Removes abandoned staging and requested replaceable source/build caches.
- Prunes profiles only with `--profiles` and only when no known scope pin references them.
- Is conservative when a moved/deleted scope cannot be proven absent.

`purge`:

- Is the only command intended to remove all manager-owned data.
- Requires an explicit confirmation mode in non-interactive use.
- Never removes directory pin files outside the manager data root; it reports them as dangling.
- Never removes Deno, the `zm` launcher, or an external Zig.

## 7. Selector Model

| Selector             | Resolution                                  |
| -------------------- | ------------------------------------------- |
| `latest`             | Symbolic remote `HEAD` and its exact commit |
| `stable`             | Highest strict stable `x.y.z` tag           |
| `x.y.z`              | Exact stable tag                            |
| `x.y`                | Highest stable patch in that minor line     |
| `tag:<name>`         | Exact remote tag                            |
| `branch:<name>`      | Current exact commit of the remote branch   |
| `commit:<object-id>` | Exact 40- or 64-hex object ID               |

Rules:

- Aliases are case-sensitive ASCII.
- Stable versions remain strict numeric semantic versions.
- Prerelease strings are not treated as stable selectors.
- Every online selector resolves to an immutable commit before build lookup.
- Branch/tag races are checked against the checkout result.
- A local development build is addressed by profile ID, installation ID, or commit rather than by
  reparsing its derived `-dev` display text.
- There is no implicit offline fallback for a remote selector.

## 8. Architecture

### 8.1 Components

`PlatformPaths`:

- Computes XDG config, state, data, cache, and resolver paths.
- Supports `ZIG_MANAGER_HOME` for isolated tests and explicit relocation.
- Validates containment and user-owned roots.

`GlobalConfigStore`:

- Loads optional build/tool defaults.
- Stores no active Zig selection.
- Does not require a project config for basic use.

`ScopeResolver`:

- Walks physical directory ancestors.
- Parses the nearest strict directory pin.
- Reports scope root and profile ID.
- Never resolves a remote selector at runtime.

`ScopePinStore`:

- Creates `.zig-manager/toolchain` atomically.
- Maintains an advisory registry of pins created by `zm` for status and conservative cleanup.
- Serializes mutations to the same scope root.

`ZigCatalog`:

- Lists remote versions and resolves selectors.
- Uses only the public `source-ref` API for repository operations.

`SourceWorkspace`:

- Owns the global mutable `SourceRefStore` checkout.
- Pins exact commits and derives source metadata.
- Holds a manager-level source lock for all checkout-dependent build work.

`ReleaseAdapterRegistry`:

- Selects an exact source-compatible build adapter.
- Owns tool requirements, command generation, and output verification contracts.
- Never selects a nearest/fallback adapter.

`PrerequisiteInspector`:

- Produces structured error, warning, and informational findings.
- Runs host and adapter-specific checks.
- Produces verified Arch package hints without invoking package installation.

`ZigBuilder`:

- Computes a deterministic host recipe.
- Reuses only a matching verified installation.
- Builds in staging and promotes atomically.

`InstallStore`:

- Owns immutable Zig and future ZLS installations.
- Treats per-install manifests as authoritative.
- Maintains a rebuildable catalog index.

`ToolchainProfileStore`:

- Creates immutable profiles containing one Zig installation and optional compatible ZLS.
- Stores requested-selector metadata needed by `update`.
- Has no global `current` pointer.

`SessionShimManager`:

- Generates static POSIX resolver scripts under manager data.
- Emits Bash activation/deactivation code.
- Never edits shell startup files.
- Resolves directory pins without starting Deno on each `zig` invocation.

`ZigManager`:

- Remains the public facade.
- Composes install, pin, update, run, doctor, and cleanup transactions.
- Retains structural `source-ref` and process-runner injection for tests.

### 8.2 Dependency Direction

```text
Deno-installed zm CLI
  -> ZigManager facade
     -> scope resolver / pin store
     -> selector catalog
     -> source workspace -> source-ref
     -> adapter registry -> prerequisite inspector -> process runner
     -> builder -> install store
     -> profile store
     -> session shim manager
```

The runtime `zig` resolver reads only session environment, directory pins, profile path files, and
the fallback `PATH`. It does not import or execute the Deno CLI.

## 9. Filesystem Layout

Linux XDG layout:

```text
$XDG_CONFIG_HOME/zig-manager/
  config.json

$XDG_STATE_HOME/zig-manager/
  catalog.json
  scopes.json
  source-ref.lock.json
  locks/
    source.lock/
    catalog.lock/
    scopes/<scope-key>.lock/
    installs/<installation-id>.lock/

$XDG_DATA_HOME/zig-manager/
  shims/
    zig
    zls
  installs/
    .staging/<operation-id>/
    zig/<installation-id>/
      install/
      install-manifest.json
    zls/<installation-id>/
      install/
      install-manifest.json
  profiles/
    <profile-id>/
      profile.json
      zig.path
      zls.path

$XDG_CACHE_HOME/zig-manager/
  sources/
    codeberg/zig/git-src/
  builds/
    zig/<installation-id>/
    zls/<installation-id>/
  logs/

<scope-root>/.zig-manager/
  toolchain
```

Fallback roots:

- Config: `~/.config/zig-manager`
- State: `~/.local/state/zig-manager`
- Data: `~/.local/share/zig-manager`
- Cache: `~/.cache/zig-manager`

`ZIG_MANAGER_HOME=/path` maps these to `/path/config`, `/path/state`, `/path/data`, and
`/path/cache`.

Final installations belong in data, not cache. Deleting source/build caches must not break a pinned
Zig. The final install prefix is staged under `data/installs/.staging` so atomic rename remains
valid even when XDG data and cache are separate filesystems. CMake object files and other
replaceable intermediates stay in cache.

There is deliberately no manager-wide `current` symlink and no manager Zig directory intended for a
persistent user `PATH` entry.

## 10. Persistent Formats

### 10.1 Directory Pin

`.zig-manager/toolchain` uses a tiny strict line protocol so the POSIX runtime resolver can parse it
without JSON tools or Deno:

```text
zig-manager-scope-v1
profile=<64-lowercase-hex-profile-id>
```

Rules:

- Exactly these two lines are accepted in v1.
- The resolver never `source`s or evaluates this file.
- The profile ID is validated before constructing a manager-data path.
- The profile ID can select only an existing profile under the manager-owned data root, never an
  arbitrary executable path.
- Writes use a flushed temporary sibling and atomic rename.
- A failure before rename leaves the old pin untouched.
- The parent `.zig-manager` directory is removed by `unuse` only when it is empty afterward.

All source selector/version/commit metadata lives in the immutable profile manifest, so the scope
file remains fast and atomic.

### 10.2 Resolved Source

```text
ResolvedSource
  component
  repository identity and normalized URL
  requested selector
  resolved ref kind and value
  immutable commit
  structured release/development version
  resolution timestamp
```

The timestamp is for reporting and is excluded from build identity.

### 10.3 Build Recipe

The canonical recipe includes every input that can materially change the compiler:

```text
BuildRecipe
  schema version
  component ID
  source repository identity, commit, and derived version
  release adapter ID and contract version
  host OS, architecture, ABI, and Deno target
  CPU policy
  build strategy/profile/options
  normalized generator and CMake arguments
  explicit build-affecting environment
  required tool paths, versions, hashes, and adapter queries
  relevant development library/package fingerprints
```

Canonical JSON is SHA-256 hashed to produce the installation ID. Timestamps, output paths, staging
paths, progress settings, and terminal options are excluded.

Ambient `CFLAGS`, `CXXFLAGS`, `LDFLAGS`, and similar inputs are cleared or normalized into explicit
config and identity. They must not alter a supposedly identical cached build invisibly.

### 10.4 Install Manifest

Each immutable install records:

- Schema version and installation ID.
- Resolved source and complete recipe.
- Final executable and library paths.
- Compiler-reported version and host target.
- Executable size and SHA-256.
- Runtime dynamic dependency records.
- Build commands with secrets and irrelevant environment excluded.
- Creation timestamp and verifier contract version.
- Dependencies, empty for Zig and containing an exact Zig installation ID for ZLS.

### 10.5 Toolchain Profile

```text
ToolchainProfile
  schema version
  profile ID
  requested selector and resolved source
  Zig installation ID
  ZLS installation ID or null
  host identity
  creation timestamp
```

The profile directory also contains one-line absolute `zig.path` and optional `zls.path` files.
These are generated only from validated manager manifests. Paths with control characters are
rejected.

The profile ID is a canonical hash of component installation IDs and selector metadata, excluding
timestamps. Repeated use of the same selection reuses the profile.

### 10.6 Catalog And Scope Registry

`catalog.json` indexes installations/profiles for fast listing but is rebuildable from manifests.

`scopes.json` records scope paths created by `zm`, their latest known profile, and last operation.
It is advisory because directories can be moved or deleted outside `zm`. Runtime resolution trusts
the nearest on-disk scope file, not the registry.

Cleanup is conservative: uncertainty in the advisory registry prevents automatic profile deletion,
not installation use.

## 11. Bash Session Resolver

### 11.1 Activation Output

`zm shell activate bash` writes shell code only to stdout and diagnostics only to stderr. Evaluating
it:

- Captures the first non-manager `PATH` in `ZM_BASE_PATH`.
- Sets `ZM_SESSION_ACTIVE=1`.
- Sets the manager data/shim roots needed by the resolver.
- Prepends the static shim directory exactly once.
- Does not edit `.bashrc`, `.bash_profile`, `.profile`, or another startup file.

If Deno's global bin directory or `zm` itself is not reachable, that is a Deno installation issue;
the command cannot run and does not attempt profile edits.

### 11.2 Runtime Zig Algorithm

The generated POSIX `zig` resolver:

1. Obtains the physical working directory.
2. Walks ancestors to filesystem root.
3. Stops at the nearest `.zig-manager/toolchain`.
4. Strictly validates its schema line and 64-hex profile ID without `eval` or `source`.
5. Reads the trusted `zig.path` from the matching manager-owned profile.
6. Checks that the target exists and is executable.
7. Executes it with `exec "$target" "$@"`.
8. If no scope pin exists, restores `ZM_BASE_PATH` and executes the pre-existing PATH `zig`.

If a scope pin is invalid, references a missing profile, or references a missing executable, the
resolver exits with a concise error naming the scope and recommending `zm current`, `zm use`, or
`zm repair`. It does not fall through.

The resolver performs no network request, source lookup, update check, JSON parse, hash scan, or
Deno startup. This keeps repeated Zig compiler invocations inexpensive.

### 11.3 Existing Zig Fallback

The fallback path is captured before the manager shim is prepended. This prevents recursion and
preserves the user's existing executable-based Zig selection outside managed scopes.

`zm shell status` reports:

- Whether this process environment is activated.
- Shim path.
- Base `PATH`.
- Existing fallback Zig path/version, if any.
- Effective directory pin and managed Zig at the current path.

If no fallback Zig exists, `zig` outside managed scopes exits like a missing command with a clear
message. No Zig is installed or selected implicitly.

Shell aliases/functions named `zig` can take precedence over `PATH` and are not observable from a
child Deno process. Activation documentation calls this out; `zm` never removes aliases/functions.

### 11.4 Deactivation

`zm shell deactivate bash` emits idempotent shell code that removes only the manager shim path and
unsets manager session variables. It does not delete directory pins, profiles, or installations.

The implementation must preserve unrelated `PATH` changes made after activation rather than simply
restoring a stale full string.

## 12. Source Resolution And `source-ref`

### 12.1 Remote HEAD Extension

The current `source-ref` API exposes branches/tags but not symbolic remote `HEAD`. Add:

```ts
interface ResolveRemoteHeadRequest {
  readonly url: string;
  readonly signal?: AbortSignal;
}

interface RemoteHead {
  readonly branch: string;
  readonly commit: string;
}

resolveRemoteHead(request: ResolveRemoteHeadRequest): Promise<RemoteHead>;
```

Requirements:

- Query Git remote symbolic `HEAD` directly with argument arrays.
- Require a valid `refs/heads/<name>` target and exact object ID.
- Return typed failures for missing, malformed, or detached remote `HEAD`.
- Preserve credential rejection and URL redaction.
- Add public types, fake support, and offline tests.

`latest` uses this API and never hard-codes `master`.

### 12.2 Global Source Workspace

`SourceRefStore` uses manager-controlled cache and state paths with repository ID `codeberg/zig`.
The checkout is globally shared for build efficiency, but it is not an active toolchain and never
appears on `PATH`.

The existing project-root containment assumptions are replaced by explicit containment within
computed config/state/data/cache roots and explicit scope roots.

### 12.3 Mutable Checkout Safety

`source-ref` currently owns one mutable checkout per repository. The Arch-first implementation
serializes source-dependent Zig builds:

1. Acquire the manager source-workspace lock.
2. Resolve and pin the commit.
3. Checkout and validate it.
4. Derive source metadata and select the adapter.
5. Configure/build/verify while the source lock remains held.
6. Promote the immutable installation.
7. Release the source lock.

This prevents another process moving source files during a build. A future `source-ref` immutable
worktree API may allow parallel different-commit builds, but correctness comes first.

## 13. Host Build And Cache

### 13.1 Host Support

The first supported runtime is Arch Linux x86_64. Other hosts return a typed unsupported-host error
before mutation. Platform abstractions can be unit-tested elsewhere without claiming support.

Host identity includes OS, architecture, ABI/libc where relevant, `Deno.build.target`, and CPU
policy. The initial implementation builds native host compilers only.

CPU policy is explicit:

- `baseline`: default host architecture compatibility.
- `native`: opt-in tuning when supported by the adapter.

The policy is part of build identity.

### 13.2 Release Adapters

Every adapter owns:

- Source compatibility detection.
- CMake minimum.
- Required LLVM/Clang/LLD versions and targets.
- Required development headers/libraries and other tools.
- Build option normalization.
- Configure/build command generation.
- Version injection.
- Executable/library discovery.
- Version, target, and runtime verification.
- Documentation behavior if retained.

The current LLVM 21 adapter can cover proven compatible 0.16/0.17 sources. Future `HEAD` changes
must receive a tested adapter. An unknown latest commit fails with its exact version/commit and an
upgrade recommendation; it is never guessed into an older adapter.

### 13.3 Build Sequence

1. Resolve and checkout exact source.
2. Derive source version and adapter.
3. Probe prerequisites/resources.
4. Stop on blocking findings.
5. Normalize the recipe and compute installation ID.
6. Acquire the installation lock.
7. Recheck for an existing verified install.
8. Create CMake/build intermediates in cache.
9. Create final install-prefix staging under the data filesystem.
10. Configure and build with direct argument arrays and isolated Zig caches.
11. Verify the staged compiler.
12. Write/validate the final-path manifest in staging.
13. Atomically rename staging to the final immutable path.
14. Repeat path-sensitive verification from the promoted path.
15. Index the installation in the catalog.

Build output streams to stderr and durable logs. JSON command results stay on stdout.

### 13.4 Verification

- `zig version` exactly matches derived source version.
- `zig env` parses for that release line.
- Staged `lib_dir` is contained in staging; promoted `lib_dir` is contained in final install.
- `std/std.zig` exists.
- Reported host target and executable format match Arch Linux x86_64.
- A minimal source compiles with isolated caches.
- The resulting host program executes successfully.
- Executable size/hash match the manifest.
- Dynamic runtime dependencies are recorded and available.
- Every manifest path is contained in the immutable install.

The session resolver does not repeat expensive verification. `use`, `run`, and explicit
`doctor --verify` perform the appropriate bounded/full checks.

### 13.5 Retention And Corruption

- Keep every promoted Zig/ZLS installation until explicit uninstall.
- Never apply automatic final-install eviction.
- Permit explicit cleanup of source, CMake trees, logs, and abandoned staging.
- Reuse only an exact recipe/manifest match.
- Mark corrupt installs unusable without overwriting/deleting them automatically.
- Protect installs referenced by profiles and ZLS dependency manifests.

## 14. Prerequisites And Diagnostics

Use structured findings:

```text
DiagnosticFinding
  severity: error | warning | info
  stable code
  component
  summary
  required value
  found value
  checked paths
  remediation
  verified package hints
```

Errors block build/pin publication. Warnings continue by default; `--strict` can fail CI on
warnings.

Blocking errors include:

- Unsupported host.
- Git unavailable/incompatible.
- Remote `HEAD` unavailable/malformed.
- Dirty or inconsistent source checkout.
- Unsupported source adapter.
- Missing/incompatible CMake, C/C++, LLVM, Clang, LLD, generator, headers, libraries, or LLVM
  targets.
- Unwritable/escaping manager or scope paths.
- Known insufficient disk.
- Invalid state/manifests/pins.
- Compiler version/target/runtime mismatch.

Warnings include:

- Disk/memory cannot be measured or is below recommendation.
- Shell is not session-activated after `use`.
- No fallback Zig exists on the base `PATH`.
- Alias/function precedence may bypass PATH shims.
- Moving selector has not been remotely checked recently.
- Explicit unusual tool overrides.
- Large replaceable cache.
- Development snapshot source.

Arch package hints:

1. Detect Arch through `/etc/os-release`.
2. Query installed packages non-privileged with `pacman -Q`.
3. Verify candidate package names/versions against repository metadata before displaying commands.
4. Derive package requirements from the exact adapter.
5. Suggest only the smallest relevant transaction.
6. Warn about dependency upgrades/partial-upgrade concerns where applicable.
7. Never run `sudo`, `pacman -S`, or an AUR helper.

Use `doctor --host` for offline general checks and `doctor <selector>` for source/adapter-specific
checks without starting the compiler build.

## 15. Transactions And Concurrency

### 15.1 Pin Transaction

`use` and `update` publish no scope change until all source/build/profile work succeeds:

1. Resolve target scope physical path.
2. Acquire its manager operation lock.
3. Preserve existing scope file bytes.
4. Resolve/build/reuse/verify target profile.
5. Write a temporary scope file beside the destination.
6. Flush and validate it.
7. Atomically rename it over `.zig-manager/toolchain`.
8. Update advisory scope registry.

The runtime shim sees either the old complete profile ID or the new complete profile ID.

### 15.2 Lock Order

For scope mutations:

```text
scope -> source workspace -> installation -> catalog
```

Catalog/profile metadata locks are short-lived. No operation may acquire these locks in reverse.
Plain runtime resolution and status reads do not take long mutation locks.

Every lock records operation UUID, PID, operation, scope/selector where relevant, and start time.
Stale locks are never silently removed. `repair --unlock` refuses when the recorded local PID
appears alive.

### 15.3 Cancellation

- SIGINT/SIGTERM propagate to active child build commands.
- Cancellation removes only staging owned by that operation.
- Failed build logs remain available.
- Promoted installs, profiles, prior directory pins, and external Zig installations remain intact.

## 16. Security

- Reject credential-bearing repository URLs.
- Normalize repository identity and validate every object ID.
- Recheck checkout commit against resolved remote commit.
- Never execute build output outside contained staging.
- Keep source/build output separate from runtime resolver scripts.
- Reject path/symlink escapes during promotion, pinning, deletion, and repair.
- Use create-new staging, canonical identity JSON, and strict persisted formats.
- Redact credentials and unrelated environment from diagnostics/logs.
- Record command argument arrays, not shell-reconstructed commands.
- Never evaluate directory pin contents as shell code.
- A directory pin can select only a manager-owned profile ID.
- Treat moving development source as upstream code execution and print URL/commit before building.

## 17. ZLS-Ready Model

The install store is component-oriented. ZLS identity includes:

- Exact ZLS repository/commit.
- Exact Zig installation ID used to build it.
- Host identity.
- ZLS adapter/profile/options/tool identities.

`zm use latest --with-zls` will:

1. Resolve/build Zig.
2. Resolve an explicitly compatible ZLS commit.
3. Build ZLS with the exact managed Zig executable and isolated caches.
4. Verify ZLS and record its Zig dependency.
5. Create one immutable profile containing both.
6. Atomically publish that profile to the directory scope.

If ZLS fails, the prior directory pin remains. Within a managed scope whose profile has no ZLS, the
session `zls` resolver reports no managed ZLS instead of falling back to a potentially incompatible
global ZLS. Outside every managed scope, it delegates to the base-PATH ZLS just like Zig.

ZLS verification includes executable version/architecture/hash and a bounded language-server
initialize/shutdown smoke test. The canonical ZLS repository and compatibility policy are confirmed
at implementation time rather than guessed now.

## 18. Windows Contract

Windows is deferred, but it follows the same non-interference rules:

- `zm` is installed through Deno's global script installation, not a shipped compiled `zm` package.
- PowerShell activation changes only `$env:Path` in the current process after explicit evaluation.
- No registry/user/system `Path` persistence is performed.
- Directory pins use the same nearest-ancestor/profile model.
- Outside pins, resolvers delegate to the pre-activation Windows PATH Zig/ZLS.

A native resolver `.exe` is likely required because `.cmd` lookup is not reliable for every editor
or direct process launcher. This native resolver is a future runtime helper, not a compiled Deno CLI
distribution. Windows support is not claimed until argument, exit, Ctrl-C, library discovery,
PowerShell activation, path-space, and real source-build tests pass.

## 19. Configuration

Global config is optional and stores build defaults only, never selection:

```json
{
  "$schema": ".../zig-manager-global.schema.json",
  "zigRepository": "https://codeberg.org/ziglang/zig.git",
  "build": {
    "profile": "release",
    "generator": "Ninja",
    "jobs": null,
    "cpu": "baseline",
    "cmakePrefixPath": null
  },
  "tools": {
    "cmake": null,
    "cCompiler": null,
    "cxxCompiler": null,
    "llvmConfig": null,
    "clang": null,
    "lld": null,
    "generatorTool": null
  },
  "warnings": {
    "cacheBytes": null,
    "movingSelectorMaxAgeHours": 24
  }
}
```

Requirements:

- Strict unknown-key rejection.
- Atomic config writes.
- Environment overrides for CI/one-off tool selection.
- Effective config visible in redacted doctor JSON.
- Repository overrides become part of source identity.
- No config key for a global/current/default Zig.

## 20. Current Code Refactoring

Reuse and strengthen:

- Strict stable tag parsing/numeric ordering.
- Commit pinning and remote race checks.
- CMake/tagged-ancestry version derivation.
- Release adapter command generation.
- Direct no-shell process runner.
- Tool/LLVM development probes.
- Deterministic identity and staging.
- Compiler version, `lib_dir`, hash, and manifest verification.
- Atomic filesystem helpers.
- Structural dependency injection.

Replace or refactor:

- Keep project-directory awareness but remove the requirement for the current monolithic
  `zig-manager.json` workflow.
- Separate persistent directory scope from global immutable install storage.
- Replace `activeBuild` with install/profile catalogs and directory profile IDs.
- Change CLI `use` from source checkout only to install/reuse plus directory pin.
- Remove every global active-profile/current-pointer concept.
- Add session shim generation without shell startup edits.
- Move final installs from source repository home to XDG data.
- Move fixed LLVM constants into adapter requirements.
- Expand doctor issues into errors/warnings/info.
- Make docs target an explicit profile/installation.

The package is currently `0.0.0`, so this is an intentional v1 CLI/storage redesign. Existing
project-local state/builds and any external/global Zig are left untouched and are not silently
imported or deleted.

Proposed modules:

```text
src/
  cli.ts
  zig_manager.ts
  platform_paths.ts
  global_config.ts
  selectors.ts
  scope_resolver.ts
  scope_pin.ts
  catalog.ts
  source_workspace.ts
  release_adapter.ts
  release_adapters/zig_cmake_llvm21.ts
  prerequisites.ts
  arch_packages.ts
  build.ts
  install_store.ts
  install_manifest.ts
  profile_store.ts
  session_shim.ts
  operation_lock.ts
  state.ts
  process_runner.ts
  filesystem.ts
  errors.ts
  types.ts
  mod.ts
```

Schemas/formats:

```text
schema/
  zig-manager-global.schema.json
  catalog.schema.json
  install-manifest.schema.json
  toolchain-profile.schema.json
  scopes.schema.json
```

The directory toolchain file uses its audited line protocol rather than JSON Schema.

## 21. Error Codes

Add stable categories such as:

```text
ZIG_HOST_UNSUPPORTED
ZIG_REMOTE_HEAD_UNAVAILABLE
ZIG_SCOPE_INVALID
ZIG_SCOPE_PIN_INVALID
ZIG_SCOPE_LOCKED
ZIG_PROFILE_NOT_FOUND
ZIG_PROFILE_INVALID
ZIG_INSTALL_LOCKED
ZIG_INSTALL_CORRUPT
ZIG_INSTALL_NOT_FOUND
ZIG_INSTALL_IN_USE
ZIG_SESSION_NOT_ACTIVE
ZIG_SHIM_INVALID
ZIG_FALLBACK_NOT_FOUND
ZIG_RELEASE_UNSUPPORTED
ZIG_ACTIVATION_FAILED
ZIG_DEPENDENCY_IN_USE
ZIG_SHELL_UNSUPPORTED
ZLS_COMPATIBILITY_NOT_FOUND
ZLS_BUILD_FAILED
ZLS_VERIFICATION_FAILED
```

Every error includes structured details and remediation separately from concise human prose.

## 22. Tests

### 22.1 Unit Tests

- Deno package CLI entry point remains import-inert.
- Documented Deno install command does not use `--compile`.
- XDG and isolated-home paths.
- Strict scope file parsing and profile ID validation.
- Physical nearest-ancestor selection.
- Nested pin override.
- Malformed nearest pin blocks parent/global fallback.
- Scope paths with spaces/metacharacters and rejected control characters.
- Bash activation quoting/idempotence/deactivation.
- Base-PATH resolver recursion prevention.
- Selector and remote `HEAD` behavior.
- Recipe identity stability/change cases.
- Strict config/catalog/manifest/profile schemas.
- Diagnostic severity/strict mode.
- Arch package hints only after package verification.
- ZLS dependency/profile behavior with fakes.

### 22.2 Integration Tests

- An unactivated shell invokes the existing global Zig inside and outside pinned folders.
- An activated shell invokes managed Zig inside the pinned root and descendants.
- The same activated shell invokes the original global Zig outside every pin.
- A child directory pin overrides its parent.
- Leaving a pinned tree immediately restores fallback behavior without a hook or network call.
- `use latest` builds/verifies before atomically changing the directory file.
- Failed remote/build/verification leaves the old pin byte-for-byte unchanged.
- A future activated shell observes the persistent pin.
- The runtime resolver does not start Deno or invoke `zm`.
- Missing profile/install inside an explicit pin errors instead of falling back.
- Cached recipe bypasses configure/build.
- Two selectors resolving to one recipe reuse one install.
- Same-scope concurrent use serializes and publishes one complete pin.
- Different scopes cannot move shared source during a build.
- Cancellation cleans only owned staging.
- `unuse` never removes inherited parent scope accidentally.
- Zig-without-ZLS profile does not leak old/global ZLS inside managed scope.

### 22.3 Arch End-To-End Tests

Use isolated `ZIG_MANAGER_HOME`, a temporary project tree, and a fake existing global Zig for
non-interference checks.

1. Install the local/JSR CLI with `deno install --global` and no `--compile`.
2. Confirm the installed `zm` launcher executes through Deno.
3. Activate Bash only through evaluated session output.
4. Resolve real Codeberg `HEAD` and record its exact commit.
5. Build that commit on Arch x86_64.
6. Pin it to a temporary root and invoke `zig version` there and below it.
7. Leave the root and prove the original global Zig path/version is restored.
8. Open an unactivated shell and prove the global Zig remains visible even in the pinned root.
9. Open a newly activated shell and prove the persisted pin is effective again.
10. Compile/run a minimal program through the managed resolver.
11. Re-run `use latest` and prove exact recipe reuse when remote/recipe are unchanged.
12. Install a second Zig and test nested scope override without rebuilding.
13. Force candidate failure and prove old scope/global behavior remains intact.
14. Delete replaceable caches and prove pinned installed Zig still works.
15. Verify missing prerequisites block before configure with actionable Arch diagnostics.

Real source builds remain opt-in because they are expensive. Test logs record commit and adapter
IDs.

## 23. Implementation Phases

### Phase 1: Deno CLI Distribution And Paths

- Publish/verify `./cli` JSR entry point.
- Document/test non-compiled `deno install --global --name zm`.
- Add XDG/`ZIG_MANAGER_HOME` paths.
- Add optional global build config.
- Gate runtime support to Arch Linux x86_64.

Exit criteria:

- `zm help` works from Deno's global launcher without compiled package artifacts.
- No manager command modifies Zig or shell startup files.

### Phase 2: Directory Scope And Session Resolver

- Implement strict scope file and physical nearest-ancestor resolver.
- Implement immutable profile skeleton.
- Generate POSIX Zig/ZLS resolver scripts.
- Implement Bash activate/deactivate/status output.
- Capture and safely delegate to base-PATH Zig outside scopes.
- Add nested scope and non-interference tests.

Exit criteria:

- Activated sessions switch automatically by working directory.
- Unactivated sessions and unpinned paths use the existing Zig unchanged.
- Runtime resolution has no Deno startup.

### Phase 3: Literal Latest And Global Source Workspace

- Add `resolveRemoteHead` to `source-ref`.
- Add `latest`/`stable` selectors and immutable resolved source.
- Move source checkout/lock into manager XDG cache/state.
- Add long-lived source workspace lock.

Exit criteria:

- `latest` demonstrably selects symbolic remote `HEAD`, not a tag/hard-coded branch.
- Remote failure changes no scope pin.

### Phase 4: Adapter Doctor

- Move LLVM/tool requirements into adapters.
- Add host and adapter-specific diagnostics.
- Add verified Arch package hints without package installation.
- Add resource, fallback Zig, and session-state diagnostics.

Exit criteria:

- Mandatory failures block before configure.
- Unknown latest source fails explicitly without fallback.

### Phase 5: Immutable Install Cache

- Implement recipe/install/profile manifests and catalogs.
- Move final installs to XDG data and intermediates to cache.
- Add staging/promotion/final verification.
- Add per-install locks, reuse, corruption handling, and stronger smoke tests.

Exit criteria:

- Multiple immutable Zigs coexist.
- Exact recipe reuses without build.
- Cache deletion cannot break installs.

### Phase 6: Complete Scope Workflow

- Implement `install`, `use`, `use --installed`, `unuse`, `sync`, and `update`.
- Implement scope mutation locks/registry and atomic publication.
- Implement `current`, `status`, `which`, and `run` against nearest scope.
- Implement conservative uninstall/gc/repair/purge.
- Update CLI/API schemas/docs.

Exit criteria:

- `zm use latest` builds/reuses then pins only one directory tree.
- Every failure leaves old pin and external Zig intact.
- Nested and future-session behavior matches the scope contract.

### Phase 7: Arch Release Gate

- Run all offline tests.
- Run real Codeberg latest build on the target Arch machine.
- Verify global-Zig non-interference with real PATH behavior.
- Measure source build, cache reuse, resolver overhead, and storage.
- Test actual Arch prerequisite/package diagnostics.

Exit criteria:

- Every Arch end-to-end scenario passes.
- No workaround/fallback weakens literal latest or scope isolation.

### Phase 8: ZLS

- Confirm canonical ZLS source/compatibility policy.
- Build with exact managed Zig dependency.
- Add manifests, verification, resolver, and profile pair publication.
- Add editor protocol smoke tests.

Exit criteria:

- `zm use latest --with-zls` atomically pins a compatible pair to one directory tree.
- ZLS failure preserves the prior directory profile.

### Phase 9: Windows

- Implement PowerShell session-only activation/deactivation.
- Implement native directory-aware resolver helper.
- Add Windows build adapters and real tests.

Exit criteria:

- No persistent user/system PATH mutation.
- Existing Windows Zig remains the fallback outside pinned scopes.
- Directory/profile semantics match Linux.

## 24. Definition Of Done

The Arch-first Zig milestone is complete when:

- `zm` installs through Deno globally without `--compile` or shipped native CLI packages.
- Installing `zm` does not install, replace, or select Zig.
- `zm shell activate bash` affects only the evaluated shell session and descendants.
- `zm` never edits shell startup files.
- `zm use latest` resolves Codeberg symbolic `HEAD`, builds/reuses it, and atomically pins only the
  chosen directory.
- The pin persists and applies to that folder and descendants in activated sessions.
- The nearest nested pin wins.
- Outside pinned trees, the exact pre-existing PATH Zig remains in use.
- In unactivated shells, the pre-existing Zig remains in use everywhere.
- A broken explicit pin errors instead of silently running another Zig.
- Multiple source-built Zig versions remain cached as immutable host-specific installs.
- Build failures never alter the prior pin or external Zig.
- Missing tools block early with actionable, verified Arch diagnostics.
- The runtime resolver performs no network access or Deno startup.
- Real Arch tests compile/run code inside a pin and prove fallback outside it.
- The profile model can add a compatible Zig/ZLS pair without redesign.
