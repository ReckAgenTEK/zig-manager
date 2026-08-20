import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { dirname, join } from "@std/path";
import {
  BuildPrerequisiteError,
  GlobalCatalog,
  InstallStore,
  PlatformPaths,
  ScopePinStore,
  ScopeRegistryStore,
  serializeScopePin,
  ToolchainProfileStore,
  ZigDependencyInUseError,
  ZigHostUnsupportedError,
  ZigInstallCorruptError,
  ZigInstallInUseError,
  ZigInvalidArgumentError,
  ZigManager,
  ZigOperationAbortedError,
  ZigProfileNotFoundError,
  ZigScopeNotPinnedError,
  ZlsCompatibilityNotFoundError,
} from "../src/mod.ts";
import { buildManagedZig, buildStagingRoot } from "../src/build.ts";
import {
  type GlobalOperationLockAcquireOptions,
  GlobalOperationLockManager,
  type GlobalOperationLockTarget,
} from "../src/global_operation_lock.ts";
import type { ZigManagerServices } from "../src/zig_manager.ts";
import { GlobalProfileStore } from "../src/global_profile.ts";
import { isPairedToolchainProfile } from "../src/profile_store.ts";
import {
  cleanup,
  COMMIT_A,
  COMMIT_B,
  COMMIT_D,
  COMMIT_F,
  createDevelopmentFiles,
  FakeProcessRunner,
  FakeSourceRef,
} from "./test_helpers.ts";

const HOST_TARGET = "x86_64-unknown-linux-gnu";

Deno.test("default host gate rejects unsupported runtimes before manager mutation", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-host-gate-" });
  try {
    const project = join(root, "project");
    const home = join(root, "manager-home");
    await Deno.mkdir(project);
    const manager = new ZigManager({
      env: { HOME: root, ZIG_MANAGER_HOME: home },
      home: root,
      cwd: project,
      platform: "darwin",
      architecture: "x86_64",
      hostTarget: "x86_64-apple-darwin",
    });
    await assertRejects(
      () => manager.current(),
      ZigHostUnsupportedError,
      "x86_64-unknown-linux-gnu",
    );
    await assertRejects(() => Deno.lstat(home), Deno.errors.NotFound);
    assertThrows(
      () => {
        new ZigManager({
          env: { HOME: root, ZIG_MANAGER_HOME: home },
          home: root,
          cwd: project,
          platform: "windows",
        });
      },
      ZigHostUnsupportedError,
      "Windows runtime support is deferred",
    );
  } finally {
    await cleanup(root);
  }
});

Deno.test("use builds globally but publishes only a directory pin and no global current pointer", async () => {
  await withManager(async ({ manager, project, home, runner }) => {
    const result = await manager.use("0.16");
    assertEquals(result.schemaVersion, 2);
    assertEquals(result.selection, "local");
    assertEquals(result.zig?.installationId, result.installationId);
    assertEquals(result.zls?.selector, "0.16.2");
    assertEquals(await manager.which("zls"), result.zls?.executable);
    assertEquals(result.scopeRoot, await Deno.realPath(project));
    assertEquals(
      await Deno.readTextFile(join(project, ".zig-manager", "toolchain")),
      serializeScopePin(result.profileId),
    );
    assertEquals((await manager.current()).profileId, result.profileId);
    await assertRejects(() => Deno.lstat(join(home, "data", "current")), Deno.errors.NotFound);
    await assertRejects(() => Deno.lstat(join(home, "data", "zig")), Deno.errors.NotFound);
    const profile = await new ToolchainProfileStore({
      dataRoot: manager.paths.dataDir,
      installs: new InstallStore({ dataRoot: manager.paths.dataDir }),
    }).read(result.profileId);
    assert(isPairedToolchainProfile(profile));
    assertEquals(profile.schemaVersion, 2);
    assertEquals(profile.components.zls, result.zls?.installationId);
    const zlsManifest = JSON.parse(
      await Deno.readTextFile(
        join(
          manager.paths.installsDir,
          "zls",
          result.zls!.installationId,
          "install-manifest.json",
        ),
      ),
    );
    assertEquals(zlsManifest.dependencies, [{
      component: "zig",
      installationId: result.installationId,
    }]);
    assertEquals((await manager.list()).installations.map((item) => item.component), [
      "zig",
      "zls",
    ]);
    const buildAndVerification = runner.requests.filter((request) =>
      request.args[0] === "-S" || request.args[0] === "--build" ||
      request.args[0] === "build-exe" || request.args[0] === "version" ||
      request.args[0] === "env"
    );
    assert(buildAndVerification.every((request) => request.clearEnv === true));
    assert(buildAndVerification.every((request) => request.env?.CFLAGS !== "ambient poison"));
  });
});

Deno.test("stable ZLS discovery is reused across scopes without ZLS source work", async () => {
  await withManager(async ({ manager, sourceRef, project, other }) => {
    const first = await manager.use("stable", { path: project });
    assertEquals(first.zls?.selector, "0.16.2");
    assertEquals(
      sourceRef.zlsCalls.filter((call) => call === "listRemoteRefs").length,
      1,
    );
    assertEquals(
      JSON.parse(
        await Deno.readTextFile(
          join(manager.paths.stableZlsDir, `${first.installationId}.json`),
        ),
      ).zlsInstallationId,
      first.zls?.installationId,
    );

    sourceRef.zlsCalls.length = 0;
    sourceRef.failZlsRemote = true;
    const reused = await manager.use("stable", { path: other });

    assertEquals(reused.reused, true);
    assertEquals(reused.zls?.installationId, first.zls?.installationId);
    assertEquals(reused.profileId, first.profileId);
    assertEquals(sourceRef.zlsCalls, []);
  });
});

Deno.test("stable ZLS discovery skips newer tags incompatible with the exact Zig", async () => {
  await withManager(async ({ manager, sourceRef }) => {
    addStableZls(sourceRef, "0.16.3", COMMIT_F, "0.16.1");

    const selected = await manager.use("stable");

    assertEquals(selected.version, "0.16.0");
    assertEquals(selected.zls?.selector, "0.16.2");
    assertEquals(
      sourceRef.zlsCalls.filter((call) => call === "listRemoteRefs").length,
      1,
    );
  });
});

Deno.test("refresh-zls advances stable ZLS and later scopes reuse it without remote access", async () => {
  await withManager(async ({ manager, sourceRef, project, other }) => {
    const first = await manager.use("stable", { path: project });
    addStableZls(sourceRef, "0.16.3", COMMIT_F);
    sourceRef.zlsCalls.length = 0;

    const refreshed = await manager.use("stable", { path: project, refreshZls: true });
    assertEquals(refreshed.zls?.selector, "0.16.3");
    assert(refreshed.zls?.installationId !== first.zls?.installationId);
    assert(refreshed.profileId !== first.profileId);
    assertEquals(
      sourceRef.zlsCalls.filter((call) => call === "listRemoteRefs").length,
      1,
    );
    assertEquals(
      JSON.parse(
        await Deno.readTextFile(
          join(manager.paths.stableZlsDir, `${refreshed.installationId}.json`),
        ),
      ).zlsInstallationId,
      refreshed.zls?.installationId,
    );

    sourceRef.zlsCalls.length = 0;
    sourceRef.failZlsRemote = true;
    const reused = await manager.use("stable", { path: other });
    assertEquals(reused.zls?.installationId, refreshed.zls?.installationId);
    assertEquals(reused.profileId, refreshed.profileId);
    assertEquals(sourceRef.zlsCalls, []);
  });
});

