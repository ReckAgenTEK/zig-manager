# Changelog

Notable changes to `@reckagentek/zig-manager` are recorded here.

## [Unreleased]

## [0.1.0-beta.8] - 2026-08-20

### Fixed

- Make installed-profile `use` selection metadata-only by default; `--verify` explicitly enables
  full Zig/ZLS installation verification.
- Add `zm use <selector> --clean` to replace exact Zig/ZLS build and installation outputs from
  source while restoring a healthy prior installation when rebuilding fails.

## [0.1.0-beta.7] - 2026-08-20

### Fixed

- Make ordinary `use` selector calls reuse matching installed profiles before Zig source resolution
  or preparation; moving selectors advance only through `update`.
- Make mutating CLI lock acquisition fail fast for live owners and automatically remove only
  well-formed locks whose recorded local PID is proven dead.

## [0.1.0-beta.6] - 2026-08-20

### Added

- Add `zm use stable --refresh-zls` to discover and select the newest compatible stable ZLS.

### Changed

- Reuse the manager-wide ZLS selection associated with an exact stable Zig installation without
  repeating ZLS remote or source work.

## [0.1.0-beta.5] - 2026-08-17

### Added

- Build and verify Zig language-reference and standard-library documentation with every new Zig
  installation, including a self-contained HTML bundle and AI-oriented index.
- Retain the exact Zig source snapshot and provenance beside each immutable compiler installation.
- Add local-only `zm use --codex-skills` generation for a repository-scoped Codex Desktop skill
  containing exact compiler, ZLS, source, documentation, and standard-library paths.

### Fixed

- Build Zig 0.16 documentation on current Arch glibc by preparing isolated CRT copies without
  unsupported `.sframe` metadata; system CRT files remain unchanged.
- Apply the Arch CRT compatibility step only on Arch hosts, keeping portable offline checks
  independent of Arch filesystem paths.
- Make retained Arch E2E runs recreate their restricted diagnostic PATH fixture when needed.

### Changed

- Bump the Zig build contract so older cached builds without documentation and retained source are
  not reused as complete beta.5 builds.
- Verify retained source during build-cache and immutable-install reuse.

## [0.1.0-beta.4] - 2026-08-16

### Changed

- Move the JSR package identity to `@reckagentek/zig-manager`.
- Use `@reckagentek/source-ref@0.1.0-beta.2` for source checkout management.

### Compatibility

- Existing `@zignado/zig-manager` versions remain immutable on JSR. New releases use only the
  `@reckagentek` scope.

## [0.1.0-beta.3] - 2026-08-13

### Fixed

- Accept Zig 0.17's CWD-relative `lib_dir` during managed installation verification while retaining
  containment and exact-path validation.

## [0.1.0-beta.2] - 2026-08-12

### Added

- Source-built ZLS selection, build, immutable installation, and verification paired with the exact
  managed Zig installation.
- A manager-global toolchain selection below nearest-directory overrides and above external `PATH`
  fallback.
- Owned persistent `zig` and `zls` resolvers beside the Deno-installed `zm` launcher, with optional
  Bash session activation retained for environments where that directory is not on `PATH`.
- Paired-profile verification including Zig compile/run and a bounded ZLS LSP lifecycle exchange.
- Paired `sync`, `update`, `uninstall`, garbage collection, repair, purge, JSON output, and catalog
  behavior.
- Offline ZLS source/build/install coverage and an opt-in real Arch paired-toolchain gate.

### Changed

- New `install` and source-oriented `use` operations always produce an immutable Zig/ZLS profile.
- Resolution is now nearest local profile, then manager-global profile, then external Zig or ZLS.
- Stable Zig selectors choose a compatible ZLS release tag; development selectors use ZLS remote
  `HEAD` and enforce source-declared release-cycle and version bounds.
- `doctor --verify` validates the complete selected pair, while selector-mode doctor remains a
  source and prerequisite check.

### Compatibility

- Existing beta.1 Zig-only profiles remain readable and strict. They never borrow ZLS from another
  profile, and a moving `update` can migrate them to a paired profile.
- Top-level JSON installation fields remain Zig aliases; paired results also expose explicit `zig`
  and `zls` components.

## [0.1.0-beta.1] - 2026-08-11

- Initial public beta of the Deno 2, directory-scoped, source-built Zig manager.
