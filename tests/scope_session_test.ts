import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { dirname, join } from "@std/path";
import {
  GLOBAL_PROFILE_FILE_NAME,
  GLOBAL_PROFILE_FORMAT_HEADER,
  GlobalProfileError,
  GlobalProfileStore,
  parseGlobalProfile,
  serializeGlobalProfile,
} from "../src/global_profile.ts";
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
  SessionShimError,
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
  assertEquals(fallback.globalBinDir, "/home/test user/.deno/bin");
  assertEquals(
    fallback.globalProfileFile,
    "/home/test user/.local/state/zig-manager/global-profile",
  );

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
  assertEquals(xdg.globalProfileFile, "/xdg/state/zig-manager/global-profile");

  const denoRoot = new PlatformPaths({
    env: { DENO_INSTALL_ROOT: "/tools/deno root" },
    home: "/injected/home",
    platform: "linux",
  });
  assertEquals(denoRoot.globalBinDir, "/tools/deno root/bin");

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
  assertEquals(relocated.globalProfileFile, "/isolated/manager home '$;[]/state/global-profile");
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

Deno.test("global profile protocol and state pointer store are strict and atomic", async () => {
  const serialized = serializeGlobalProfile(PROFILE_A);
  assertEquals(serialized, `${GLOBAL_PROFILE_FORMAT_HEADER}\nprofile=${PROFILE_A}\n`);
  assertEquals(parseGlobalProfile(serialized).profileId, PROFILE_A);
  assertEquals(parseGlobalProfile(serialized.slice(0, -1)).profileId, PROFILE_A);
  for (
    const malformed of [
      `zig-manager-global-v2\nprofile=${PROFILE_A}\n`,
      `${GLOBAL_PROFILE_FORMAT_HEADER}\r\nprofile=${PROFILE_A}\r\n`,
      `${GLOBAL_PROFILE_FORMAT_HEADER}\nprofile=${PROFILE_A}\nextra=true\n`,
      `${GLOBAL_PROFILE_FORMAT_HEADER}\nprofile=${"A".repeat(64)}\n`,
      `${GLOBAL_PROFILE_FORMAT_HEADER}\nprofile=${"a".repeat(63)}\n`,
      `${GLOBAL_PROFILE_FORMAT_HEADER}\nprofile=${PROFILE_A}\n\n`,
      `${GLOBAL_PROFILE_FORMAT_HEADER}\nprofile =${PROFILE_A}\n`,
    ]
  ) {
    assertThrows(() => parseGlobalProfile(malformed), GlobalProfileError);
  }

  const root = await Deno.makeTempDir({ prefix: "zig-manager-global-profile-" });
  try {
    const paths = new PlatformPaths({
      env: { ZIG_MANAGER_HOME: join(root, "manager home '$;[]") },
      home: join(root, "home"),
      platform: "linux",
    });
    const store = new GlobalProfileStore(paths.globalProfileFile);
    assertEquals(await store.read(), null);
    await assertRejects(() => Deno.lstat(paths.stateDir), Deno.errors.NotFound);

    assertEquals(await store.write(PROFILE_A), {
      schema: GLOBAL_PROFILE_FORMAT_HEADER,
      profileId: PROFILE_A,
      pointerPath: paths.globalProfileFile,
    });
    assertEquals(await Deno.readTextFile(paths.globalProfileFile), serialized);
    assertEquals((await store.read())?.profileId, PROFILE_A);

    const original = await Deno.readTextFile(paths.globalProfileFile);
    await assertRejects(() => store.write("A".repeat(64)), GlobalProfileError);
    assertEquals(await Deno.readTextFile(paths.globalProfileFile), original);
    await Deno.writeTextFile(
      paths.globalProfileFile,
      `zig-manager-global-v2\nprofile=${PROFILE_A}\n`,
    );
    await assertRejects(() => store.read(), GlobalProfileError, "first line");
    await store.write(PROFILE_B);
    assertEquals((await store.read())?.profileId, PROFILE_B);
    assert(await store.remove());
    assertFalse(await store.remove());
    await Deno.writeTextFile(paths.globalProfileFile, "malformed pointer\n");
    assert(await store.remove());

    const outside = join(root, "outside-global-profile");
    await Deno.writeTextFile(outside, serializeGlobalProfile(PROFILE_A));
    await Deno.symlink(outside, paths.globalProfileFile);
    await assertRejects(() => store.read(), GlobalProfileError, "physical regular file");
    await assertRejects(() => store.write(PROFILE_B), GlobalProfileError, "physical regular file");
    await assertRejects(() => store.remove(), GlobalProfileError, "physical regular file");
    assertEquals(await Deno.readTextFile(outside), serializeGlobalProfile(PROFILE_A));
    await Deno.remove(paths.globalProfileFile);

    const realState = join(root, "real-state");
    const linkedState = join(root, "linked-state");
    await Deno.mkdir(realState);
    await Deno.symlink(realState, linkedState);
    const linkedStore = new GlobalProfileStore(join(linkedState, GLOBAL_PROFILE_FILE_NAME));
    await assertRejects(() => linkedStore.read(), GlobalProfileError, "physical directory");
    await assertRejects(
      () => linkedStore.write(PROFILE_A),
      GlobalProfileError,
      "physical directory",
    );

    const names: string[] = [];
    for await (const entry of Deno.readDir(paths.stateDir)) names.push(entry.name);
    assertFalse(names.some((name) => name.includes(".tmp-")));
  } finally {
    await removeTree(root);
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

Deno.test("generated POSIX resolvers enforce local, global, then captured-base precedence", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-shim-contract-" });
  try {
    const paths = new PlatformPaths({
      env: { ZIG_MANAGER_HOME: join(root, "manager home '$;[meta]") },
      home: join(root, "home"),
      platform: "linux",
    });
    const manager = new SessionShimManager(paths);
    const shims = await manager.install();
    const persistent = await manager.installPersistent();
    assert((await Deno.stat(shims.zig)).mode! & 0o100);
    assert((await Deno.stat(shims.zls)).mode! & 0o100);
    assert((await Deno.stat(persistent.zig)).mode! & 0o100);
    assert((await Deno.stat(persistent.zls)).mode! & 0o100);

    const scriptText = await Deno.readTextFile(shims.zig);
    assertFalse(/(^|[;\s])eval([;\s]|$)/m.test(scriptText));
    assertFalse(/(^|[;\s])source([;\s]|$)/m.test(scriptText));
    assertFalse(scriptText.includes("deno run"));
    assertStringIncludes(scriptText, "ZM_BASE_PATH");
    assertEquals((await command("/bin/sh", ["-n", shims.zig], root)).code, 0);

    const managedA = join(paths.installsDir, "zig a '$", "bin", "zig");
    const managedB = join(paths.installsDir, "zig b ;[]", "bin", "zig");
    const managedZlsB = join(paths.installsDir, "zls b ![]", "bin", "zls");
    await writeExecutable(
      managedA,
      '#!/bin/sh\nprintf \'managed-a|%s|%s\\n\' "${1-}" "$PWD"\n',
    );
    await writeExecutable(
      managedB,
      '#!/bin/sh\nprintf \'managed-b|%s|%s\\n\' "${1-}" "$PWD"\n',
    );
    await writeExecutable(
      managedZlsB,
      '#!/bin/sh\nprintf \'managed-zls-b|%s|%s\\n\' "${1-}" "$PWD"\n',
    );
    await writeProfile(paths.profilesDir, PROFILE_A, managedA);
    await writeProfile(paths.profilesDir, PROFILE_B, managedB, managedZlsB);
    const globalProfile = new GlobalProfileStore(paths.globalProfileFile);
    await globalProfile.write(PROFILE_A);

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

    const globalRun = await command(shims.zig, ["global arg"], unpinned, resolverEnv);
    assertEquals(globalRun.code, 0);
    assertEquals(globalRun.stdout, `managed-a|global arg|${await Deno.realPath(unpinned)}\n`);
    await globalProfile.write(PROFILE_B);
    const updatedGlobalRun = await command(shims.zig, ["updated global"], unpinned, resolverEnv);
    assertEquals(updatedGlobalRun.code, 0);
    assertEquals(
      updatedGlobalRun.stdout,
      `managed-b|updated global|${await Deno.realPath(unpinned)}\n`,
    );
    const globalZlsRun = await command(shims.zls, ["global zls"], unpinned, resolverEnv);
    assertEquals(globalZlsRun.code, 0);
    assertEquals(
      globalZlsRun.stdout,
      `managed-zls-b|global zls|${await Deno.realPath(unpinned)}\n`,
    );

    const persistentEnv = { PATH: `${paths.globalBinDir}:${fallbackDir}` };
    const persistentLocal = await command(
      persistent.zig,
      ["persistent local"],
      deep,
      persistentEnv,
    );
    assertEquals(persistentLocal.code, 0, persistentLocal.stderr);
    assertEquals(
      persistentLocal.stdout,
      `managed-b|persistent local|${await Deno.realPath(deep)}\n`,
    );
    const persistentGlobal = await command(
      persistent.zls,
      ["persistent global"],
      unpinned,
      persistentEnv,
    );
    assertEquals(persistentGlobal.code, 0, persistentGlobal.stderr);
    assertEquals(
      persistentGlobal.stdout,
      `managed-zls-b|persistent global|${await Deno.realPath(unpinned)}\n`,
    );

    await globalProfile.remove();
    const fallbackRun = await command(shims.zig, ["base arg"], unpinned, resolverEnv);
    assertEquals(fallbackRun.code, 0);
    assertEquals(fallbackRun.stdout, `fallback|base arg|${fallbackDir}\n`);
    assertFalse(fallbackRun.stdout.includes("ambient-decoy"));
    const persistentFallback = await command(
      persistent.zig,
      ["persistent fallback"],
      unpinned,
      persistentEnv,
    );
    assertEquals(persistentFallback.code, 0, persistentFallback.stderr);
    assertEquals(persistentFallback.stdout, `fallback|persistent fallback|${fallbackDir}\n`);
    await globalProfile.write(PROFILE_B);

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

    await Deno.writeTextFile(
      paths.globalProfileFile,
      `zig-manager-global-v2\nprofile=${PROFILE_B}\n`,
    );
    const malformedGlobal = await command(shims.zig, [], unpinned, resolverEnv);
    assertEquals(malformedGlobal.code, 126);
    assertStringIncludes(malformedGlobal.stderr, "global profile pointer");
    assertFalse(malformedGlobal.stdout.includes("fallback"));

    const outsideGlobal = join(root, "outside valid global profile");
    await Deno.writeTextFile(outsideGlobal, serializeGlobalProfile(PROFILE_B));
    await Deno.remove(paths.globalProfileFile);
    await Deno.symlink(outsideGlobal, paths.globalProfileFile);
    const linkedGlobal = await command(shims.zig, [], unpinned, resolverEnv);
    assertEquals(linkedGlobal.code, 126);
    assertStringIncludes(linkedGlobal.stderr, "not a physical regular file");
    assertFalse(linkedGlobal.stdout.includes("fallback"));
    await Deno.remove(paths.globalProfileFile);

    await Deno.mkdir(join(paths.profilesDir, PROFILE_C));
    await globalProfile.write(PROFILE_C);
    const missingGlobalZig = await command(shims.zig, [], unpinned, resolverEnv);
    assertEquals(missingGlobalZig.code, 126);
    assertStringIncludes(missingGlobalZig.stderr, "has no zig.path");
    assertFalse(missingGlobalZig.stdout.includes("fallback"));

    await globalProfile.write(PROFILE_A);
    const missingGlobalZls = await command(shims.zls, [], unpinned, resolverEnv);
    assertEquals(missingGlobalZls.code, 126);
    assertStringIncludes(missingGlobalZls.stderr, "has no managed zls");
    assertFalse(missingGlobalZls.stdout.includes("fallback-zls"));
    await globalProfile.remove();

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

    assertEquals(await manager.removePersistent(), { zig: true, zls: true });
    assertEquals(await manager.removePersistent(), { zig: false, zls: false });
  } finally {
    await removeTree(root);
  }
});

Deno.test("persistent resolvers never replace executables they do not own", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-persistent-ownership-" });
  try {
    const paths = new PlatformPaths({
      env: { DENO_INSTALL_ROOT: join(root, "deno") },
      home: join(root, "home"),
      platform: "linux",
    });
    await Deno.mkdir(paths.globalBinDir, { recursive: true });
    const unrelated = "#!/bin/sh\nprintf 'unrelated\\n'\n";
    await Deno.writeTextFile(join(paths.globalBinDir, "zig"), unrelated, { mode: 0o755 });
    const manager = new SessionShimManager(paths);
    const internal = await manager.install();
    await assertRejects(
      () => manager.installPersistent(),
      SessionShimError,
      "refusing to replace",
    );
    assertEquals(await Deno.readTextFile(join(paths.globalBinDir, "zig")), unrelated);
    await assertRejects(() => Deno.lstat(join(paths.globalBinDir, "zls")), Deno.errors.NotFound);
    assertEquals(await manager.removePersistent(), { zig: false, zls: false });
    assertEquals(await Deno.readTextFile(join(paths.globalBinDir, "zig")), unrelated);
    const fallback = await command(internal.zig, [], root, { PATH: paths.globalBinDir });
    assertEquals(fallback.code, 0, fallback.stderr);
    assertEquals(fallback.stdout, "unrelated\n");
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
  zlsPath?: string,
): Promise<void> {
  const profileDir = join(profilesDir, profileId);
  await Deno.mkdir(profileDir, { recursive: true });
  await Deno.writeTextFile(join(profileDir, "zig.path"), `${zigPath}\n`);
  if (zlsPath !== undefined) {
    await Deno.writeTextFile(join(profileDir, "zls.path"), `${zlsPath}\n`);
  }
}

async function removeTree(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound)) throw cause;
  }
}