Deno.test("failed stable ZLS refresh preserves the effective association and local pin", async () => {
  await withManager(async ({ manager, sourceRef, runner, project, other }) => {
    const first = await manager.use("stable", { path: project });
    const pinBytes = await Deno.readFile(first.pinPath);
    const stablePinPath = join(manager.paths.stableZlsDir, `${first.installationId}.json`);
    const stablePinBytes = await Deno.readFile(stablePinPath);
    addStableZls(sourceRef, "0.16.3", COMMIT_F);
    runner.failZlsBuild = true;

    await assertRejects(
      () => manager.use("stable", { path: project, refreshZls: true }),
      Error,
      "building ZLS",
    );
    assertEquals(await Deno.readFile(first.pinPath), pinBytes);
    assertEquals(await Deno.readFile(stablePinPath), stablePinBytes);
    assertEquals((await manager.current({ path: project })).profileId, first.profileId);

    runner.failZlsBuild = false;
    sourceRef.zlsCalls.length = 0;
    sourceRef.failZlsRemote = true;
    const reused = await manager.use("stable", { path: other });
    assertEquals(reused.zls?.installationId, first.zls?.installationId);
    assertEquals(reused.profileId, first.profileId);
    assertEquals(sourceRef.zlsCalls, []);
  });
});

Deno.test("stable Zig advancement gets a distinct stable ZLS association", async () => {
  await withManager(async ({ manager, sourceRef, runner, project, other }) => {
    const first = await manager.use("stable", { path: project });
    sourceRef.refs.push({ kind: "tag", name: "0.16.1", commit: COMMIT_B });
    runner.zigVersion = "0.16.1";
    sourceRef.zlsCalls.length = 0;

    const moved = await manager.use("stable", { path: other });
    assertEquals(moved.commit, COMMIT_B);
    assertEquals(moved.version, "0.16.1");
    assert(moved.installationId !== first.installationId);
    assert(moved.zls?.installationId !== first.zls?.installationId);
    assertEquals(moved.zls?.selector, "0.16.2");
    assertEquals(
      sourceRef.zlsCalls.filter((call) => call === "listRemoteRefs").length,
      1,
    );
  });
});

Deno.test("update re-resolves stable Zig but reuses its pinned ZLS without source work", async () => {
  await withManager(async ({ manager, sourceRef, project }) => {
    const first = await manager.use("stable", { path: project });
    sourceRef.zlsCalls.length = 0;
    sourceRef.failZlsRemote = true;

    const updated = await manager.update({ path: project });
    assertEquals(updated.profileId, first.profileId);
    assertEquals(updated.zls?.installationId, first.zls?.installationId);
    assertEquals(updated.reused, true);
    assertEquals(updated.changed, false);
    assertEquals(sourceRef.zlsCalls, []);
  });
});

Deno.test("successful scope mutations reconcile the advisory registry", async () => {
  await withManager(async ({ manager, project, home }) => {
    const used = await manager.use("0.16");
    const persistentZig = join(manager.paths.globalBinDir, "zig");
    const persistentZls = join(manager.paths.globalBinDir, "zls");
    assert((await Deno.lstat(persistentZig)).isFile);
    assert((await Deno.lstat(persistentZls)).isFile);
    const registry = new ScopeRegistryStore(join(home, "state", "scopes.json"));
    assertEquals((await registry.read())?.scopes, [{
      scopeRoot: await Deno.realPath(project),
      profileId: used.profileId,
      lastOperation: "use 0.16",
      updatedAt: (await registry.read())!.scopes[0].updatedAt,
    }]);

    await manager.unuse();
    assertEquals((await registry.read())?.scopes, []);
  });
});

Deno.test("registry failure after pin commit warns but returns the successful use", async () => {
  const warnings: string[] = [];
  let attempted = false;
  await withManager(
    async ({ manager, project }) => {
      const used = await manager.use("0.16");
      assert(attempted);
      assertEquals(
        await Deno.readTextFile(join(project, ".zig-manager", "toolchain")),
        serializeScopePin(used.profileId),
      );
      assertStringIncludes(warnings.join(""), "scope pin operation succeeded");
      assertStringIncludes(warnings.join(""), "zm repair --path");
    },
    undefined,
    {
      scopeRegistry: {
        inspect: () => Promise.reject(new Error("unused inspection")),
        record: () => {
          attempted = true;
          return Promise.reject(new Error("synthetic registry failure"));
        },
        remove: () => Promise.resolve(false),
      },
    },
    (message) => warnings.push(message),
  );
});

Deno.test("use publishes profile and catalog before writing the scope pin", async () => {
  const events: string[] = [];
  await withManager(async ({ manager }) => {
    await manager.use("0.16");
    assertEquals(events, ["profile", "catalog", "pin"]);
  }, events);
});

Deno.test("remote, build, and verification failures preserve prior pin bytes", async () => {
  await withManager(async ({ manager, sourceRef, runner, project }) => {
    await manager.use("0.16");
    const pinPath = join(project, ".zig-manager", "toolchain");
    const prior = await Deno.readTextFile(pinPath);

    sourceRef.failRemote = true;
    await assertRejects(() => manager.use("stable"), Error, "remote unavailable");
    assertEquals(await Deno.readTextFile(pinPath), prior);

    sourceRef.failRemote = false;
    sourceRef.refs.push({ kind: "tag", name: "0.16.1", commit: COMMIT_B });
    runner.wrongZigVersion = true;
    await assertRejects(() => manager.use("0.16"), Error, "version");
    assertEquals(await Deno.readTextFile(pinPath), prior);
  });
});

Deno.test("ZLS build failure preserves both pointers and leaves the completed Zig cached", async () => {
  await withManager(async ({ manager, sourceRef, runner, project }) => {
    const first = await manager.use("0.16");
    const priorPin = await Deno.readFile(first.pinPath);
    sourceRef.refs.push({ kind: "tag", name: "0.16.1", commit: COMMIT_B });
    runner.zigVersion = "0.16.1";
    runner.failZlsBuild = true;

    await assertRejects(() => manager.use("0.16.1"), Error, "building ZLS");
    assertEquals(await Deno.readFile(join(project, ".zig-manager", "toolchain")), priorPin);
    assertEquals((await manager.current()).profileId, first.profileId);
    const listed = await manager.list();
    assertEquals(
      listed.installations.filter((item) => item.component === "zig").map((item) => item.version)
        .sort(),
      ["0.16.1", "0.16.0"].sort(),
    );
    assertEquals(listed.installations.filter((item) => item.component === "zls").length, 1);
    await assertRejects(
      () => Deno.lstat(manager.paths.globalProfileFile),
      Deno.errors.NotFound,
    );
  });
});

Deno.test("all development selectors require ZLS remote HEAD to declare the same cycle", async () => {
  await withManager(async ({ manager, sourceRef, runner }) => {
    sourceRef.refs.push({ kind: "branch", name: "development", commit: COMMIT_B });
    sourceRef.versions.set(COMMIT_B, { base: "0.17.0", tag: "0.16.0", distance: 4 });
    runner.zigVersion = `0.17.0-dev.4+${COMMIT_B.slice(0, 9)}`;
    sourceRef.head = { branch: "master", commit: COMMIT_B };
    sourceRef.refs = sourceRef.refs.map((ref) =>
      ref.kind === "branch" && ref.name === "master" ? { ...ref, commit: COMMIT_B } : ref
    );
    sourceRef.zlsHead = { branch: "master", commit: COMMIT_D };
    sourceRef.zlsRefs = sourceRef.zlsRefs.map((ref) =>
      ref.kind === "branch" && ref.name === "master" ? { ...ref, commit: COMMIT_D } : ref
    );

    await assertRejects(
      () => manager.use("latest"),
      ZlsCompatibilityNotFoundError,
      "development cycle 0.16, not 0.17",
    );
    await assertRejects(
      () => manager.use("branch:development"),
      ZlsCompatibilityNotFoundError,
      "development cycle 0.16, not 0.17",
    );
    assertEquals(
      (await manager.list()).installations.filter((item) => item.component === "zig").length,
      1,
    );

    sourceRef.zlsHead = { branch: "master", commit: COMMIT_F };
    sourceRef.zlsRefs = sourceRef.zlsRefs.map((ref) =>
      ref.kind === "branch" && ref.name === "master" ? { ...ref, commit: COMMIT_F } : ref
    );
    const used = await manager.use("branch:development");
    assertEquals(used.zls?.selector, "latest");
    assertStringIncludes(used.zls?.version ?? "", "0.17.0-dev");
  });
});

