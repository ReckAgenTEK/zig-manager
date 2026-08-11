import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { dirname, join } from "@std/path";
import { PlatformPaths } from "../src/platform_paths.ts";
import { ScopePinStore } from "../src/scope_pin.ts";
import {
  parseScopePin,
  ScopePinError,
  ScopeResolver,
  serializeScopePin,
} from "../src/scope_resolver.ts";
import {
  generateBashActivation,
  generateBashDeactivation,
  SessionShimManager,
} from "../src/session_shim.ts";

const PROFILE_A = "a".repeat(64);
const PROFILE_B = "b".repeat(64);
const PROFILE_C = "c".repeat(64);
const PROFILE_D = "d".repeat(64);

Deno.test("platform paths use only injected XDG, home, platform, and relocation inputs", () => {
  const fallback = new PlatformPaths({
    env: {},
    home: "/home/test user",
    platform: "linux",
  });
  assertEquals(fallback.configDir, "/home/test user/.config/zig-manager");
  assertEquals(fallback.stateDir, "/home/test user/.local/state/zig-manager");
  assertEquals(fallback.dataDir, "/home/test user/.local/share/zig-manager");
  assertEquals(fallback.cacheDir, "/home/test user/.cache/zig-manager");
  assertEquals(fallback.shimsDir, "/home/test user/.local/share/zig-manager/shims");

  const xdg = new PlatformPaths({
    env: {
      XDG_CONFIG_HOME: "/xdg/config '$",
      XDG_STATE_HOME: "/xdg/state",
      XDG_DATA_HOME: "/xdg/data",
      XDG_CACHE_HOME: "relative-is-ignored",
    },
    home: "/injected/home",
    platform: "linux",
  });
  assertEquals(xdg.configDir, "/xdg/config '$/zig-manager");
  assertEquals(xdg.stateDir, "/xdg/state/zig-manager");
  assertEquals(xdg.dataDir, "/xdg/data/zig-manager");
  assertEquals(xdg.cacheDir, "/injected/home/.cache/zig-manager");

  const relocated = new PlatformPaths({
    env: {
      ZIG_MANAGER_HOME: "/isolated/manager home '$;[]",
      XDG_DATA_HOME: "/must/not/win",
    },
    home: "/injected/home",
    platform: "darwin",
  });
  assertEquals(relocated.configDir, "/isolated/manager home '$;[]/config");
  assertEquals(relocated.stateDir, "/isolated/manager home '$;[]/state");
  assertEquals(relocated.dataDir, "/isolated/manager home '$;[]/data");
  assertEquals(relocated.cacheDir, "/isolated/manager home '$;[]/cache");
  assertEquals(
    relocated.assertDataPath(join(relocated.dataDir, "profiles", PROFILE_A)),
    join(relocated.dataDir, "profiles", PROFILE_A),
  );
  assertThrows(() => relocated.assertDataPath("/outside"), TypeError, "escapes");
  assertThrows(
    () =>
      new PlatformPaths({
        env: { ZIG_MANAGER_HOME: "relative" },
        home: "/home/test",
        platform: "linux",
      }),
    TypeError,
    "absolute",
  );
  assertThrows(
    () =>
      new PlatformPaths({
        env: { ZIG_MANAGER_HOME: "/bad\nroot" },
        home: "/home/test",
        platform: "linux",
      }),
    TypeError,
    "control",
  );
  assertThrows(
    () => new PlatformPaths({ env: {}, home: "C:\\Users\\test", platform: "windows" }),
    TypeError,
    "not supported",
  );
});

Deno.test("scope pin protocol accepts only the exact two-line v1 shape", () => {
  const serialized = serializeScopePin(PROFILE_A);
  assertEquals(serialized, `zig-manager-scope-v1\nprofile=${PROFILE_A}\n`);
  assertEquals(parseScopePin(serialized).profileId, PROFILE_A);
  assertEquals(parseScopePin(serialized.slice(0, -1)).profileId, PROFILE_A);

  for (
    const malformed of [
      `zig-manager-scope-v2\nprofile=${PROFILE_A}\n`,
      `zig-manager-scope-v1\r\nprofile=${PROFILE_A}\r\n`,
      `zig-manager-scope-v1\nprofile=${PROFILE_A}\nextra=true\n`,
      `zig-manager-scope-v1\nprofile=${"A".repeat(64)}\n`,
      `zig-manager-scope-v1\nprofile=${"a".repeat(63)}\n`,
      `zig-manager-scope-v1\nprofile=${PROFILE_A}\n\n`,
      `zig-manager-scope-v1\nprofile =${PROFILE_A}\n`,
    ]
  ) {
    assertThrows(() => parseScopePin(malformed), ScopePinError);
  }
});

