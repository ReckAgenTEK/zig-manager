# zig-manager

`zig-manager` is an Arch Linux x86_64-first, directory-scoped manager for Zig toolchains built from
source. Its Deno 2 CLI is named `zm`.

The manager never replaces a system Zig, creates a user-wide current Zig, edits shell startup files,
or installs system packages. A managed selection consists of an immutable installation in XDG data
and a `.zig-manager/toolchain` pin in one directory. The nearest ancestor pin wins.

## Install

Install a versioned JSR release without compiling a native `zm` executable:

```bash
deno install --global --name zm \
  --allow-env --allow-read --allow-write --allow-run --allow-sys \
  jsr:@zignado/zig-manager@0.1.0-beta.1/cli
```

These permissions are needed to read XDG and scope state, write user-owned manager data, inspect the
host, and directly execute source-ref, build tools, and managed Zig. `zm` does not use the
permissions to modify system package state.

Upgrade intentionally to a newer release by adding `--force`:

```bash
deno install --global --force --name zm \
  --allow-env --allow-read --allow-write --allow-run --allow-sys \
  jsr:@zignado/zig-manager@<new-version>/cli
```

Remove only the Deno launcher with `deno uninstall --global zm`. This leaves source caches,
immutable Zig installations, profiles, and directory pins intact; `zm purge --yes` is the separate
destructive manager-data operation.

## Use

```bash
eval "$(zm shell activate bash)"
cd ~/Projects/example
zm use latest
zig version
```

`latest` means the canonical Codeberg repository's symbolic remote `HEAD`, resolved through
`source-ref` to one immutable commit. It does not mean the latest stable tag.

The directory pin persists, while shell activation is session-only. In an activated shell, unpinned
directories delegate to the Zig found on the pre-activation `PATH`. In a shell that has not
activated `zm`, normal `PATH` resolution remains unchanged even inside a pinned directory.

Useful commands include:

```text
zm install <selector>
zm use <selector>
zm use --installed <installation-id>
zm current
zm run -- version
zm update
zm unuse
zm uninstall <installation-id>
```

See [`docs/cli.md`](./docs/cli.md) for the full command surface.

## Storage

Linux defaults follow XDG:

```text
$XDG_CONFIG_HOME/zig-manager/config.json
$XDG_STATE_HOME/zig-manager/
$XDG_DATA_HOME/zig-manager/installs/
$XDG_DATA_HOME/zig-manager/profiles/
$XDG_DATA_HOME/zig-manager/shims/
$XDG_CACHE_HOME/zig-manager/
```

`ZIG_MANAGER_HOME=/absolute/path` maps these roots to `config`, `state`, `data`, and `cache`
children for tests or explicit relocation. Global configuration is optional and contains build
defaults only. It has no active/default Zig setting.

Directory pins are ordinary `.zig-manager/toolchain` files. Commit one when the repository should
share the toolchain selection; otherwise add `.zig-manager/toolchain` to the repository's
`.gitignore`.

Mutations wait abortably under ordered scope, source, install, and catalog locks while one operation
UUID owns their staging and build logs. The first `SIGINT` or `SIGTERM` cancels that work, cleans
only owned staging, releases locks, and is then re-raised. Failed or cancelled build logs remain
under `$XDG_CACHE_HOME/zig-manager/logs/` until an explicit `zm gc --build-cache`.

## Library

```ts
import { ZigManager } from "@zignado/zig-manager";

const manager = new ZigManager({ cwd: Deno.cwd() });
const current = await manager.current();

if (current.mode === "managed") {
  await manager.run(["version"]);
}
```

The facade supports injected environment, home, platform, working directory, `source-ref`, process
runner, diagnostic probe, and component services for deterministic offline tests. See
[`docs/api.md`](./docs/api.md).

## Host And Build Contract

The initial runtime gate is Arch Linux x86_64. Other operating systems and architectures fail with
`ZIG_HOST_UNSUPPORTED` before manager mutation. Windows runtime resolution and ZLS build support are
intentionally deferred and return clear errors; their storage seams are retained.

The release adapters support proven Zig 0.16/0.17 CMake source contracts with the exact
LLVM/Clang/LLD 21 or 22 major declared by the locked checkout. Unknown or mismatched contracts fail
before prerequisite probing. Before building, the manager runs `source-ref` doctor and adapter-owned
CMake/compiler/LLVM/Clang/LLD/generator, development-file, target, filesystem, and disk checks.
Missing prerequisites stop the operation. No fallback build strategy or package installation is
attempted.

`zm doctor --host` remains offline. Diagnostics use stable schema-v2 findings, distinguish blocking
errors from warnings, inspect both cache-build and data-staging filesystems, memory,
session/fallback state, and show only exact Arch package hints verified through read-only pacman
metadata queries. `--strict` makes warnings fail doctor for CI but never changes normal build
eligibility.

## Development

```text
deno task check
deno task zm help
```

Normal tests are offline and use fakes; they do not compile Zig or contact Codeberg. The real Arch
release gate remains opt-in and creates isolated manager and Deno-install roots:

```text
deno task test:e2e:arch
```

It builds real Codeberg `HEAD` plus a second exact Zig profile, so it is intentionally expensive.
Set `ZIG_MANAGER_E2E_KEEP=1` to preserve the temporary sandbox for inspection. A failed preserved
run can continue with `ZIG_MANAGER_E2E_SANDBOX=/absolute/sandbox/path deno task test:e2e:arch`.