Deno.test("local selection overrides global, unuse reveals global, then external fallback wins", async () => {
  await withManager(async ({
    manager,
    project,
    nested,
    other,
    fallbackZig,
    fallbackZls,
    runner,
  }) => {
    const global = await manager.use("0.16", { global: true });
    assertEquals(global.selection, "global");
    assertEquals(global.scopeRoot, null);
    assertEquals(global.pinPath, manager.paths.globalProfileFile);
    assertEquals(
      (await new GlobalProfileStore(manager.paths.globalProfileFile).read())?.profileId,
      global.profileId,
    );
    assertEquals((await manager.current({ path: other })).selection, "global");
    assertEquals(await manager.which("zls", { path: other }), global.zls?.executable);

    runner.zigVersion = "0.16.1";
    const local = await manager.use("latest", { path: project });
    const localStatus = await manager.current({ path: nested });
    const globalStatus = await manager.current({ global: true });
    assertEquals(localStatus.selection, "local");
    assertEquals(localStatus.profileId, local.profileId);
    assertEquals(localStatus.zls?.installationId, local.zls?.installationId);
    assertEquals(globalStatus.selection, "global");
    assertEquals(globalStatus.profileId, global.profileId);
    assertEquals(await manager.which("zig", { path: nested }), local.zig?.executable);
    assertEquals(await manager.which("zls", { path: nested }), local.zls?.executable);

    for (const selected of [global, local]) {
      const manifest = JSON.parse(
        await Deno.readTextFile(
          join(
            manager.paths.installsDir,
            "zls",
            selected.zls!.installationId,
            "install-manifest.json",
          ),
        ),
      );
      assertEquals(manifest.dependencies[0].installationId, selected.installationId);
    }

    await manager.unuse({ path: project });
    assertEquals((await manager.current({ path: nested })).profileId, global.profileId);
    const removed = await manager.unuse({ global: true });
    assertEquals(removed.selection, "global");
    assertEquals((await manager.current({ path: other })).selection, "fallback");
    assertEquals(await manager.which("zig", { path: other }), fallbackZig);
    assertEquals(await manager.which("zls", { path: other }), fallbackZls);
    assertEquals((await manager.run(["version"], { cwd: other })).code, 0);

    await assertRejects(
      () => manager.current({ global: true, path: other }),
      ZigInvalidArgumentError,
      "cannot be combined",
    );
    await assertRejects(
      () => manager.use("0.16", { global: true, path: other }),
      ZigInvalidArgumentError,
      "cannot be combined",
    );
  });
});

Deno.test("broken global pointers error instead of falling through to external tools", async () => {
  await withManager(async ({ manager, other, fallbackZig }) => {
    const missing = "9".repeat(64);
    await new GlobalProfileStore(manager.paths.globalProfileFile).write(missing);
    await assertRejects(
      () => manager.current({ path: other }),
      ZigProfileNotFoundError,
      missing,
    );
    assert(fallbackZig.length > 0);

    await Deno.writeTextFile(manager.paths.globalProfileFile, "malformed global pointer\n");
    await assertRejects(
      () => manager.which("zig", { path: other }),
      Error,
      "global profile pointer",
    );
  });
});

Deno.test("global update publishes the complete moving pair last and global sync verifies it", async () => {
  await withManager(async ({ manager, sourceRef, runner }) => {
    sourceRef.head = { branch: "master", commit: COMMIT_A };
    sourceRef.refs = sourceRef.refs.map((ref) =>
      ref.kind === "branch" && ref.name === "master" ? { ...ref, commit: COMMIT_A } : ref
    );
    runner.zigVersion = "0.16.0";
    const first = await manager.use("latest", { global: true });

    sourceRef.head = { branch: "master", commit: COMMIT_B };
    sourceRef.refs = sourceRef.refs.map((ref) =>
      ref.kind === "branch" && ref.name === "master" ? { ...ref, commit: COMMIT_B } : ref
    );
    runner.zigVersion = "0.16.1";
    const updated = await manager.update({ global: true });
    assertEquals(updated.selection, "global");
    assertEquals(updated.previousProfileId, first.profileId);
    assertEquals(updated.changed, true);
    assertEquals(
      (await new GlobalProfileStore(manager.paths.globalProfileFile).read())?.profileId,
      updated.profileId,
    );
    const dependency = JSON.parse(
      await Deno.readTextFile(
        join(
          manager.paths.installsDir,
          "zls",
          updated.zls!.installationId,
          "install-manifest.json",
        ),
      ),
    ).dependencies[0];
    assertEquals(dependency.installationId, updated.installationId);

    sourceRef.calls.length = 0;
    sourceRef.zlsCalls.length = 0;
    const synced = await manager.sync({ global: true });
    assertEquals(synced.selection, "global");
    assertEquals(synced.profileId, updated.profileId);
    assertEquals(synced.rebuilt, false);
    assertEquals(sourceRef.calls, []);
    assertEquals(sourceRef.zlsCalls, []);
  });
});

Deno.test("useInstalled is local and makes no source-ref calls", async () => {
  await withManager(async ({ manager, sourceRef, other }) => {
    const installed = await manager.install("0.16");
    sourceRef.calls.length = 0;
    sourceRef.zlsCalls.length = 0;
    const used = await manager.useInstalled(installed.installationId, { path: other });
    assertEquals(used.installationId, installed.installationId);
    assertEquals(used.profileId, installed.profileId);
    assertEquals(used.zls?.installationId, installed.zls?.installationId);
    assertEquals(sourceRef.calls, []);
    assertEquals(sourceRef.zlsCalls, []);
    assertEquals((await manager.current({ path: other })).profileId, used.profileId);
  });
});

Deno.test("nearest current, which, and run work without shell activation", async () => {
  await withManager(async ({ manager, runner, project, nested, other, fallbackZig }) => {
    const used = await manager.use("0.16", { path: project });
    const current = await manager.current({ path: nested });
    assertEquals(current.scopeRoot, await Deno.realPath(project));
    assertEquals(current.profileId, used.profileId);
    assertEquals(await manager.which("zig", { path: nested }), used.executable);

    const run = await manager.run(["version"], { cwd: nested });
    assertEquals(run.code, 0);
    assertEquals(runner.requests.at(-1)?.executable, used.executable);

    const fallback = await manager.current({ path: other });
    assertEquals(fallback.mode, "fallback");
    assertEquals(fallback.executable, fallbackZig);
    assertEquals(await manager.which("zig", { path: other }), fallbackZig);
    const shell = await manager.shellStatus({ path: other });
    assertEquals(shell.fallbackZig, fallbackZig);
    assertEquals(shell.fallbackVersion, "0.16.0");
    assertEquals(shell.fallbackUsable, true);
  });
});

