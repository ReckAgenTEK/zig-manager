# zig-manager Status And Roadmap

This document records current implementation status and remaining planned work. `README.md`,
`docs/cli.md`, and `docs/api.md` define released user and API behavior.

## Current Release Contract

`zig-manager` is a Deno 2 CLI named `zm` for Arch Linux x86_64. It builds Zig and a compatible ZLS
from exact source commits, publishes them as an immutable paired profile, and resolves tools in this
order:

1. Nearest `.zig-manager/toolchain` directory pin.
2. Manager-global profile selected with `zm use --global`.
3. External `zig` or `zls` on the non-manager `PATH`.

New Zig installations contain:

- Verified Zig compiler and standard library under `install/`.
- Exact regular-file Zig source snapshot under `install/src/zig`.
- Source provenance under `install/src/source.json`.
- Language and standard-library documentation under `install/doc`.
- Self-contained AI-readable HTML, `AI_README.md`, and `ai-index.json`.

`zm use <selector> --codex-skills` writes the repository-scoped Codex skill
`.agents/skills/zig-manager-toolchain/SKILL.md` plus `agents/openai.yaml`. The skill records exact
absolute paths for Zig, ZLS, retained source, generated docs, and installed standard-library source.

## Completed Architecture

- Deno/JSR distribution with inert library and `./cli` exports.
- Strict stable, minor, tag, branch, commit, `stable`, and symbolic remote `HEAD` selectors.
- Source checkout through `@reckagentek/source-ref`.
- Source-derived LLVM 21 and LLVM 22 adapters with strict prerequisite diagnostics.
- Immutable Zig and ZLS installations and paired profile identities.
- Local directory and manager-global selection with static persistent resolvers.
- Optional Bash activation without shell-startup edits.
- Atomic staging, publication, pointers, profiles, and catalog updates.
- Exact Zig compile/run and ZLS LSP lifecycle verification.
- Generated Zig language/standard-library docs and retained exact Zig source.
- Repository-scoped Codex Desktop skill generation.
- Conservative uninstall, garbage collection, repair, purge, and corruption handling.
- Offline unit/integration coverage and opt-in real Arch source-build/browser gates.

## Safety Invariants

- Never install, remove, or upgrade system packages.
- Never edit shell startup files or persistent system/user `PATH` settings.
- Never replace unrelated executables in Deno's global bin directory.
- Never mix Zig and ZLS from different profiles.
- Never publish a local/global pointer before both components verify.
- Never silently fall back when an explicit managed pointer is corrupt.
- Never execute prebuilt Zig or ZLS downloads; builds use exact source commits.
- Never delete final immutable installations through cache cleanup.
- Never wait behind a live CLI operation or trust a dead process lock; fail live contention and
  compare-remove only locks whose recorded PID is proven dead.
- Treat managed installation content as read-only.

## Supported Host And Deferred Work

Production support remains Arch Linux x86_64. Windows and macOS abstractions may be unit tested, but
runtime support is not claimed.

Deferred work:

- Windows source-build adapters, native directory resolver, and PowerShell session support.
- macOS source-build adapters and resolver support.
- Immutable worktrees for parallel builds of different source commits.
- Portable repository constraints distinct from host-local profile IDs.
- Additional AI integrations only when they have an explicit host-specific file contract.

## Release Gates

Before tagging a release:

1. Run `deno task check`.
2. Run the real Arch gate with `deno task test:e2e:arch`.
3. Validate generated documentation assets and retained source after cache deletion.
4. Validate generated Codex skill structure with the Codex skill validator.
5. Confirm `deno.json`, `ZIG_MANAGER_VERSION`, README install command, changelog, commit, and tag
   use the same version.
6. Push the release commit before pushing its matching `v<version>` tag.

The tag-triggered GitHub workflow reruns `deno task --frozen-lockfile check`, verifies tag/package
version equality and a clean checkout, then publishes to JSR using trusted publishing.
