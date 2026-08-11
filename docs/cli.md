# `zm` CLI

```text
zm shell activate bash
zm shell deactivate bash
zm shell status

zm install <selector> [--profile <profile>] [--jobs <count>]
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
zm gc [--dry-run] [--sources] [--build-cache] [--profiles]
zm repair [--path <directory>] [--unlock <target>]
zm purge (--dry-run|--yes)
```

Non-runtime commands accept `--json`. Success and error documents use `schemaVersion: 2` and write
to stdout. Progress and human diagnostics write to stderr.

`shell activate` and `shell deactivate` reject `--json`. Their stdout contains only Bash code so it
is safe to evaluate explicitly:

```bash
eval "$(zm shell activate bash)"
eval "$(zm shell deactivate bash)"
```

Activation is idempotent, captures the first non-manager base `PATH`, and prepends only the static
resolver directory. Deactivation removes that resolver entry while preserving unrelated later `PATH`
changes. Neither command edits a startup file.

`run` also rejects `--json`. Child stdout, stderr, exit code, and terminating signal pass through.
Without a selector, it executes the Zig from the nearest directory pin and does not require shell
activation. A 64-hex installation ID selects an existing local installation without source or
network operations.

`use` builds and verifies before atomically replacing the selected directory pin. `use --installed`
is fully local. `unuse` removes only a pin located exactly at the selected path and refuses to
remove an inherited parent pin. `sync` preserves the exact stored source; `update` re-resolves only
a moving stored selector.

Plain `current` and `status` are offline. Outside pinned trees they report fallback mode rather than
a global managed selection. `--check` queries a remote only for a moving selector and does not alter
the pin.

`doctor --host` is offline. `doctor <selector>` performs exact source and adapter checks without
starting CMake, while plain `doctor` checks an exact stored pin or behaves as `--host` when no pin
exists. `--verify` is valid only for a plain pinned doctor. Selector/`--host`, selector/`--verify`,
and `--host`/`--verify` combinations are rejected.

`doctor --verify` performs full immutable-install verification, including exact version and host
target, ELF format, isolated minimal compilation/execution, and dynamic runtime dependency
fingerprints. It reports `full-install`; it is not a session-resolver-only bounded check.

Doctor JSON uses a schema-v2 finding model and always includes all errors, warnings, information,
remediation, resources, session/fallback state, source-ref data, and redacted effective config.
Warnings do not block normal install/use/build. `--strict` changes only the doctor exit policy. Arch
package hints appear only after exact `pacman -Q` and `pacman -Si` metadata checks; suggested
full-upgrade commands are display-only data and are never executed.

`gc` never removes final installations. Profile pruning is conservative when scope references cannot
be proven. `purge --yes` removes manager-owned XDG roots only; directory pins elsewhere are left in
place and may become dangling.

Each CLI invocation uses one abort signal. The first `SIGINT` or `SIGTERM` cancels lock waits and
active child commands, allows owned staging and locks to unwind, then re-raises the original signal.
A second signal terminates immediately. Failed or cancelled build logs remain under the cache log
root until `gc --build-cache` is requested.
