# zig-manager

`zig-manager` is a Deno 2 library and CLI for selecting, building, verifying, and using Zig from
source. It delegates all repository operations to the public `@source-ref/source-ref` API. It never
invokes Git or a shell and has no Node runtime path.

The initial tracked source is clean upstream commit `9df02121d0d87c17173f79d55692bed9cb65722c`,
derived as `0.17.0-dev.135+9df02121d` from source base `0.17.0` and release ancestor `0.16.0`. The
LLVM 21 CMake adapter supports this source and the `0.16.x` release line. The manager probes
prerequisites but never installs tools, downloads a prebuilt Zig, silently bootstraps, or chooses a
fallback strategy.

## Configuration

Create `zig-manager.json` at the project root. Unknown keys and paths escaping the project root are
rejected.

```json
{
  "$schema": "./packages/zig-manager/schema/zig-manager.schema.json",
  "sourceRoot": ".source-ref",
  "repository": "https://codeberg.org/ziglang/zig.git",
  "provider": "codeberg",
  "name": "zig",
  "selector": "commit:9df02121d0d87c17173f79d55692bed9cb65722c",
  "build": {
    "strategy": "cmake",
    "profile": "release",
    "generator": "Ninja",
    "cmakePrefixPath": null,
    "jobs": null
  },
  "docs": {
    "mega": true
  },
  "tools": {
    "cmake": null,
    "cCompiler": null,
    "cxxCompiler": null,
    "llvmConfig": null,
    "clang": null,
    "lld": null,
    "generatorTool": null
  }
}
```

Explicit tool paths can also be supplied through `ZIG_MANAGER_CMAKE`, `ZIG_MANAGER_CC`,
`ZIG_MANAGER_CXX`, `ZIG_MANAGER_LLVM_CONFIG`, `ZIG_MANAGER_CLANG`, `ZIG_MANAGER_LLD`,
`ZIG_MANAGER_GENERATOR_TOOL`, and `ZIG_MANAGER_CMAKE_PREFIX_PATH`. Config values take precedence.
Versioned `/usr/lib/llvm21` Arch Linux paths are probed before unversioned LLVM tools, without
changing system defaults or global `PATH`.

## Library

```ts
import { ZigManager } from "@zignado/zig-manager";

const manager = new ZigManager({ projectRoot: Deno.cwd() });
await manager.sync();
const prerequisites = await manager.doctor();
if (prerequisites.ok) await manager.build();
console.log(await manager.path());
```

`ZigManager` accepts structural `sourceRef` and `runner` dependencies for fast offline tests. The
public package root exposes the orchestrator, strict domain/config/state/build/docs types,
constants, selector functions, typed errors, and release-adapter contract. Raw process and
source-ref internals remain private.

See [`docs/api.md`](./docs/api.md) for method semantics and [`docs/cli.md`](./docs/cli.md) for CLI
usage.

## Safety And Artifacts

- `use` resolves remote refs before requesting a pinned source-ref checkout.
- `sync` reproduces the lock; only `update` re-evaluates a moving selector.
- Source state is atomically written to `<repository-home>/zig-manager-state.json`.
- Source state records the CMake-declared base version, full derived version, tagged ancestor,
  commit distance, and immutable commit.
- Builds are keyed by source commit, host target, profile, and a deterministic SHA-256 identity.
- A build becomes active only after version, managed `lib_dir`, and executable hash verification.
- Docs require an active verified build from the same commit and atomically replace `ref-docs` only
  after all official outputs validate.
- On Linux, docs run through util-linux `prlimit` with a one-byte soft `RLIMIT_CORE`. Expected Zig
  crash examples still terminate by signal, but do not invoke the system coredump handler.
- Docs hold an OS-backed operation lock and recover abandoned staging directories after an
  interrupted process without touching an active generation.
- Mega format v1 embeds the supported official Zig autodoc app and assets. Contract drift raises
  `ZIG_MEGA_DOCS_UNSUPPORTED_FORMAT`; no replacement renderer is used.
- `path`, `run`, and `env` never modify shell files, symlinks, or global `PATH`.

## Development

```text
deno task fmt:check
deno task lint
deno task typecheck
deno task test
```

Fast tests are offline and never compile Zig. The real network/build workflow is opt-in with
`ZIG_MANAGER_E2E=1`; browser smoke testing is separately opt-in with `ZIG_MANAGER_BROWSER_E2E=1`.
Neither runs during the normal test task.