Deno.test("physical nearest-ancestor pins nest, remove exactly, and reject unsafe scope paths", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-scope-" });
  try {
    const parent = join(root, "project space '$;[]");
    const nested = join(parent, "nested override ![x]");
    const deep = join(nested, "one", "two");
    await Deno.mkdir(deep, { recursive: true });
    const pins = new ScopePinStore();
    const resolver = new ScopeResolver();

    await pins.write(parent, PROFILE_A);
    assertEquals((await resolver.resolve(deep))?.profileId, PROFILE_A);
    assertEquals((await resolver.resolve(deep))?.scopeRoot, await Deno.realPath(parent));

    await pins.write(nested, PROFILE_B);
    const nestedResult = await resolver.resolve(deep);
    assertEquals(nestedResult?.profileId, PROFILE_B);
    assertEquals(nestedResult?.scopeRoot, await Deno.realPath(nested));

    const alias = join(root, "project-alias");
    await Deno.symlink(parent, alias);
    const aliasResult = await resolver.resolve(join(alias, "nested override ![x]", "one", "two"));
    assertEquals(aliasResult?.lookupPath, await Deno.realPath(deep));
    assertEquals(aliasResult?.scopeRoot, await Deno.realPath(nested));

    assertFalse(await pins.remove(deep));
    assertEquals((await resolver.resolve(deep))?.profileId, PROFILE_B);
    await Deno.writeTextFile(join(nested, ".zig-manager", "keep.txt"), "unrelated\n");
    assert(await pins.remove(nested));
    assertEquals((await resolver.resolve(deep))?.profileId, PROFILE_A);
    assert((await Deno.stat(join(nested, ".zig-manager", "keep.txt"))).isFile);

    const oldParentBytes = await Deno.readTextFile(join(parent, ".zig-manager", "toolchain"));
    await assertRejects(() => pins.write(parent, "A".repeat(64)), ScopePinError);
    assertEquals(
      await Deno.readTextFile(join(parent, ".zig-manager", "toolchain")),
      oldParentBytes,
    );
    await pins.write(parent, PROFILE_C);
    assertEquals(
      await Deno.readTextFile(join(parent, ".zig-manager", "toolchain")),
      serializeScopePin(PROFILE_C),
    );

    const controlled = join(root, "bad\nscope");
    await Deno.mkdir(controlled);
    await assertRejects(() => pins.write(controlled, PROFILE_A), Error, "control character");

    const unsafe = join(root, "unsafe-scope");
    const outside = join(root, "outside-metadata");
    await Deno.mkdir(unsafe);
    await Deno.mkdir(outside);
    await Deno.symlink(outside, join(unsafe, ".zig-manager"));
    await assertRejects(() => pins.write(unsafe, PROFILE_A), Error, "physical directory");
    await assertRejects(() => resolver.resolve(unsafe), ScopePinError, "physical directory");
    await assertRejects(() => Deno.lstat(join(outside, "toolchain")), Deno.errors.NotFound);
  } finally {
    await removeTree(root);
  }
});

Deno.test("a malformed nearest pin blocks a valid parent pin", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-malformed-nearest-" });
  try {
    const parent = join(root, "parent");
    const nested = join(parent, "nested", "deep");
    await Deno.mkdir(nested, { recursive: true });
    await new ScopePinStore().write(parent, PROFILE_A);
    await Deno.mkdir(join(parent, "nested", ".zig-manager"));
    await Deno.writeTextFile(
      join(parent, "nested", ".zig-manager", "toolchain"),
      `zig-manager-scope-v1\nprofile=${PROFILE_B}\nextra=blocked\n`,
    );
    const error = await assertRejects(
      () => new ScopeResolver().resolve(nested),
      ScopePinError,
      "exactly two",
    );
    assertStringIncludes(error.pinPath, join("nested", ".zig-manager", "toolchain"));
  } finally {
    await removeTree(root);
  }
});