Deno.test("unuse removes only an exact pin and never an inherited parent", async () => {
  await withManager(async ({ manager, project, nested }) => {
    await manager.use("0.16", { path: project });
    const error = await assertRejects(
      () => manager.unuse({ path: nested }),
      ZigScopeNotPinnedError,
      "inherited",
    );
    assertEquals(error.details.inheritedFrom, await Deno.realPath(project));
    assert((await Deno.lstat(join(project, ".zig-manager", "toolchain"))).isFile);

    const removed = await manager.unuse({ path: project });
    assertEquals(removed.scopeRoot, await Deno.realPath(project));
    assertEquals((await manager.current({ path: nested })).mode, "fallback");
  });
});

Deno.test("uninstall requires explicit profile pruning and rebuilds the catalog", async () => {
  await withManager(async ({ manager }) => {
    const installed = await manager.install("0.16");
    const used = await manager.useInstalled(installed.installationId);
    const inUse = await assertRejects(
      () => manager.uninstall(installed.installationId),
      ZigInstallInUseError,
      "retained profiles",
    );
    assertEquals(inUse.details.profileIds, [used.profileId]);

    await manager.unuse();
    const dryRun = await manager.gc({ profiles: true, dryRun: true });
    assert(dryRun.removed.some((path) => path.endsWith(used.profileId)));
    assert((await Deno.lstat(join(manager.paths.profilesDir, used.profileId))).isDirectory);
    const gc = await manager.gc({ profiles: true });
    assert(gc.removed.some((path) => path.endsWith(used.profileId)));
    const dependency = await assertRejects(
      () => manager.uninstall(installed.installationId),
      ZigDependencyInUseError,
      "required by retained ZLS",
    );
    assertEquals(dependency.details.dependentInstallationIds, [installed.zls!.installationId]);
    await manager.uninstall(installed.zls!.installationId);
    const removed = await manager.uninstall(installed.installationId);
    assertEquals(removed.installationId, installed.installationId);
    assertEquals(removed.component, "zig");
    await assertRejects(() => Deno.lstat(removed.root), Deno.errors.NotFound);
    assertEquals((await manager.list()).installations, []);
  });
});

Deno.test("uninstall clears a stable ZLS association before removing its installation", async () => {
  await withManager(async ({ manager, sourceRef, project, other }) => {
    const used = await manager.use("stable", { path: project });
    const stablePinPath = join(manager.paths.stableZlsDir, `${used.installationId}.json`);
    await manager.unuse({ path: project });
    await manager.gc({ profiles: true });

    await manager.uninstall(used.zls!.installationId);
    await assertRejects(() => Deno.lstat(stablePinPath), Deno.errors.NotFound);

    sourceRef.zlsCalls.length = 0;
    const restored = await manager.use("stable", { path: other });
    assertEquals(restored.zls?.selector, used.zls?.selector);
    assertEquals(
      sourceRef.zlsCalls.filter((call) => call === "listRemoteRefs").length,
      1,
    );
    assertEquals(
      JSON.parse(await Deno.readTextFile(stablePinPath)).zlsInstallationId,
      restored.zls?.installationId,
    );
  });
});

Deno.test("gc retains every profile when the advisory registry is missing", async () => {
  await withManager(async ({ manager, home }) => {
    const used = await manager.use("0.16");
    await Deno.remove(join(home, "state", "scopes.json"));
    const result = await manager.gc({ profiles: true });
    assertEquals(result.registry?.state, "missing");
    assertStringIncludes(result.retained.join("\n"), "complete set of scope references is unknown");
    assert((await Deno.lstat(join(home, "data", "profiles", used.profileId))).isDirectory);
  });
});

Deno.test("gc reports a malformed registry and retains every profile", async () => {
  await withManager(async ({ manager, home }) => {
    const used = await manager.use("0.16");
    await Deno.writeTextFile(join(home, "state", "scopes.json"), "{malformed\n");
    const result = await manager.gc({ profiles: true });
    assertEquals(result.registry?.state, "invalid");
    assertStringIncludes(result.retained.join("\n"), "cannot be inspected safely");
    assert((await Deno.lstat(join(home, "data", "profiles", used.profileId))).isDirectory);
  });
});

Deno.test("gc dry-run reports abandoned staging and caches without mutation", async () => {
  await withManager(async ({ manager, home }) => {
    const staging = join(home, "data", "installs", ".staging", crypto.randomUUID());
    await Deno.mkdir(staging, { recursive: true });
    await Deno.mkdir(join(home, "cache", "builds"), { recursive: true });
    await Deno.mkdir(join(home, "cache", "logs"), { recursive: true });
    await Deno.mkdir(join(home, "cache", "sources"), { recursive: true });
    const result = await manager.gc({
      dryRun: true,
      sources: true,
      buildCache: true,
    });
    assertEquals(result.removed, [
      staging,
      join(home, "cache", "sources"),
      join(home, "cache", "builds"),
      join(home, "cache", "logs"),
    ]);
    assert((await Deno.lstat(staging)).isDirectory);
    assert((await Deno.lstat(join(home, "cache", "sources"))).isDirectory);
  });
});

Deno.test("gc removes only UUID staging absent from every retained lock owner", async () => {
  const retainedId = "11111111-1111-4111-8111-111111111111";
  const abandonedId = "22222222-2222-4222-8222-222222222222";
  await withManager(
    async ({ manager }) => {
      const deadOwner = new GlobalOperationLockManager({
        stateRoot: manager.paths.stateDir,
        pid: 424242,
      });
      await deadOwner.acquireCatalog({
        operation: "dead recorded staging owner",
        operationId: retainedId,
      });
      const stagingRoots = [
        buildStagingRoot(manager.paths.buildsDir),
        join(manager.paths.installsDir, ".staging"),
        join(manager.paths.profilesDir, ".staging"),
      ];
      for (const root of stagingRoots) {
        for (const operationId of [retainedId, abandonedId]) {
          const path = join(root, operationId);
          await Deno.mkdir(path, { recursive: true });
          await Deno.writeTextFile(join(path, "owned.txt"), operationId);
        }
        await Deno.mkdir(join(root, "foreign-entry"), { recursive: true });
      }

      const first = await manager.gc();
      for (const root of stagingRoots) {
        assert((await Deno.lstat(join(root, retainedId))).isDirectory);
        await assertRejects(() => Deno.lstat(join(root, abandonedId)), Deno.errors.NotFound);
        assert((await Deno.lstat(join(root, "foreign-entry"))).isDirectory);
      }
      assertEquals(first.removed, stagingRoots.map((root) => join(root, abandonedId)).sort());
      assert(first.retained.some((reason) => reason.includes("retained lock owner")));
      assert(first.retained.some((reason) => reason.includes("not a canonical UUID")));

      const repaired = await manager.repair({ unlock: "catalog" });
      assertEquals(repaired.unlocked, "catalog");
      const second = await manager.gc();
      for (const root of stagingRoots) {
        await assertRejects(() => Deno.lstat(join(root, retainedId)), Deno.errors.NotFound);
        assert((await Deno.lstat(join(root, "foreign-entry"))).isDirectory);
      }
      assertEquals(second.removed, stagingRoots.map((root) => join(root, retainedId)).sort());
    },
    undefined,
    (paths) => {
      return {
        locks: new GlobalOperationLockManager({
          stateRoot: paths.stateDir,
          isPidAlive: (pid) => pid === Deno.pid,
        }),
      };
    },
  );
});

