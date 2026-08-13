# Changelog

Notable changes to `@zignado/zig-manager` are recorded here.

## [Unreleased]

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
