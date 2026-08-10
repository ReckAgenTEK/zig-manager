# zig-manager API

## `ZigManager`

- `versions(options?)` lists strict stable remote semantic versions in descending order.
- `use(selector, options?)` resolves remote refs and requests a pinned source-ref checkout.
- `sync(options?)` restores the existing source-ref lock without version advancement.
- `update(selector?, options?)` explicitly re-resolves the selector and updates the pin.
- `doctor(options?)` selects requirements from synchronized source metadata, then probes source-ref,
  CMake, compilers, LLVM/Clang/LLD, the generator, writable output, and portable free-space data. It
  does not change system packages.
- `build(options?)` performs the out-of-tree CMake build and atomically selects a verified result.
- `docs(options?)` runs managed Zig as `zig build docs -p <prefix>` with managed cache paths. Linux
  execution uses `prlimit` to set soft `RLIMIT_CORE=1` for the docs subprocess tree, preventing
  expected crash examples from entering the system coredump pipeline without changing their signal
  status.
- `setup(options?)` composes sync, doctor, build, and docs.
- `path(options?)` returns the exact verified active executable.
- `run(args, options?)` executes that path directly and returns its unmodified exit/signal status.
- `env(options?)` describes opt-in environment additions without applying them.
- `status(options?)` reports source-ref state plus build/docs validity and commit-based staleness.

Supported selectors are strict `x.y.z`, stable minor `x.y`, `tag:<name>`, `branch:<name>`, and an
exact 40- or 64-hex-digit `commit:<object-id>`. Stable minor resolution ignores malformed and
prerelease tags and selects the highest numeric patch.

After checkout, the manager reads the source's CMake version and combines it with structured tagged
ancestry from `source-ref`. State and manifests therefore distinguish the selector, immutable
commit, base version, release ancestor, commit distance, and full release or development version.

## Injection

The constructor accepts `sourceRef: SourceRefApi` and `runner: ProcessRunner`. Both are structural
interfaces, allowing tests to provide deterministic fakes. The default source API is
`SourceRefStore`; the default process implementation uses `Deno.Command` with argument arrays and no
shell.

## Errors

All manager domain failures extend `ZigManagerError` and provide a stable `code` and structured
`details`. Source management failures remain typed `SourceRefError` values from the dependency. CLI
JSON preserves both error families without exposing environment values or process stacks.