Deno.test("repair reconciles one exact pin and purge reports but never removes it", async () => {
  await withManager(async ({ manager, project, home }) => {
    const used = await manager.use("0.16");
    const persistentZig = join(manager.paths.globalBinDir, "zig");
    const persistentZls = join(manager.paths.globalBinDir, "zls");
    await Deno.remove(join(home, "state", "scopes.json"));
    const repaired = await manager.repair({ path: project });
    assertEquals(repaired.scopeValid, true);
    assertEquals(repaired.registry.state, "healthy");
    assertEquals(repaired.registry.reconciled?.profileId, used.profileId);

    const dryRun = await manager.purge({ dryRun: true });
    assertEquals(dryRun.danglingPins.map((pin) => pin.pinPath), [used.pinPath]);
    assert((await Deno.lstat(used.pinPath)).isFile);
    assert((await Deno.lstat(join(home, "data"))).isDirectory);
    assertEquals(dryRun.persistentResolvers, { zig: true, zls: true });
    assert((await Deno.lstat(persistentZig)).isFile);
    assert((await Deno.lstat(persistentZls)).isFile);

    const purged = await manager.purge({ confirm: true });
    assertEquals(purged.danglingPins.map((pin) => pin.pinPath), [used.pinPath]);
    assertEquals(purged.persistentResolvers, { zig: true, zls: true });
    assert((await Deno.lstat(used.pinPath)).isFile);
    await assertRejects(() => Deno.lstat(persistentZig), Deno.errors.NotFound);
    await assertRejects(() => Deno.lstat(persistentZls), Deno.errors.NotFound);
    for (const root of ["config", "state", "data", "cache"]) {
      await assertRejects(() => Deno.lstat(join(home, root)), Deno.errors.NotFound);
    }
  });
});

Deno.test("repair uses one operation UUID and global-before-scope lock order", async () => {
  let locks!: RecordingOperationLocks;
  await withManager(
    async ({ manager }) => {
      const repaired = await manager.repair();
      assertEquals(repaired.catalogRebuilt, true);
      assertEquals([...new Set(locks.events.map((event) => event.operationId))].length, 1);
      assertEquals(locks.events.map((event) => `${event.action}:${event.kind}`), [
        "acquire:global",
        "acquire:scope",
        "acquire:catalog",
        "release:catalog",
        "release:scope",
        "release:global",
      ]);
    },
    undefined,
    (paths) => {
      locks = new RecordingOperationLocks(paths.stateDir);
      return { locks };
    },
  );
});

Deno.test("latest integration uses literal symbolic remote HEAD", async () => {
  await withManager(async ({ manager, sourceRef, runner }) => {
    runner.zigVersion = "0.16.1";
    sourceRef.head = { branch: "master", commit: COMMIT_B };
    const used = await manager.use("latest");
    assertEquals(used.commit, COMMIT_B);
    assertEquals(used.selector, "latest");
    assertEquals(used.zls?.selector, "latest");
    assertEquals(sourceRef.calls.filter((call) => call === "resolveRemoteHead").length, 1);
    assertEquals(sourceRef.calls.filter((call) => call === "listRemoteRefs").length, 0);
    assertEquals(sourceRef.zlsCalls.filter((call) => call === "resolveRemoteHead").length, 1);
    assertEquals(sourceRef.zlsCalls.filter((call) => call === "listRemoteRefs").length, 0);
  });
});

Deno.test("sync validates the exact current profile without remote resolution", async () => {
  const events: string[] = [];
  await withManager(async ({ manager, sourceRef }) => {
    const used = await manager.use("0.16");
    events.length = 0;
    sourceRef.calls.length = 0;
    sourceRef.zlsCalls.length = 0;
    const synced = await manager.sync();
    assertEquals(synced.profileId, used.profileId);
    assertEquals(synced.rebuilt, false);
    assertEquals(sourceRef.calls, []);
    assertEquals(sourceRef.zlsCalls, []);
    assertEquals(synced.zls?.installationId, used.zls?.installationId);
    assertEquals(events, ["catalog"]);
  }, events);
});

Deno.test("data installs survive source, build, and log cache deletion across local facade operations", async () => {
  await withManager(async ({ manager, sourceRef, runner, project, other }) => {
    const used = await manager.use("0.16", { path: project });
    const configureCount = () =>
      runner.requests.filter((request) => request.args[0] === "-S").length;
    const initialConfigureCount = configureCount();
    await cleanup(manager.paths.sourcesDir);
    await cleanup(manager.paths.buildsDir);
    await cleanup(manager.paths.logsDir);
    sourceRef.calls.length = 0;

    assertEquals((await manager.current({ path: project })).installationId, used.installationId);
    assertEquals((await manager.run(["version"], { cwd: project })).code, 0);
    assertEquals((await manager.sync({ path: project })).rebuilt, false);
    assertEquals(sourceRef.calls, []);

    await delay(2);
    const alias = await manager.use("0.16.0", { path: other });
    assertEquals(alias.installationId, used.installationId);
    assertEquals(alias.reused, true);
    assertEquals(configureCount(), initialConfigureCount);
    assertEquals((await manager.run(["version"], { cwd: other })).code, 0);
  });
});

Deno.test("sync rebuilds a missing exact install without changing its pin", async () => {
  await withManager(async ({ manager, project }) => {
    const used = await manager.use("0.16");
    const pin = await Deno.readFile(used.pinPath);
    await Deno.remove(join(manager.paths.installsDir, "zig", used.installationId), {
      recursive: true,
    });
    const synced = await manager.sync();
    assertEquals(synced.installationId, used.installationId);
    assertEquals(synced.rebuilt, true);
    assertEquals(await Deno.readFile(join(project, ".zig-manager", "toolchain")), pin);
    assert((await Deno.stat(synced.executable)).isFile);
  });
});

Deno.test("sync reconstructs the exact paired ZLS without changing the profile pointer", async () => {
  await withManager(async ({ manager, sourceRef }) => {
    const used = await manager.use("0.16");
    const pin = await Deno.readFile(used.pinPath);
    await Deno.remove(
      join(manager.paths.installsDir, "zls", used.zls!.installationId),
      { recursive: true },
    );
    sourceRef.calls.length = 0;
    sourceRef.zlsCalls.length = 0;

    const synced = await manager.sync();
    assertEquals(synced.profileId, used.profileId);
    assertEquals(synced.rebuilt, true);
    assertEquals(synced.zig?.reused, true);
    assertEquals(synced.zls?.reused, false);
    assertEquals(synced.zls?.installationId, used.zls?.installationId);
    assertEquals(await Deno.readFile(used.pinPath), pin);
    assertEquals(sourceRef.calls, []);
    assertEquals(
      sourceRef.zlsCalls.filter((call) =>
        call === "resolveRemoteHead" || call === "listRemoteRefs"
      ),
      [],
    );
  });
});

Deno.test("corrupt replaceable build cache is removed and rebuilt under exact sync", async () => {
  await withManager(async ({ manager, runner }) => {
    const used = await manager.use("0.16");
    const configureCount = runner.requests.filter((request) => request.args[0] === "-S").length;
    await Deno.remove(join(manager.paths.installsDir, "zig", used.installationId), {
      recursive: true,
    });
    const cacheObject = join(manager.paths.buildsDir, "zig", used.installationId);
    await Deno.writeTextFile(join(cacheObject, "build-manifest.json"), "{corrupt\n");
    const synced = await manager.sync();
    assertEquals(synced.rebuilt, true);
    assertEquals(
      runner.requests.filter((request) => request.args[0] === "-S").length,
      configureCount + 1,
    );
    assert((await Deno.stat(join(cacheObject, "build-manifest.json"))).isFile);
  });
});

