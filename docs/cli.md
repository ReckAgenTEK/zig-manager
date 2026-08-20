# `zm` CLI

## Commands

```text
zm shell activate bash
zm shell deactivate bash
zm shell status [-g|--global|--path <directory>]

zm install <selector> [--profile <profile>] [--jobs <count>]
zm uninstall <installation-id>
zm use <selector> [-g|--global|--path <directory>] [--refresh-zls] [build options]
zm use --installed <profile-or-zig-installation-id> [-g|--global|--path <directory>]
zm unuse [-g|--global|--path <directory>]
zm sync [-g|--global|--path <directory>] [build options]
zm update [-g|--global|--path <directory>] [build options]

zm list [--remote]
zm current [-g|--global|--path <directory>] [--check]
zm status [-g|--global|--path <directory>] [--check]
zm which [zig|zls] [-g|--global|--path <directory>]
zm run [-g|--global|--path <directory>] -- <zig arguments>
zm run <selector-or-zig-installation-id> -- <zig arguments>

zm doctor [selector] [-g|--global|--path <directory>] [--host] [--verify] [--strict]
zm gc [--dry-run] [--sources] [--build-cache] [--profiles]
zm repair [--path <directory>] [--unlock <target>]
zm purge (--dry-run|--yes)
```

`-g` and `--global` are aliases and cannot be combined with `--path`. They make a mutating command
target the manager-global pointer or make an inspection ignore local overrides. Without either,
resolution checks the nearest local pin and then the global pointer.

## Pairing

New installs are always Zig/ZLS pairs. `--profile` selects Zig's source build profile; `--jobs`
limits both the Zig and ZLS builds. ZLS is always included; `--refresh-zls` controls stable-ZLS
discovery rather than opting into ZLS.

The first use of a stable Zig installation chooses the newest compatible strict ZLS tag in the same
major/minor cycle and records that choice in a manager-wide stable-ZLS pin. Later stable uses still
resolve Zig normally. If they select that exact Zig installation, `zm` reuses and fully verifies the
pinned ZLS without ZLS remote or source work. `--refresh-zls` forces discovery of the newest
compatible stable ZLS and replaces the stable-ZLS pin only after the new pair builds and verifies
successfully.

Development selectors use literal ZLS remote HEAD and require the source-declared release cycle to
match Zig. The exact managed Zig then builds and verifies ZLS. Any failure occurs before pointer
publication.

`install` creates or reuses both immutable installations and their profile without selecting it.
`use` performs the same work and publishes the local or global pointer last. `use --installed`
accepts a paired profile ID or a Zig installation ID and remains fully remote- and source-free.
Selecting an old Zig-only installation preserves its strict legacy profile rather than borrowing an
unrelated ZLS. A ZLS installation ID cannot define a selection by itself.

`sync` reproduces and verifies the exact stored sources. `update` re-resolves only a moving
selector; for `stable`, it reuses an existing exact-Zig stable-ZLS pin unless Zig advances. Use
`zm use stable --refresh-zls` to check for a newer compatible ZLS when Zig is unchanged. An exact
tag or commit remains immutable. Human and JSON output identify both components. Legacy top-level
`installationId`, `version`, `commit`, and `executable` fields are Zig aliases.

## Resolution

The static `zig` and `zls` resolvers use this strict precedence:

1. Nearest local directory profile.
2. Manager-global profile.
3. The external executable on the non-manager `PATH`.

Each `use` installs owned persistent resolvers beside the Deno global `zm` launcher. Installation
refuses symlinks, non-files, and files without the ownership marker. A selected profile is
indivisible: missing or invalid Zig, ZLS, profile, or pointer state exits with an error and never
falls through.

Shell activation is optional when Deno's global bin directory is already on `PATH`:

```bash
eval "$(zm shell activate bash)"
eval "$(zm shell deactivate bash)"
```

Activation prepends the manager's internal resolver directory and captures the prior path.
Deactivation removes only that entry. Neither command edits shell startup files. An alias or
exported function named `zig` or `zls` can still take precedence over `PATH`.

`run` executes Zig directly and passes through child stdout, stderr, exit code, and signal. With no
selector it follows normal local/global/fallback resolution. An explicit selector or Zig
installation ID is independent of profile selection and therefore cannot be combined with `--global`
or `--path`.

## Output And Diagnostics

Non-runtime commands accept `--json`. Success and error documents use `schemaVersion: 2` and write
to stdout; progress and human diagnostics write to stderr. Shell activation/deactivation and `run`
reject JSON because their stdout has executable shell code or child output.

Plain `current` and `status` are offline. `--check` contacts a remote only for a moving Zig selector
and never changes a pointer. `which zls` resolves the ZLS from the same winning profile as Zig.

Plain `doctor` checks the effective local or global profile. `doctor --global` ignores local pins.
`doctor --verify` verifies the complete Zig/ZLS pair, including Zig compile/run and the ZLS
protocol. `doctor --host` remains offline and selection-independent. A selector asks for
source/prerequisite diagnostics without configuring a build. `--strict` changes only doctor exit
policy for warnings.

## Cleanup

`uninstall` removes one exact immutable Zig or ZLS installation only when no profile or dependency
references it. Removing an otherwise-unreferenced stable ZLS also clears its manager-wide stable-ZLS
pin before deletion. `gc` never removes final installations and retains profiles whenever references
are uncertain; the global profile is a retained reference.

`repair` reinstalls internal and persistent resolvers, rebuilds catalog metadata, validates/removes
an invalid global pointer, and reconciles the selected exact local pin. Unlock targets are `source`,
`catalog`, `global`, `scope`, or `install:<installation-id>`.

`purge --yes` removes owned persistent resolvers and manager-owned XDG roots. It never removes the
Deno `zm` launcher, external executables, or directory pins outside manager roots. Such pins become
dangling and are reported. `purge --dry-run` performs no mutation.

The first `SIGINT` or `SIGTERM` aborts lock waits and children, unwinds owned staging and locks,
then re-raises the signal. A second signal terminates immediately. Failed build logs remain until an
explicit `gc --build-cache`.
