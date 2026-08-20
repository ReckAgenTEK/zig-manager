# zig-manager

`zig-manager` is a Deno 2 toolchain manager for source-built Zig and ZLS. It stores each new
toolchain as an immutable, verified pair and makes that pair available through the `zm` CLI.

It supports two kinds of selection:

- A **global default** used everywhere.
- A **project selection** that overrides the global default in one directory tree.

New managed profiles keep Zig and ZLS together. A broken or incomplete paired profile is an error;
the manager never silently mixes tools from different profiles. Legacy beta.1 Zig-only profiles
remain readable, but they never borrow an unrelated ZLS.

> **Supported host:** Arch Linux on x86_64, using Deno 2.

## Quick Start

### 1. Install `zm`

```bash
deno install --global --name zm \
  --allow-env --allow-read --allow-write --allow-run --allow-sys \
  jsr:@reckagentek/zig-manager@0.1.0-beta.6/cli
```

Check the host without resolving a source:

```bash
zm doctor --host
```

Resolve a Zig selector and check its source contract and host build prerequisites:

```bash
zm doctor stable
```

This selector check does not resolve or build ZLS. Compatible ZLS resolution and complete paired
verification happen during installation.

`zm` needs permission to read and write user-owned manager state, inspect the host, invoke
`source-ref`, run build tools, and execute the managed Zig and ZLS binaries. It never installs or
changes system packages.

### 2. Choose A Global Default

For most users, `stable` is the best starting point:

```bash
zm use --global stable
```

The first use builds and verifies both Zig and ZLS from source, so it can take significant time and
disk space. Keep at least 20 GiB free where manager data and build caches live; 40 GiB free and 16
GiB of memory are recommended. Later uses reuse matching immutable builds.

After the command succeeds, both tools are available in ordinary shells when Deno's global bin
directory is on `PATH`:

```bash
zig version
zls --version
zm current
```

### 3. Override The Default In A Project

Run `zm use` inside the project directory:

```bash
cd ~/Projects/example
zm use 0.16
```

That selection applies to the directory and all of its descendants:

```bash
zm current
zig version
zls --version
```

Outside that directory tree, the global default still applies.

### 4. Inspect What Will Run

```bash
zm current
zm which zig
zm which zls
zm list
```

Use `--global` to inspect the global default while standing inside a project override:

```bash
zm current --global
zm which zls --global
```

## How Selection Works

Resolution follows this order:

1. The nearest `.zig-manager/toolchain` file in the current directory or an ancestor.
2. The manager-global profile selected with `zm use --global`.
3. An external `zig` or `zls` already on `PATH`.

| Selection         | Create or replace it         | Applies to                                      |
| ----------------- | ---------------------------- | ----------------------------------------------- |
| Project           | `zm use <selector>`          | Current directory and descendants               |
| Global            | `zm use --global <selector>` | Everywhere without a project override           |
| External fallback | Not managed by `zm`          | Used only when neither managed selection exists |

An explicit local or global selection is strict. If its pointer, profile, Zig, or required ZLS is
missing or invalid, resolution stops with an error instead of falling through to another layer.

## Choosing A Version

| Selector             | Meaning                                   | Example                     |
| -------------------- | ----------------------------------------- | --------------------------- |
| `stable`             | Highest available stable Zig release      | `zm use --global stable`    |
| `latest`             | Literal symbolic remote `HEAD`            | `zm use latest`             |
| `x.y`                | Highest stable patch in that release line | `zm use 0.16`               |
| `x.y.z`              | Exact stable tag                          | `zm use 0.16.0`             |
| `tag:<name>`         | Exact named tag                           | `zm use tag:0.16.0`         |
| `branch:<name>`      | Current commit on a named branch          | `zm use branch:master`      |
| `commit:<object-id>` | Exact 40- or 64-digit commit              | `zm use commit:<object-id>` |