Deno.test("generated POSIX resolvers enforce nested pins and captured-base fallback", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-shim-contract-" });
  try {
    const paths = new PlatformPaths({
      env: { ZIG_MANAGER_HOME: join(root, "manager home '$;[meta]") },
      home: join(root, "home"),
      platform: "linux",
    });
    const manager = new SessionShimManager(paths);
    const shims = await manager.install();
    assert((await Deno.stat(shims.zig)).mode! & 0o100);
    assert((await Deno.stat(shims.zls)).mode! & 0o100);

    const scriptText = await Deno.readTextFile(shims.zig);
    assertFalse(/(^|[;\s])eval([;\s]|$)/m.test(scriptText));
    assertFalse(/(^|[;\s])source([;\s]|$)/m.test(scriptText));
    assertFalse(scriptText.includes("deno"));
    assertStringIncludes(scriptText, "ZM_BASE_PATH");
    assertEquals((await command("/bin/sh", ["-n", shims.zig], root)).code, 0);

    const managedA = join(paths.installsDir, "zig a '$", "bin", "zig");
    const managedB = join(paths.installsDir, "zig b ;[]", "bin", "zig");
    await writeExecutable(
      managedA,
      '#!/bin/sh\nprintf \'managed-a|%s|%s\\n\' "${1-}" "$PWD"\n',
    );
    await writeExecutable(
      managedB,
      '#!/bin/sh\nprintf \'managed-b|%s|%s\\n\' "${1-}" "$PWD"\n',
    );
    await writeProfile(paths.profilesDir, PROFILE_A, managedA);
    await writeProfile(paths.profilesDir, PROFILE_B, managedB);

    const fallbackDir = join(root, "fallback bin '$;[]");
    const decoyDir = join(root, "ambient decoy");
    await writeExecutable(
      join(fallbackDir, "zig"),
      '#!/bin/sh\nprintf \'fallback|%s|%s\\n\' "${1-}" "$PATH"\n',
    );
    await writeExecutable(
      join(fallbackDir, "zls"),
      "#!/bin/sh\nprintf 'fallback-zls-should-not-run\\n'\n",
    );
    await writeExecutable(join(decoyDir, "zig"), "#!/bin/sh\nprintf 'ambient-decoy\\n'\n");

    const project = join(root, "scope parent '$;[]");
    const nested = join(project, "nested override ![x]");
    const deep = join(nested, "deep space");
    const unpinned = join(root, "unpinned space ;[]");
    await Deno.mkdir(deep, { recursive: true });
    await Deno.mkdir(unpinned);
    const pins = new ScopePinStore();
    await pins.write(project, PROFILE_A);
    await pins.write(nested, PROFILE_B);

    const resolverEnv = {
      PATH: `${decoyDir}:${paths.shimsDir}`,
      ZM_BASE_PATH: fallbackDir,
      ZM_SESSION_ACTIVE: "1",
    };
    const parentRun = await command(shims.zig, ["parent arg"], project, resolverEnv);
    assertEquals(parentRun.code, 0);
    assertEquals(parentRun.stdout, `managed-a|parent arg|${await Deno.realPath(project)}\n`);
    const nestedRun = await command(shims.zig, ["nested arg"], deep, resolverEnv);
    assertEquals(nestedRun.code, 0);
    assertEquals(nestedRun.stdout, `managed-b|nested arg|${await Deno.realPath(deep)}\n`);

    const fallbackRun = await command(shims.zig, ["base arg"], unpinned, resolverEnv);
    assertEquals(fallbackRun.code, 0);
    assertEquals(fallbackRun.stdout, `fallback|base arg|${fallbackDir}\n`);
    assertFalse(fallbackRun.stdout.includes("ambient-decoy"));

    const marker = join(root, "pin-was-executed");
    await Deno.writeTextFile(
      join(nested, ".zig-manager", "toolchain"),
      `zig-manager-scope-v1\nprofile=$(touch ${marker})\n`,
    );
    const malformed = await command(shims.zig, [], deep, resolverEnv);
    assertEquals(malformed.code, 126);
    assertStringIncludes(malformed.stderr, "broken explicit zig pin");
    assertFalse(malformed.stdout.includes("managed-a"));
    await assertRejects(() => Deno.lstat(marker), Deno.errors.NotFound);

    await pins.write(nested, PROFILE_C);
    const missingProfile = await command(shims.zig, [], deep, resolverEnv);
    assertEquals(missingProfile.code, 126);
    assertStringIncludes(missingProfile.stderr, `profile ${PROFILE_C} is missing`);
    assertFalse(missingProfile.stdout.includes("fallback"));

    const escapedInstall = join(root, "outside install", "bin", "zig");
    await writeExecutable(escapedInstall, "#!/bin/sh\nprintf 'escaped-install-ran\\n'\n");
    await Deno.symlink(dirname(dirname(escapedInstall)), join(paths.installsDir, "escaped-link"));
    await writeProfile(
      paths.profilesDir,
      PROFILE_D,
      join(paths.installsDir, "escaped-link", "bin", "zig"),
    );
    await pins.write(nested, PROFILE_D);
    const escapedProfile = await command(shims.zig, [], deep, resolverEnv);
    assertEquals(escapedProfile.code, 126);
    assertStringIncludes(escapedProfile.stderr, "traverses an unsafe directory");
    assertFalse(escapedProfile.stdout.includes("escaped-install-ran"));

    const noManagedZls = await command(shims.zls, [], project, resolverEnv);
    assertEquals(noManagedZls.code, 126);
    assertStringIncludes(noManagedZls.stderr, "has no managed zls");
    assertFalse(noManagedZls.stdout.includes("fallback-zls"));

    const noFallback = await command(shims.zig, [], unpinned, {
      ...resolverEnv,
      ZM_BASE_PATH: join(root, "empty path"),
    });
    assertEquals(noFallback.code, 127);
    assertStringIncludes(noFallback.stderr, "no fallback zig executable");

    const recursive = await command(shims.zig, [], unpinned, {
      ...resolverEnv,
      ZM_BASE_PATH: paths.shimsDir,
    });
    assertEquals(recursive.code, 126);
    assertStringIncludes(recursive.stderr, "refusing recursive zig fallback");
  } finally {
    await removeTree(root);
  }
});