Deno.test("explicit sync quarantines and preserves a corrupt exact object before rebuilding", async () => {
  await withManager(async ({ manager }) => {
    const used = await manager.use("0.16");
    const pin = await Deno.readFile(used.pinPath);
    await Deno.writeTextFile(used.executable, "corrupt final object\n");
    const synced = await manager.sync();
    assertEquals(synced.rebuilt, true);
    assertEquals(synced.installationId, used.installationId);
    assertEquals(await Deno.readFile(used.pinPath), pin);

    const quarantineRoot = join(manager.paths.installsDir, ".corrupt", "zig");
    const entries = [];
    for await (const entry of Deno.readDir(quarantineRoot)) entries.push(entry.name);
    assertEquals(entries.length, 1);
    assert(entries[0].startsWith(`${used.installationId}-`));
    assertEquals(
      await Deno.readTextFile(join(quarantineRoot, entries[0], "install", "bin", "zig")),
      "corrupt final object\n",
    );
  });
});

Deno.test("ordinary exact reuse reports corruption and never quarantines or overwrites it", async () => {
  await withManager(async ({ manager }) => {
    const used = await manager.use("0.16");
    await Deno.writeTextFile(used.executable, "ordinary corruption\n");
    await assertRejects(
      () => manager.install("0.16.0"),
      ZigInstallCorruptError,
      used.installationId,
    );
    assertEquals(await Deno.readTextFile(used.executable), "ordinary corruption\n");
    const quarantineRoot = join(manager.paths.installsDir, ".corrupt", "zig");
    const entries = [];
    for await (const entry of Deno.readDir(quarantineRoot)) entries.push(entry.name);
    assertEquals(entries, []);
  });
});

Deno.test("sync rejects a changed canonical recipe before configure and leaves the pin unchanged", async () => {
  await withManager(async ({ manager, runner, root }) => {
    const used = await manager.use("0.16");
    const pin = await Deno.readFile(used.pinPath);
    await Deno.remove(join(manager.paths.installsDir, "zig", used.installationId), {
      recursive: true,
    });
    const configureCount = runner.requests.filter((request) => request.args[0] === "-S").length;
    await Deno.writeTextFile(join(root, "tools", "cmake"), "#!/bin/sh\n# changed\nexit 0\n");
    await assertRejects(
      () => manager.sync(),
      ZigInstallCorruptError,
      "canonical recipe",
    );
    assertEquals(
      runner.requests.filter((request) => request.args[0] === "-S").length,
      configureCount,
    );
    assertEquals(await Deno.readFile(used.pinPath), pin);
  });
});

Deno.test("configure and build start only while the exact installation lock is held", async () => {
  let observed = false;
  await withManager(
    async ({ manager }) => {
      await manager.install("0.16");
      assert(observed);
    },
    undefined,
    {
      build: async (context) => {
        const managerHome = dirname(dirname(context.buildRoot!));
        const lock = join(
          managerHome,
          "state",
          "locks",
          "installs",
          `${context.installationId}.lock`,
          "owner.json",
        );
        observed = (await Deno.lstat(lock)).isFile;
        return await buildManagedZig(context);
      },
    },
  );
});

Deno.test("same-scope concurrent use waits and publishes the queued complete pin", async () => {
  const buildStarted = deferred();
  const buildGate = deferred();
  let firstBuild = true;
  await withManager(
    async ({ manager, sourceRef, project }) => {
      const first = manager.use("0.16", { path: project });
      await buildStarted.promise;
      const sourceCalls = sourceRef.calls.length;
      let secondSettled = false;
      const second = manager.use("0.16.0", { path: project }).finally(() => {
        secondSettled = true;
      });
      await delay(20);
      assertEquals(secondSettled, false);
      assertEquals(sourceRef.calls.length, sourceCalls);
      buildGate.resolve(undefined);
      const [firstResult, secondResult] = await Promise.all([first, second]);
      assertEquals(firstResult.installationId, secondResult.installationId);
      assertEquals(
        await Deno.readTextFile(join(project, ".zig-manager", "toolchain")),
        serializeScopePin(secondResult.profileId),
      );
    },
    undefined,
    {
      build: async (context) => {
        if (firstBuild) {
          firstBuild = false;
          buildStarted.resolve(undefined);
          await buildGate.promise;
        }
        return await buildManagedZig(context);
      },
    },
  );
});

Deno.test("different-scope source operations queue without moving checkout during a build", async () => {
  const buildStarted = deferred();
  const buildGate = deferred();
  let firstBuild = true;
  await withManager(
    async ({ manager, sourceRef, project, other }) => {
      const first = manager.use("0.16", { path: project });
      await buildStarted.promise;
      const sourceCalls = sourceRef.calls.length;
      let secondSettled = false;
      const second = manager.use("0.16.0", { path: other }).finally(() => {
        secondSettled = true;
      });
      await delay(20);
      assertEquals(secondSettled, false);
      assertEquals(sourceRef.calls.length, sourceCalls);
      buildGate.resolve(undefined);
      const [projectResult, otherResult] = await Promise.all([first, second]);
      assertEquals((await manager.current({ path: project })).profileId, projectResult.profileId);
      assertEquals((await manager.current({ path: other })).profileId, otherResult.profileId);
    },
    undefined,
    {
      build: async (context) => {
        if (firstBuild) {
          firstBuild = false;
          buildStarted.resolve(undefined);
          await buildGate.promise;
        }
        return await buildManagedZig(context);
      },
    },
  );
});

Deno.test("scope transaction uses one UUID and strict acquisition/release order", async () => {
  let locks!: RecordingOperationLocks;
  let buildOperationId = "";
  await withManager(
    async ({ manager, home }) => {
      const used = await manager.use("0.16");
      const ids = locks.events.map((event) => event.operationId);
      assertEquals([...new Set(ids)], [buildOperationId]);
      assertEquals(locks.events.map((event) => `${event.action}:${event.kind}`), [
        "acquire:scope",
        "acquire:source",
        "acquire:install",
        "release:install",
        "release:source",
        "acquire:source",
        "acquire:install",
        "release:install",
        "release:source",
        "acquire:catalog",
        "release:catalog",
        "release:scope",
      ]);
      const logRoot = join(home, "cache", "logs", buildOperationId, "zig", used.installationId);
      assert((await Deno.lstat(logRoot)).isDirectory);
      await assertRejects(
        () => Deno.lstat(join(manager.paths.installsDir, ".staging", buildOperationId)),
        Deno.errors.NotFound,
      );
      await assertRejects(
        () => Deno.lstat(join(manager.paths.profilesDir, ".staging", buildOperationId)),
        Deno.errors.NotFound,
      );
      await assertRejects(
        () => Deno.lstat(join(buildStagingRoot(manager.paths.buildsDir), buildOperationId)),
        Deno.errors.NotFound,
      );
    },
    undefined,
    (paths) => {
      locks = new RecordingOperationLocks(paths.stateDir);
      return {
        locks,
        build: async (context) => {
          buildOperationId = context.operationId!;
          return await buildManagedZig(context);
        },
      };
    },
  );
});

Deno.test("abort after catalog completion preserves exact prior pin bytes", async () => {
  const controller = new AbortController();
  let abortCatalog = false;
  await withManager(
    async ({ manager }) => {
      const first = await manager.use("0.16");
      const prior = await Deno.readFile(first.pinPath);
      abortCatalog = true;
      const error = await assertRejects(
        () => manager.use("0.16.0", { signal: controller.signal }),
        ZigOperationAbortedError,
      );
      assertEquals(controller.signal.reason, "catalog complete");
      assertEquals(await Deno.readFile(first.pinPath), prior);
      assertEquals((await manager.list()).installations.length, 2);
      assertEquals((await manager.list()).profiles.length, 2);
      assertEquals(error.code, "ZIG_OPERATION_ABORTED");
    },
    undefined,
    (paths) => {
      const installs = new InstallStore({ dataRoot: paths.dataDir });
      const profiles = new ToolchainProfileStore({ dataRoot: paths.dataDir, installs });
      const catalog = new GlobalCatalog({
        dataRoot: paths.dataDir,
        stateRoot: paths.stateDir,
        installs,
        profiles,
      });
      return {
        installs,
        profiles,
        catalog: {
          read: () => catalog.read(),
          rebuild: async (options) => {
            const result = await catalog.rebuild(options);
            if (abortCatalog) controller.abort("catalog complete");
            return result;
          },
        },
      };
    },
  );
});