For a stable Zig release, the first use chooses the newest compatible strict ZLS tag in the same
major/minor release line and records that choice manager-wide for the exact Zig installation. Later
`zm use stable` calls still resolve Zig normally. When that resolution selects an exact Zig
installation with a stable-ZLS pin, `zm` reuses and fully verifies the pinned ZLS without ZLS remote
or source work. `--refresh-zls` forces discovery of the newest compatible stable ZLS; the stable-ZLS
pin changes only after the new pair builds and verifies successfully.

For a development Zig selection, `zm` resolves ZLS remote `HEAD` and requires both sources to
declare the same release cycle.

`latest` does not mean latest stable. Because it follows both upstream development heads, temporary
incompatibility can cause the build to fail. Failure leaves the previous local and global selections
unchanged; any completed immutable Zig build may remain cached for later reuse.

## Common Workflows

### Change The Global Default

```bash
zm use --global 0.16
```

### Pin An Exact Project Toolchain

```bash
cd ~/Projects/example
zm use 0.16.0
```

The `.zig-manager/toolchain` pin is a plain file. Commit it only when your workflow also provisions
the matching immutable profile on other machines. Otherwise, add it to the repository's
`.gitignore`.

### Reuse An Existing Build Without Source Work

Find a paired profile ID or Zig installation ID, then select it:

```bash
zm list
zm use --installed <profile-or-zig-installation-id>
zm use --global --installed <profile-or-zig-installation-id>
```

A ZLS installation ID cannot define a selection by itself. Selecting a legacy Zig installation
creates a strict Zig-only profile rather than borrowing ZLS from another profile.

### Fully Verify The Selected Pair

```bash
zm doctor --verify
zm doctor --global --verify
```

Full verification checks immutable files and hashes, version output, ELF and runtime metadata, a Zig
compile/run probe, and a bounded ZLS LSP initialize/shutdown exchange.

### Verify Or Reconstruct The Exact Selection

```bash
zm sync
zm sync --global
```

`sync` preserves the exact stored source commits. It verifies existing installations and
reconstructs missing or corrupt exact installations without advancing the selection.

### Advance A Moving Selection

```bash
zm update
zm update --global
```

`update` re-resolves selectors such as `stable`, `latest`, `x.y`, and `branch:<name>`. Exact tags
and commits remain immutable.

### Remove A Selection

```bash
zm unuse           # remove the selection at the current directory
zm unuse --global  # remove the global default
```

Removing a project selection reveals an inherited parent selection or the global default. Removing
the global default leaves project selections intact and restores external fallback elsewhere.

## Command Guide

| Command                                       | Purpose                                                                |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| `zm install <selector>`                       | Build and store a Zig/ZLS pair without selecting it                    |
| `zm use <selector>`                           | Build or reuse a pair and select it for the current directory          |
| `zm use --global <selector>`                  | Build or reuse a pair and make it the global default                   |
| `zm use stable --refresh-zls`                 | Refresh the compatible stable ZLS before selecting the pair            |
| `zm use --installed <profile-or-zig-id>`      | Select a paired profile or Zig installation without source work        |
| `zm list [--remote]`                          | List stored components, profiles, and optional remote Zig tags         |
| `zm current [--check]`                        | Show the effective pair and optionally check a moving Zig selector     |
| `zm status`                                   | Alias for `zm current`                                                 |
| `zm which [zig\|zls]`                         | Print the executable that would run                                    |
| `zm run [<selector-or-zig-id>] -- <zig-args>` | Run the effective or explicitly requested Zig directly                 |
| `zm sync`                                     | Verify or reconstruct the exact selected pair                          |
| `zm update`                                   | Advance a moving selected pair                                         |
| `zm unuse`                                    | Remove an exact local or global profile pointer                        |
| `zm uninstall <installation-id>`              | Remove one unreferenced immutable Zig or ZLS installation              |
| `zm doctor --host\|<selector>\|--verify`      | Check the host, source prerequisites, or selected pair                 |
| `zm repair`                                   | Repair manager metadata and owned resolver scripts                     |
| `zm gc`                                       | Remove requested replaceable caches and safe unreferenced profiles     |
| `zm purge --yes`                              | Remove all manager-owned state, data, caches, and persistent resolvers |