Deno.test("Bash activation output is quoted, idempotent, and deactivates surgically", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-bash-output-" });
  try {
    const paths = new PlatformPaths({
      env: { ZIG_MANAGER_HOME: join(root, "manager home '$;[meta]") },
      home: join(root, "shell home"),
      platform: "linux",
    });
    const activation = generateBashActivation(paths);
    const deactivation = generateBashDeactivation();
    const basePath = "/base one::/base$two:";
    const initialPath = `${paths.shimsDir}:${basePath}`;
    const shellHome = join(root, "isolated shell home");
    await Deno.mkdir(shellHome);

    const bashProgram = [
      'eval "$1"',
      "printf 'first-base=<%s>\\n' \"$ZM_BASE_PATH\"",
      "printf 'first-path=<%s>\\n' \"$PATH\"",
      'PATH="/later change:$PATH:/after"',
      'eval "$1"',
      "printf 'second-base=<%s>\\n' \"$ZM_BASE_PATH\"",
      "printf 'second-path=<%s>\\n' \"$PATH\"",
      'printf \'roots=<%s>|<%s>|<%s>|<%s>\\n\' "$ZM_SESSION_ACTIVE" "$ZM_DATA_DIR" "$ZM_SHIM_DIR" "$ZM_PROFILES_DIR"',
      'eval "$2"',
      "printf 'deactivated-path=<%s>\\n' \"$PATH\"",
      'printf \'deactivated-vars=<%s>|<%s>|<%s>\\n\' "${ZM_SESSION_ACTIVE+set}" "${ZM_BASE_PATH+set}" "${ZM_SHIM_DIR+set}"',
      'eval "$2"',
      "printf 'twice-path=<%s>\\n' \"$PATH\"",
    ].join("\n");
    const result = await command(
      "/bin/bash",
      ["--noprofile", "--norc", "-c", bashProgram, "bash", activation, deactivation],
      root,
      { HOME: shellHome, PATH: initialPath },
    );
    assertEquals(result.code, 0, result.stderr);
    const firstActivePath = `${paths.shimsDir}:${basePath}`;
    const changedWithoutShim = `/later change:${basePath}:/after`;
    const secondActivePath = `${paths.shimsDir}:${changedWithoutShim}`;
    assertStringIncludes(result.stdout, `first-base=<${basePath}>\n`);
    assertStringIncludes(result.stdout, `first-path=<${firstActivePath}>\n`);
    assertStringIncludes(result.stdout, `second-base=<${basePath}>\n`);
    assertStringIncludes(result.stdout, `second-path=<${secondActivePath}>\n`);
    assertStringIncludes(
      result.stdout,
      `roots=<1>|<${paths.dataDir}>|<${paths.shimsDir}>|<${paths.profilesDir}>\n`,
    );
    assertStringIncludes(result.stdout, `deactivated-path=<${changedWithoutShim}>\n`);
    assertStringIncludes(result.stdout, "deactivated-vars=<>|<>|<>\n");
    assertStringIncludes(result.stdout, `twice-path=<${changedWithoutShim}>\n`);
    await assertRejects(() => Deno.lstat(join(shellHome, ".bashrc")), Deno.errors.NotFound);
    await assertRejects(() => Deno.lstat(join(shellHome, ".bash_profile")), Deno.errors.NotFound);
  } finally {
    await removeTree(root);
  }
});

interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function command(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>> = {},
): Promise<CommandResult> {
  const output = await new Deno.Command(executable, {
    args: [...args],
    cwd,
    env: { ...env },
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr),
  };
}

async function writeExecutable(path: string, text: string): Promise<void> {
  await Deno.mkdir(dirname(path), { recursive: true });
  await Deno.writeTextFile(path, text, { mode: 0o755 });
  await Deno.chmod(path, 0o755);
}

async function writeProfile(
  profilesDir: string,
  profileId: string,
  zigPath: string,
): Promise<void> {
  const profileDir = join(profilesDir, profileId);
  await Deno.mkdir(profileDir, { recursive: true });
  await Deno.writeTextFile(join(profileDir, "zig.path"), `${zigPath}\n`);
}

async function removeTree(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound)) throw cause;
  }
}