Deno.test("failed build logs are durable, flushed, and outside owned staging cleanup", async () => {
  const progress: string[] = [];
  const foreignId = "33333333-3333-4333-8333-333333333333";
  await withManager(
    async ({ manager, runner }) => {
      const foreign = join(buildStagingRoot(manager.paths.buildsDir), foreignId);
      await Deno.mkdir(foreign, { recursive: true });
      await Deno.writeTextFile(join(foreign, "foreign.txt"), "retain me\n");
      runner.wrongZigVersion = true;
      const error = await assertRejects(() => manager.use("0.16"), Error);
      const logRoot = errorDetailString(error, "logRoot");
      assertStringIncludes(logRoot, join(manager.paths.logsDir, ""));
      assertEquals(await Deno.readTextFile(join(logRoot, "configure.stdout.log")), "configured\n");
      assertEquals(await Deno.readTextFile(join(logRoot, "build.stdout.log")), "built\n");
      assertEquals(await Deno.readTextFile(join(logRoot, "configure.stderr.log")), "");
      assertEquals(await Deno.readTextFile(join(logRoot, "build.stderr.log")), "");
      const command = JSON.parse(await Deno.readTextFile(join(logRoot, "build.command.json")));
      assertEquals(command.args[0], "--build");
      assertStringIncludes(progress.join(""), logRoot);
      assertEquals(await Deno.readTextFile(join(foreign, "foreign.txt")), "retain me\n");
      const gc = await manager.gc({ buildCache: true });
      assert(gc.removed.includes(manager.paths.logsDir));
      await assertRejects(() => Deno.lstat(logRoot), Deno.errors.NotFound);
    },
    undefined,
    {},
    (message) => progress.push(message),
  );
});

Deno.test("aborted build logs survive and flush before transaction locks unwind", async () => {
  const started = deferred();
  const gate = deferred();
  const controller = new AbortController();
  await withManager(async ({ manager, runner, project }) => {
    runner.buildStarted = () => started.resolve(undefined);
    runner.buildGate = gate.promise;
    const pending = manager.use("0.16", { signal: controller.signal });
    await started.promise;
    controller.abort("SIGTERM");
    gate.resolve(undefined);
    const error = await assertRejects(() => pending, ZigOperationAbortedError);
    const logRoot = errorDetailString(error, "logRoot");
    assertEquals(await Deno.readTextFile(join(logRoot, "configure.stdout.log")), "configured\n");
    for (
      const name of [
        "configure.command.json",
        "configure.stderr.log",
        "build.command.json",
        "build.stdout.log",
        "build.stderr.log",
      ]
    ) assert((await Deno.lstat(join(logRoot, name))).isFile);
    await assertRejects(
      () => Deno.lstat(join(project, ".zig-manager", "toolchain")),
      Deno.errors.NotFound,
    );
  });
});

Deno.test("update advances a moving selector and writes the winning scope only after success", async () => {
  await withManager(async ({ manager, sourceRef, runner, project }) => {
    runner.zigVersion = "0.16.0";
    sourceRef.head = { branch: "master", commit: COMMIT_A };
    sourceRef.refs = sourceRef.refs.map((ref) =>
      ref.kind === "branch" && ref.name === "master" ? { ...ref, commit: COMMIT_A } : ref
    );
    const first = await manager.use("latest");

    runner.zigVersion = "0.16.1";
    sourceRef.head = { branch: "master", commit: COMMIT_B };
    sourceRef.refs = sourceRef.refs.map((ref) =>
      ref.kind === "branch" && ref.name === "master" ? { ...ref, commit: COMMIT_B } : ref
    );
    const updated = await manager.update();
    assertEquals(updated.previousProfileId, first.profileId);
    assertEquals(updated.changed, true);
    assertEquals(updated.commit, COMMIT_B);
    assert(updated.zls !== null);
    const zlsManifest = JSON.parse(
      await Deno.readTextFile(
        join(
          manager.paths.installsDir,
          "zls",
          updated.zls!.installationId,
          "install-manifest.json",
        ),
      ),
    );
    assertEquals(zlsManifest.dependencies[0].installationId, updated.installationId);
    assertEquals((await manager.current()).profileId, updated.profileId);
    assertEquals(
      await Deno.readTextFile(join(project, ".zig-manager", "toolchain")),
      serializeScopePin(updated.profileId),
    );
  });
});

Deno.test("update migrates a moving legacy raw-Zig profile to a schema-v2 pair", async () => {
  await withManager(async ({ manager, runner }) => {
    runner.zigVersion = "0.16.1";
    runner.failZlsBuild = true;
    await assertRejects(() => manager.install("latest"), Error, "building ZLS");
    const zig = (await manager.list()).installations.find((item) => item.component === "zig")!;

    const legacy = await manager.useInstalled(zig.installationId);
    const profiles = new ToolchainProfileStore({
      dataRoot: manager.paths.dataDir,
      installs: new InstallStore({ dataRoot: manager.paths.dataDir }),
    });
    assertEquals((await profiles.read(legacy.profileId)).schemaVersion, 1);
    assertEquals(legacy.zls, null);

    runner.failZlsBuild = false;
    const updated = await manager.update();
    const migrated = await profiles.read(updated.profileId);
    assert(isPairedToolchainProfile(migrated));
    assertEquals(migrated.schemaVersion, 2);
    assertEquals(updated.previousProfileId, legacy.profileId);
    assertEquals(updated.changed, true);
    assert(updated.zls !== null);
  });
});

Deno.test("profile GC retains the global profile while pruning an unreferenced local profile", async () => {
  await withManager(async ({ manager, project, runner }) => {
    const global = await manager.use("0.16", { global: true });
    runner.zigVersion = "0.16.1";
    const local = await manager.use("latest", { path: project });
    await manager.unuse({ path: project });

    const collected = await manager.gc({ profiles: true });
    assert(
      collected.retained.some((reason) =>
        reason.includes(global.profileId) && reason.includes("global profile pointer")
      ),
    );
    assert(collected.removed.some((path) => path.endsWith(local.profileId)));
    assert((await Deno.lstat(join(manager.paths.profilesDir, global.profileId))).isDirectory);
    await assertRejects(
      () => Deno.lstat(join(manager.paths.profilesDir, local.profileId)),
      Deno.errors.NotFound,
    );
    assertEquals((await manager.current()).profileId, global.profileId);
  });
});

Deno.test("a broken explicit profile pin errors rather than falling back", async () => {
  await withManager(async ({ manager, project, fallbackZig, sourceRef }) => {
    const missing = "f".repeat(64);
    await new ScopePinStore().write(project, missing);
    const error = await assertRejects(
      () => manager.current(),
      ZigProfileNotFoundError,
      missing,
    );
    assertEquals(error.details.profileId, missing);
    assertStringIncludes(error.message, missing);
    sourceRef.calls.length = 0;
    await assertRejects(() => manager.sync(), ZigProfileNotFoundError, missing);
    assertEquals(sourceRef.calls, []);
    assert(fallbackZig.length > 0);
  });
});