Most selection-aware commands accept either `--path <directory>` or `-g`/`--global`. They cannot be
combined. Run `zm help` or see [`docs/cli.md`](./docs/cli.md) for every option.

Non-runtime commands accept `--json`. Stable success and error envelopes go to stdout, while build
progress and human diagnostics go to stderr. `zm run` passes through the child's streams and exit
status and therefore does not support `--json`.

## Host And Build Requirements

The supported runtime is Arch Linux x86_64 with Deno 2 and Git 2.20 or newer. Source builds require:

- CMake 3.15 or newer and a C/C++17 toolchain.
- Ninja by default, or the configured generator and its build tool.
- The exact LLVM, Clang, and LLD major and development files declared by the selected Zig source.
- The LLVM targets required by Zig's source build.
- At least 20 GiB free for build and installation work; 40 GiB is recommended.
- 16 GiB of memory is recommended.

The selected checkout, not its version label alone, chooses the LLVM 21 or LLVM 22 build adapter.
`zm doctor <selector>` reports blocking requirements and verified Arch package hints before CMake is
configured. It never executes a package installation command or switches to another build strategy.

Build profiles are `debug`, `release`, `relwithdebinfo`, and `minsizerel`. Pass `--profile` and
`--jobs` to `install`, `use`, `sync`, or `update` when command-specific values are needed.

## Configuration

The optional strict configuration file is `$XDG_CONFIG_HOME/zig-manager/config.json` (normally
`~/.config/zig-manager/config.json`). It contains build defaults only; the global toolchain
selection is a separate pointer managed by `zm use --global`.

```json
{
  "build": {
    "profile": "release",
    "generator": "Ninja",
    "jobs": 16,
    "cpu": "baseline"
  },
  "warnings": {
    "movingSelectorMaxAgeHours": 24
  }
}
```

The file is partial, so omitted values use defaults. It can also set `zigRepository`,
`build.cmakePrefixPath`, explicit paths under `tools`, and the cache-size warning threshold. Unknown
or invalid fields are rejected rather than ignored. See
[`schema/zig-manager-global.schema.json`](./schema/zig-manager-global.schema.json) for the complete
shape.

Environment overrides take precedence over the file. They include `ZIG_MANAGER_ZIG_REPOSITORY`,
`ZIG_MANAGER_BUILD_PROFILE`, `ZIG_MANAGER_BUILD_GENERATOR`, `ZIG_MANAGER_BUILD_JOBS`,
`ZIG_MANAGER_BUILD_CPU`, `ZIG_MANAGER_CMAKE_PREFIX_PATH`, tool-specific variables from
`ZIG_MANAGER_CMAKE` through `ZIG_MANAGER_GENERATOR_TOOL`, and both warning settings. `CC` and `CXX`
are used only when their `ZIG_MANAGER_CC` and `ZIG_MANAGER_CXX` overrides are absent.

## Shell And Resolver Behavior

The first successful `zm use` installs owned `zig` and `zls` resolver scripts beside the
Deno-installed `zm` launcher. If `zm` is available on `PATH`, the resolvers normally are too.

The installer refuses to replace an existing `zig` or `zls` file that is not owned by this manager.
External tools elsewhere on `PATH` remain available as fallback when no managed selection exists.

For environments where Deno's global bin directory is not on `PATH`, activate the internal resolver
directory for the current Bash session:

```bash
eval "$(zm shell activate bash)"
```

Deactivate it without changing unrelated `PATH` entries:

```bash
eval "$(zm shell deactivate bash)"
```

Activation is optional, session-only, and never edits shell startup files.

## Upgrade And Removal

Upgrade the Deno launcher intentionally:

```bash
deno install --global --force --name zm \
  --allow-env --allow-read --allow-write --allow-run --allow-sys \
  jsr:@reckagentek/zig-manager@<new-version>/cli
```

