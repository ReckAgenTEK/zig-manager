# zig-manager CLI

```text
zig-manager versions [--remote] [--json]
zig-manager use <selector> [--json]
zig-manager sync [--json]
zig-manager update [selector] [--json]
zig-manager doctor [--json]
zig-manager build [--profile <profile>] [--jobs <count>] [--json]
zig-manager docs [--mega|--no-mega] [--json]
zig-manager setup [build/docs options] [--json]
zig-manager path [--json]
zig-manager run -- <zig arguments>
zig-manager env [--json]
zig-manager status [--json]
```

Use `--project-root <path>` to select the project containing `zig-manager.json`. JSON success and
error documents have `schemaVersion: 2`. Long-operation progress goes to stderr; composable values
and JSON go to stdout.

`run` passes child stdout/stderr through and exits with the child exit code. If the child terminates
by signal, the executable CLI propagates that signal to itself. `run` intentionally rejects `--json`
so child output cannot corrupt a JSON document.

No command edits global `PATH`, shell startup files, package-manager state, or system tool defaults.