Deno.test("blocking preflight errors stop before configure and preserve the prior pin bytes", async () => {
  await withManager(async ({ manager, project, runner }) => {
    await manager.use("0.16.0");
    const pinPath = join(project, ".zig-manager", "toolchain");
    const previous = await Deno.readFile(pinPath);
    const requestOffset = runner.requests.length;
    runner.toolVersions.llvm = "20.0.0";

    const error = await assertRejects(
      () => manager.use("latest"),
      BuildPrerequisiteError,
    );
    const findings = error.details.findings as { readonly severity: string }[];
    assert(findings.length > 0);
    assert(findings.every((finding) => finding.severity === "error"));
    assertEquals(
      runner.requests.slice(requestOffset).some((request) =>
        request.args[0] === "-S" || request.args[0] === "--build"
      ),
      false,
    );
    assertEquals(await Deno.readFile(pinPath), previous);
  });
});

interface Fixture {
  readonly root: string;
  readonly home: string;
  readonly project: string;
  readonly nested: string;
  readonly other: string;
  readonly fallbackZig: string;
  readonly fallbackZls: string;
  readonly sourceRef: FakeSourceRef;
  readonly runner: FakeProcessRunner;
  readonly manager: ZigManager;
}

type ServiceOverrides =
  | ZigManagerServices
  | ((
    paths: PlatformPaths,
    defaults: ZigManagerServices,
  ) => ZigManagerServices);

async function withManager(
  action: (fixture: Fixture) => Promise<void>,
  events?: string[],
  serviceOverrides: ServiceOverrides = {},
  progress?: (message: string) => void,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-facade-" });
  try {
    const home = join(root, "manager-home");
    const project = join(root, "project");
    const nested = join(project, "nested", "deep");
    const other = join(root, "other");
    await Deno.mkdir(nested, { recursive: true });
    await Deno.mkdir(other);
    const prefix = await createDevelopmentFiles(root);
    const fallbackZig = join(root, "fallback-bin", "zig");
    const fallbackZls = join(root, "fallback-bin", "zls");
    await Deno.mkdir(dirname(fallbackZig), { recursive: true });
    await Deno.writeTextFile(fallbackZig, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await Deno.writeTextFile(fallbackZls, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await Deno.chmod(fallbackZig, 0o755);
    await Deno.chmod(fallbackZls, 0o755);
    const env = managerEnvironment(root, home, prefix, dirname(fallbackZig));
    const paths = new PlatformPaths({ env, home: root, platform: "linux" });
    const sourceRef = new FakeSourceRef(root, paths.sourcesDir);
    const runner = new FakeProcessRunner(prefix);
    const defaults = recordingServices(paths, events);
    const overrides = typeof serviceOverrides === "function"
      ? serviceOverrides(paths, defaults)
      : serviceOverrides;
    const services = { ...defaults, ...overrides };
    const manager = new ZigManager({
      env,
      home: root,
      cwd: project,
      platform: "linux",
      architecture: "x86_64",
      hostTarget: HOST_TARGET,
      sourceRef,
      runner,
      progress,
      services,
    });
    await action({
      root,
      home,
      project,
      nested,
      other,
      fallbackZig,
      fallbackZls,
      sourceRef,
      runner,
      manager,
    });
  } finally {
    await cleanup(root);
  }
}

function recordingServices(paths: PlatformPaths, events?: string[]): ZigManagerServices {
  if (events === undefined) return { hostSupport: () => {} };
  const installs = new InstallStore({ dataRoot: paths.dataDir });
  const profiles = new ToolchainProfileStore({ dataRoot: paths.dataDir, installs });
  const catalog = new GlobalCatalog({
    dataRoot: paths.dataDir,
    stateRoot: paths.stateDir,
    installs,
    profiles,
  });
  const pins = new ScopePinStore();
  return {
    hostSupport: () => {},
    installs,
    profiles: {
      create: async (input) => {
        const result = await profiles.create(input);
        events.push("profile");
        return result;
      },
      get: (id) => profiles.get(id),
      tryGet: (id) => profiles.tryGet(id),
      read: (id) => profiles.read(id),
      list: () => profiles.list(),
      stagingRoot: profiles.stagingRoot,
      listMetadata: () => profiles.listMetadata(),
      remove: (id) => profiles.remove(id),
    },
    catalog: {
      read: () => catalog.read(),
      rebuild: async () => {
        const result = await catalog.rebuild();
        events.push("catalog");
        return result;
      },
    },
    pins: {
      write: async (scope, profileId) => {
        const result = await pins.write(scope, profileId);
        events.push("pin");
        return result;
      },
      remove: (scope) => pins.remove(scope),
    },
  };
}

function addStableZls(
  sourceRef: FakeSourceRef,
  tag: string,
  commit: string,
  minimumBuildVersion = "0.16.0",
): void {
  sourceRef.zlsRefs.push({ kind: "tag", name: tag, commit });
  sourceRef.zlsVersions.set(commit, {
    declaredVersion: tag,
    minimumBuildVersion,
    maximumBuildVersionExclusive: null,
    tag,
    distance: 0,
  });
}

function managerEnvironment(
  root: string,
  home: string,
  prefix: string,
  fallbackPath: string,
): Readonly<Record<string, string>> {
  const tool = (name: string) => join(root, "tools", name);
  const denoInstallRoot = join(root, "deno-install");
  return {
    HOME: root,
    PATH: `${join(denoInstallRoot, "bin")}:${fallbackPath}`,
    DENO_INSTALL_ROOT: denoInstallRoot,
    ZIG_MANAGER_HOME: home,
    ZIG_MANAGER_CMAKE: tool("cmake"),
    ZIG_MANAGER_CC: tool("cc"),
    ZIG_MANAGER_CXX: tool("c++"),
    ZIG_MANAGER_LLVM_CONFIG: tool("llvm-config"),
    ZIG_MANAGER_CLANG: tool("clang"),
    ZIG_MANAGER_LLD: tool("ld.lld"),
    ZIG_MANAGER_GENERATOR_TOOL: tool("ninja"),
    ZIG_MANAGER_CMAKE_PREFIX_PATH: prefix,
    CFLAGS: "ambient poison",
    CXXFLAGS: "ambient poison",
    LDFLAGS: "ambient poison",
    CPATH: "ambient poison",
    CMAKE_PREFIX_PATH: "ambient poison",
    PKG_CONFIG_PATH: "ambient poison",
  };
}

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => resolvePromise = resolve);
  return { promise, resolve: resolvePromise };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function errorDetailString(error: Error, key: string): string {
  const details = (error as { readonly details?: Readonly<Record<string, unknown>> }).details;
  const value = details?.[key];
  if (typeof value !== "string") throw new Error(`error detail '${key}' is missing`);
  return value;
}

class RecordingOperationLocks extends GlobalOperationLockManager {
  readonly events: Array<{
    readonly action: "acquire" | "release";
    readonly kind: GlobalOperationLockTarget["kind"];
    readonly operationId: string;
  }> = [];

  constructor(stateRoot: string) {
    super({ stateRoot });
  }

  override async acquire(
    target: GlobalOperationLockTarget,
    options: GlobalOperationLockAcquireOptions,
  ) {
    const lease = await super.acquire(target, options);
    this.events.push({
      action: "acquire",
      kind: target.kind,
      operationId: lease.owner.operationId,
    });
    const release = lease.release.bind(lease);
    Object.defineProperty(lease, "release", {
      value: async () => {
        if (!lease.released) {
          this.events.push({
            action: "release",
            kind: target.kind,
            operationId: lease.owner.operationId,
          });
        }
        await release();
      },
    });
    return lease;
  }
}