To remove all manager-owned files, purge first and then uninstall the launcher:

```bash
zm purge --yes
deno uninstall --global zm
```

Running only `deno uninstall --global zm` leaves source caches, immutable installations, profiles,
selection pointers, directory pins, and persistent resolvers in place.

### Upgrading From beta.1

beta.2 makes every new source selection a Zig/ZLS pair, adds the manager-global selection, and
installs owned persistent `zig` and `zls` resolvers beside `zm`. Existing beta.1 Zig-only profiles
remain strict and readable. Re-select a source selector to create a pair; `zm update` can migrate a
legacy profile whose stored selector is moving.

Because persistent resolvers outlive the Deno launcher, run `zm purge --yes` before
`deno uninstall --global zm` when removing beta.2 completely. See [`CHANGELOG.md`](./CHANGELOG.md)
for the release summary.

## Storage

Linux defaults follow XDG and Deno's global install root:

```text
$XDG_CONFIG_HOME/zig-manager/config.json
$XDG_STATE_HOME/zig-manager/global-profile
$XDG_STATE_HOME/zig-manager/catalog.json
$XDG_STATE_HOME/zig-manager/scopes.json
$XDG_STATE_HOME/zig-manager/stable-zls/
$XDG_STATE_HOME/zig-manager/locks/
$XDG_DATA_HOME/zig-manager/installs/{zig,zls}/
$XDG_DATA_HOME/zig-manager/profiles/
$XDG_DATA_HOME/zig-manager/shims/
$XDG_CACHE_HOME/zig-manager/{sources,builds,logs}/
$DENO_INSTALL_ROOT/bin/{zm,zig,zls}
```

`DENO_INSTALL_ROOT` defaults to `$HOME/.deno`. Set `ZIG_MANAGER_HOME=/absolute/path` to relocate the
manager's config, state, data, and cache roots beneath one directory.

## Build And Safety Contract

- Zig and ZLS are built from exact source commits. Prebuilt tool downloads are not used.
- ZLS is built only with the exact managed Zig in its profile.
- Builds use direct argument arrays, isolated caches, and explicit environments.
- Build, install, profile, pointer, manifest, and resolver publication is atomic.
- Failed pair creation never replaces the previous selection pointer.
- `zm` inspects prerequisites but never installs system packages or chooses a fallback build
  strategy.
- Full verification covers immutable data, version output, ELF/runtime metadata, Zig compile/run
  behavior, and a bounded ZLS LSP initialize/shutdown exchange.

## Library API

```ts
import { ZigManager } from "@reckagentek/zig-manager";

const manager = new ZigManager({ cwd: Deno.cwd() });
await manager.use("stable", { global: true });

const current = await manager.current();
if (current.mode === "managed") {
  console.log(current.selection, current.zig, current.zls);
}
```

The public API also exports the paired profile, global pointer, ZLS source/build/install, and
resolver primitives. See [`docs/api.md`](./docs/api.md).

## Development

```bash
deno task check
deno task zm help
```

Normal tests are offline and use fake sources and build tools. The real Arch source-build gate is
opt-in and uses isolated manager and Deno install roots:

```bash
deno task test:e2e:arch
```

The Arch gate installs a real Deno launcher, builds and verifies a compatible Zig/ZLS release pair,
tests local/global/fallback resolver precedence, compiles a real program, checks exact reuse, and
exercises real prerequisite diagnostics. It contacts upstream repositories and is intentionally
expensive.

Set `ZIG_MANAGER_E2E_KEEP=1` to retain its sandbox. Resume a retained run with:

```bash
ZIG_MANAGER_E2E_SANDBOX=/absolute/sandbox/path deno task test:e2e:arch
```

An independent browser gate validates an already-generated mega documentation file through
Chromium's DevTools Protocol:

```bash
ZIG_MANAGER_E2E_BROWSER=/usr/bin/chromium \
ZIG_MANAGER_E2E_MEGA_PATH=/absolute/path/to/zig-all.html \
deno task test:e2e:browser
```
