import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { dirname, join } from "@std/path";
import { canonicalJson, fileMetadata, pathExists } from "../src/filesystem.ts";
import { ZigDependencyInUseError } from "../src/errors.ts";
import { GlobalCatalog } from "../src/global_catalog.ts";
import {
  computeInstallationId,
  type InstallComponent,
  type InstallDependency,
  type InstallIdentityV1,
  type InstallManifestV3,
  type InstallStaging,
  InstallStore,
  type ResolvedSource,
  validateInstallIdentity,
  validateInstallManifest,
} from "../src/install_store.ts";
import {
  computeProfileId,
  createToolchainProfileIdentity,
  getToolchainProfileZlsSource,
  isPairedToolchainProfile,
  ToolchainProfileStore,
  validateToolchainProfile,
} from "../src/profile_store.ts";
import { ZigManager } from "../src/zig_manager.ts";
import { createZlsBuildRecipe } from "../src/zls_build.ts";
import {
  type ResolvedZlsSource,
  validateResolvedZlsSource,
  ZLS_SOURCE_REPOSITORY_IDENTITY,
  ZLS_SOURCE_REPOSITORY_URL,
} from "../src/zls_source_workspace.ts";
import { elf64X86_64Fixture, zigVersionMetadata } from "./test_helpers.ts";

const ZIG_COMMIT = "a".repeat(40);
const ZLS_COMMIT = "b".repeat(40);
const OTHER_COMMIT = "c".repeat(40);
const CREATED = "2026-08-10T12:00:00.000Z";
const LATER = "2026-08-11T12:00:00.000Z";
const HOST = {
  os: "linux",
  architecture: "x86_64",
  abi: "gnu",
  denoTarget: "x86_64-unknown-linux-gnu",
} as const;

Deno.test("installation and profile IDs are canonical and exclude timestamps", async () => {
  const first = identityFixture("zig", [], {
    profile: "release",
    options: { optimize: true, jobs: 8 },
  });
  const reordered = identityFixture("zig", [], {
    options: { jobs: 8, optimize: true },
    profile: "release",
  });
  const firstId = await computeInstallationId(first);
  assertEquals(firstId, await computeInstallationId(reordered));
  assertEquals(firstId.length, 64);
  assertNotEquals(
    firstId,
    await computeInstallationId(identityFixture("zig", [], { profile: "debug" })),
  );

  const source = sourceFixture("zig", { resolvedAt: CREATED });
  const profileIdentity = createToolchainProfileIdentity({
    zigInstallationId: firstId,
    source,
  });
  const laterIdentity = createToolchainProfileIdentity({
    zigInstallationId: firstId,
    source: { ...source, resolvedAt: LATER },
  });
  assertEquals(await computeProfileId(profileIdentity), await computeProfileId(laterIdentity));
  assertNotEquals(
    await computeProfileId(profileIdentity),
    await computeProfileId(createToolchainProfileIdentity({
      zigInstallationId: firstId,
      source: { ...source, requestedSelector: "stable" },
    })),
  );

  const zlsSource = zlsSourceFixture({ resolvedAt: CREATED });
  const pairedIdentity = createToolchainProfileIdentity({
    zigInstallationId: firstId,
    zlsInstallationId: "d".repeat(64),
    source,
    zlsSource,
  });
  const laterPairedIdentity = createToolchainProfileIdentity({
    zigInstallationId: firstId,
    zlsInstallationId: "d".repeat(64),
    source: { ...source, resolvedAt: LATER },
    zlsSource: { ...zlsSource, resolvedAt: LATER },
  });
  assertEquals(pairedIdentity.schemaVersion, 2);
  assertEquals(
    await computeProfileId(pairedIdentity),
    await computeProfileId(laterPairedIdentity),
  );
  assertNotEquals(
    await computeProfileId(pairedIdentity),
    await computeProfileId(createToolchainProfileIdentity({
      zigInstallationId: firstId,
      zlsInstallationId: "d".repeat(64),
      source,
      zlsSource: {
        ...zlsSource,
        requestedSelector: `tag:${zlsSource.version}`,
      },
    })),
  );
  assertNotEquals(
    await computeProfileId(pairedIdentity),
    await computeProfileId(createToolchainProfileIdentity({
      zigInstallationId: firstId,
      zlsInstallationId: "e".repeat(64),
      source,
      zlsSource,
    })),
  );
});

Deno.test("install staging promotes atomically, reuses immutable objects, and preserves conflicts", async () => {
  await withTempRoot(async (root) => {
    const store = new InstallStore(join(root, "data"));
    const prepared = await prepareInstall(store, "zig", { content: "first zig\n" });
    assertEquals(dirname(prepared.staging.root), store.stagingRoot);
    assertStringIncludes(prepared.staging.root, join("installs", ".staging"));
    assert(!(await pathExists(store.installationPath("zig", prepared.installationId))));

    const promoted = await store.publish(prepared.staging, prepared.manifest);
    assertEquals(promoted.reused, false);
    assertEquals(
      promoted.root,
      join(root, "data", "installs", "zig", prepared.installationId),
    );
    assert(!(await pathExists(prepared.staging.root)));
    assert((await Deno.stat(promoted.executablePath)).isFile);
    const originalManifestBytes = await Deno.readTextFile(promoted.manifestPath);

    const duplicate = await prepareInstall(store, "zig", {
      content: "different duplicate output\n",
      resolvedAt: LATER,
      createdAt: LATER,
    });
    assertEquals(duplicate.installationId, prepared.installationId);
    await assertRejects(
      () => store.publish(duplicate.staging, duplicate.manifest),
      Error,
      "conflicting stable content",
    );
    assertEquals(await Deno.readTextFile(promoted.manifestPath), originalManifestBytes);
    assert(await pathExists(duplicate.staging.root));
    await store.discardStaging(duplicate.staging);

    const conflict = await prepareInstall(store, "zig", {
      recipe: { profile: "debug" },
      content: "debug zig\n",
    });
    const conflictRoot = store.installationPath("zig", conflict.installationId);
    await Deno.mkdir(conflictRoot);
    const marker = join(conflictRoot, "do-not-overwrite");
    await Deno.writeTextFile(marker, "existing object\n");
    await assertRejects(
      () => store.publish(conflict.staging, conflict.manifest),
      Error,
      "blocks immutable installation promotion",
    );
    assertEquals(await Deno.readTextFile(marker), "existing object\n");
    assert(!(await pathExists(join(conflictRoot, "install-manifest.json"))));
  });
});

Deno.test("install store rejects path escape, controls, and symlink surprises", async () => {
  await withTempRoot(async (root) => {
    const store = new InstallStore(join(root, "data"));
    const escaped = await prepareInstall(store, "zig");
    await assertRejects(
      () =>
        store.publish(escaped.staging, {
          ...escaped.manifest,
          paths: { ...escaped.manifest.paths, executable: "install/../outside" },
        }),
      TypeError,
      "path traversal",
    );
    await store.discardStaging(escaped.staging);

    const controlled = await prepareInstall(store, "zig", { recipe: { variant: "control" } });
    await assertRejects(
      () =>
        store.publish(controlled.staging, {
          ...controlled.manifest,
          paths: { ...controlled.manifest.paths, executable: "install/bin/zi\ng" },
        }),
      TypeError,
      "control characters",
    );
    await store.discardStaging(controlled.staging);

    const linked = await prepareInstall(store, "zig", { recipe: { variant: "symlink" } });
    const external = join(root, "external-zig");
    await Deno.writeTextFile(external, "synthetic zig\n", { mode: 0o755 });
    const stagedExecutable = join(
      linked.staging.root,
      ...linked.manifest.paths.executable.split("/"),
    );
    await Deno.remove(stagedExecutable);
    await Deno.symlink(external, stagedExecutable);
    await assertRejects(
      () => store.publish(linked.staging, linked.manifest),
      Error,
      "symlink",
    );
    assertEquals(await Deno.readTextFile(external), "synthetic zig\n");

    assertThrows(
      () => new InstallStore(join(root, "bad\nroot")),
      TypeError,
      "control characters",
    );
  });
});

Deno.test("malformed install manifests never publish or alter existing objects", async () => {
  await withTempRoot(async (root) => {
    const store = new InstallStore(join(root, "data"));
    const prepared = await prepareInstall(store, "zig");
    assertThrows(
      () => validateInstallManifest({ ...prepared.manifest, unknown: true }),
      TypeError,
      "unknown key",
    );
    assertThrows(
      () =>
        validateInstallIdentity({
          ...prepared.manifest.identity,
          terminal: { color: true },
        }),
      TypeError,
      "unknown key",
    );
    assertThrows(
      () => validateInstallManifest({ ...prepared.manifest, runtime: [] }),
      TypeError,
      "must be an object",
    );
    const runtimeDependency = (name: string, path: string) => ({
      name,
      path,
      size: 1,
      sha256: "a".repeat(64),
    });
    const dynamicManifest = validateInstallManifest({
      ...prepared.manifest,
      executable: {
        ...prepared.manifest.executable,
        format: {
          ...prepared.manifest.executable.format,
          dynamicallyLinked: true,
          interpreter: "/usr/lib/ld-linux-x86-64.so.2",
        },
      },
      runtime: {
        linkage: "dynamic",
        interpreter: runtimeDependency("interpreter", "/usr/lib/ld-linux-x86-64.so.2"),
        dependencies: [
          runtimeDependency("libLLVM.so.22.1", "/usr/lib/libLLVM.so.22.1"),
          runtimeDependency("libc.so.6", "/usr/lib/libc.so.6"),
        ],
      },
    });
    assertEquals(
      dynamicManifest.runtime.linkage === "dynamic"
        ? dynamicManifest.runtime.dependencies.map((dependency) => dependency.name)
        : [],
      ["libLLVM.so.22.1", "libc.so.6"],
    );
    assertThrows(
      () =>
        validateInstallManifest({
          ...prepared.manifest,
          commands: [{ executable: "/tool", args: [], cwd: "/tmp", env: {}, clearEnv: false }],
        }),
      TypeError,
      "clearEnv",
    );
    assertThrows(
      () =>
        validateInstallManifest({
          ...prepared.manifest,
          dependencies: [{ component: "zig", installationId: "f".repeat(64) }],
        }),
      TypeError,
      "empty for Zig",
    );

    await Deno.writeTextFile(prepared.staging.manifestPath, "{not json\n");
    await assertRejects(
      () => store.promote(prepared.staging),
      Error,
      "could not be read as JSON",
    );
    assert(!(await pathExists(store.installationPath("zig", prepared.installationId))));

    const mismatch = await prepareInstall(store, "zig", { recipe: { variant: "mismatch" } });
    await assertRejects(
      () =>
        store.publish(mismatch.staging, {
          ...mismatch.manifest,
          installationId: "f".repeat(64),
        }),
      Error,
      "staging allocation",
    );
    assert(!(await pathExists(store.installationPath("zig", mismatch.installationId))));
  });
});

Deno.test("install inspection classifies corruption and explicit quarantine preserves it", async () => {
  await withTempRoot(async (root) => {
    const store = new InstallStore(join(root, "data"));
    const installed = await publishPrepared(store, "zig");
    assertEquals((await store.inspect("zig", installed.manifest.installationId)).state, "healthy");
    await Deno.writeTextFile(installed.executablePath, "corrupt bytes\n");
    assertEquals((await store.inspect("zig", installed.manifest.installationId)).state, "corrupt");
    const operationId = "11111111-1111-4111-8111-111111111111";
    const quarantined = await store.quarantine(
      "zig",
      installed.manifest.installationId,
      operationId,
      "corrupt",
    );
    assert(!(await pathExists(installed.root)));
    assert(await pathExists(quarantined.quarantinePath));
    assertEquals(
      await Deno.readTextFile(join(quarantined.quarantinePath, "install", "bin", "zig")),
      "corrupt bytes\n",
    );
    assertEquals(await store.list(), []);
    assert(await pathExists(quarantined.quarantinePath));
  });
});

Deno.test("explicit clean replacement can restore or discard its exact backup", async () => {
  await withTempRoot(async (root) => {
    const store = new InstallStore(join(root, "data"));
    const installed = await publishPrepared(store, "zig");
    const first = await store.quarantine(
      "zig",
      installed.manifest.installationId,
      "11111111-1111-4111-8111-111111111111",
      "replace",
    );

    await store.restoreQuarantine(first);
    assertEquals(
      (await store.get("zig", installed.manifest.installationId)).manifest,
      installed.manifest,
    );

    const second = await store.quarantine(
      "zig",
      installed.manifest.installationId,
      "22222222-2222-4222-8222-222222222222",
      "replace",
    );
    await store.discardQuarantine(second);
    assertEquals(await pathExists(installed.root), false);
    assertEquals(await pathExists(second.quarantinePath), false);
  });
});

Deno.test("profile store strictly reads published v1 profiles with optional ZLS", async () => {
  await withTempRoot(async (root) => {
    const dataRoot = join(root, "data");
    const installs = new InstallStore(dataRoot);
    const zig = await publishPrepared(installs, "zig");
    const zls = await publishPrepared(installs, "zls", {
      zigDependency: zig.manifest.installationId,
    });
    const profiles = new ToolchainProfileStore({ dataRoot, installs });
    const identity = createToolchainProfileIdentity({
      schemaVersion: 1,
      zigInstallationId: zig.manifest.installationId,
      zlsInstallationId: zls.manifest.installationId,
      source: zig.manifest.source,
    });
    const profileId = await computeProfileId(identity);
    const profile = {
      schemaVersion: 1,
      profileId,
      components: {
        zig: zig.manifest.installationId,
        zls: zls.manifest.installationId,
      },
      source: zig.manifest.source,
      host: HOST,
      createdAt: CREATED,
    };
    const profileRoot = profiles.profilePath(profileId);
    await Deno.mkdir(profileRoot, { recursive: true });
    await Deno.writeTextFile(join(profileRoot, "profile.json"), `${JSON.stringify(profile)}\n`);
    await Deno.writeTextFile(join(profileRoot, "zig.path"), `${zig.executablePath}\n`);
    await Deno.writeTextFile(join(profileRoot, "zls.path"), `${zls.executablePath}\n`);

    const read = await profiles.read(profileId);
    assertEquals(read, validateToolchainProfile(profile));
    assertEquals(read.schemaVersion, 1);
    assert(!isPairedToolchainProfile(read));
    assertEquals(getToolchainProfileZlsSource(read), null);
    assertEquals((await profiles.get(profileId)).zlsPath, zls.executablePath);
    assertEquals((await profiles.list()).map((entry) => entry.profile.profileId), [profileId]);
    assertThrows(
      () => validateToolchainProfile({ ...profile, zlsSource: zlsSourceFixture() }),
      TypeError,
      "unknown key",
    );
  });
});

Deno.test("paired v2 profiles require and preserve a complete compatible source pair", async () => {
  await withTempRoot(async (root) => {
    const dataRoot = join(root, "data");
    const installs = new InstallStore(dataRoot);
    const zig = await publishPrepared(installs, "zig");
    const zls = await publishPrepared(installs, "zls", {
      zigDependency: zig.manifest.installationId,
    });
    const zlsSource = zlsSourceFixture();
    const profiles = new ToolchainProfileStore({ dataRoot, installs });

    const withoutZls = await profiles.create({
      schemaVersion: 1,
      zigInstallationId: zig.manifest.installationId,
      source: zig.manifest.source,
      host: HOST,
      createdAt: CREATED,
    });
    assertEquals(withoutZls.reused, false);
    assertEquals(withoutZls.zlsPath, null);
    assert(!(await pathExists(join(withoutZls.root, "zls.path"))));
    assertEquals(
      await Deno.readTextFile(join(withoutZls.root, "zig.path")),
      `${zig.executablePath}\n`,
    );

    await assertRejects(
      () =>
        profiles.create({
          zigInstallationId: zig.manifest.installationId,
          zlsInstallationId: zls.manifest.installationId,
          source: zig.manifest.source,
          host: HOST,
        }),
      TypeError,
      "must be supplied together",
    );
    await assertRejects(
      () =>
        profiles.create({
          zigInstallationId: zig.manifest.installationId,
          source: zig.manifest.source,
          zlsSource,
          host: HOST,
        }),
      TypeError,
      "must be supplied together",
    );
    await assertRejects(
      () =>
        profiles.create({
          schemaVersion: 1,
          zigInstallationId: zig.manifest.installationId,
          zlsInstallationId: zls.manifest.installationId,
          source: zig.manifest.source,
          zlsSource,
          host: HOST,
        }),
      TypeError,
      "schema-v1 profile creation cannot include ZLS",
    );
    await assertRejects(
      () =>
        profiles.create({
          schemaVersion: 2,
          zigInstallationId: zig.manifest.installationId,
          source: zig.manifest.source,
          host: HOST,
        }),
      TypeError,
      "requires ZLS installation ID and source",
    );
    await assertRejects(
      () =>
        profiles.create({
          zigInstallationId: zig.manifest.installationId,
          source: zlsSource,
          host: HOST,
        }),
      TypeError,
      "source.component must be 'zig'",
    );
    await assertRejects(
      () =>
        profiles.create({
          zigInstallationId: zig.manifest.installationId,
          zlsInstallationId: zls.manifest.installationId,
          source: zig.manifest.source,
          zlsSource,
          host: { ...HOST, abi: "musl" },
        }),
      Error,
      "Profile host does not match",
    );

    const withZls = await profiles.create({
      zigInstallationId: zig.manifest.installationId,
      zlsInstallationId: zls.manifest.installationId,
      source: zig.manifest.source,
      zlsSource,
      host: HOST,
      createdAt: CREATED,
    });
    assertNotEquals(withZls.profile.profileId, withoutZls.profile.profileId);
    assertEquals(withZls.profile.schemaVersion, 2);
    const pairedProfile = withZls.profile;
    assert(isPairedToolchainProfile(pairedProfile));
    assertEquals(pairedProfile.source, zig.manifest.source);
    assertEquals(pairedProfile.zlsSource, zlsSource);
    assertEquals(getToolchainProfileZlsSource(pairedProfile), zlsSource);
    assertEquals(withZls.zlsPath, zls.executablePath);
    assertEquals(
      await Deno.readTextFile(join(withZls.root, "zls.path")),
      `${zls.executablePath}\n`,
    );
    assertThrows(
      () => {
        const { zlsSource: _zlsSource, ...incomplete } = pairedProfile;
        validateToolchainProfile(incomplete);
      },
      TypeError,
      "zlsSource is required",
    );

    const originalProfileBytes = await Deno.readTextFile(withZls.manifestPath);
    const reused = await profiles.create({
      zigInstallationId: zig.manifest.installationId,
      zlsInstallationId: zls.manifest.installationId,
      source: { ...zig.manifest.source, resolvedAt: LATER },
      zlsSource: { ...zlsSource, resolvedAt: LATER },
      host: HOST,
      createdAt: LATER,
    });
    assertEquals(reused.profile.profileId, withZls.profile.profileId);
    assertEquals(reused.reused, true);
    assertEquals(await Deno.readTextFile(reused.manifestPath), originalProfileBytes);
    assertEquals((await profiles.read(withZls.profile.profileId)).createdAt, CREATED);
    assertEquals((await profiles.get(withZls.profile.profileId)).zlsPath, zls.executablePath);
    assertEquals((await profiles.list()).length, 2);

    const otherZig = await publishPrepared(installs, "zig", {
      commit: OTHER_COMMIT,
      version: "0.17.0",
      recipe: { profile: "other" },
    });
    await assertRejects(
      () =>
        profiles.create({
          zigInstallationId: otherZig.manifest.installationId,
          zlsInstallationId: zls.manifest.installationId,
          source: otherZig.manifest.source,
          zlsSource,
          host: HOST,
        }),
      Error,
      "does not depend on its Zig",
    );

    await Deno.remove(join(dataRoot, "installs"), { recursive: true });
    const reconstructed = await profiles.read(withZls.profile.profileId);
    assert(isPairedToolchainProfile(reconstructed));
    assertEquals(reconstructed.source, zig.manifest.source);
    assertEquals(reconstructed.zlsSource, zlsSource);
    assertEquals((await profiles.listMetadata()).length, 2);
  });
});

Deno.test("profile trusted paths reject tampering and preserve immutable profile bytes", async () => {
  await withTempRoot(async (root) => {
    const dataRoot = join(root, "data");
    const installs = new InstallStore(dataRoot);
    const zig = await publishPrepared(installs, "zig");
    const profiles = new ToolchainProfileStore({ dataRoot, installs });
    const created = await profiles.create({
      zigInstallationId: zig.manifest.installationId,
      source: zig.manifest.source,
      host: HOST,
    });
    const manifestBytes = await Deno.readTextFile(created.manifestPath);
    await Deno.writeTextFile(join(created.root, "zig.path"), `${join(root, "outside-zig")}\n`);
    await assertRejects(
      () => profiles.get(created.profile.profileId),
      Error,
      "does not match the validated Zig installation",
    );
    assertEquals(await Deno.readTextFile(created.manifestPath), manifestBytes);

    await Deno.remove(join(created.root, "zig.path"));
    await Deno.symlink(zig.executablePath, join(created.root, "zig.path"));
    await assertRejects(() => profiles.get(created.profile.profileId), Error, "symlink");
  });
});

Deno.test("catalog rebuild and update index authoritative installs and profiles atomically", async () => {
  await withTempRoot(async (root) => {
    const dataRoot = join(root, "data");
    const stateRoot = join(root, "state");
    const installs = new InstallStore(dataRoot);
    const profiles = new ToolchainProfileStore({ dataRoot, installs });
    const zig = await publishPrepared(installs, "zig");
    await profiles.create({
      zigInstallationId: zig.manifest.installationId,
      source: zig.manifest.source,
      host: HOST,
    });
    const catalog = new GlobalCatalog({
      dataRoot,
      stateRoot,
      installs,
      profiles,
      now: () => new Date(CREATED),
    });
    const rebuilt = await catalog.rebuild();
    assertEquals(rebuilt.installations.length, 1);
    assertEquals(rebuilt.profiles.length, 1);
    assertEquals((await catalog.read())?.installations, rebuilt.installations);

    const zls = await publishPrepared(installs, "zls", {
      zigDependency: zig.manifest.installationId,
    });
    const zlsSource = zlsSourceFixture();
    const paired = await profiles.create({
      zigInstallationId: zig.manifest.installationId,
      zlsInstallationId: zls.manifest.installationId,
      source: zig.manifest.source,
      zlsSource,
      host: HOST,
    });
    const updated = await catalog.update();
    assertEquals(updated.installations.map((entry) => entry.component), ["zig", "zls"]);
    assertEquals(updated.profiles.length, 2);
    const pairedEntry = updated.profiles.find((entry) =>
      entry.profileId === paired.profile.profileId
    );
    assertEquals(pairedEntry?.profileSchemaVersion, 2);
    assertEquals(pairedEntry?.source, zig.manifest.source);
    assertEquals(pairedEntry?.zlsSource, zlsSource);

    await Deno.remove(catalog.catalogPath);
    assertEquals(await catalog.read(), null);
    const rebuiltAgain = await catalog.rebuild();
    assertEquals(rebuiltAgain.installations.length, 2);
    assertEquals(rebuiltAgain.profiles.length, 2);

    const stableCatalogBytes = await Deno.readTextFile(catalog.catalogPath);
    const malformedId = "f".repeat(64);
    const malformedRoot = installs.installationPath("zig", malformedId);
    await Deno.mkdir(malformedRoot);
    await Deno.writeTextFile(join(malformedRoot, "install-manifest.json"), "{}\n");
    await assertRejects(() => catalog.update(), Error, "Invalid install manifest");
    assertEquals(await Deno.readTextFile(catalog.catalogPath), stableCatalogBytes);
  });
});

Deno.test("catalog callbacks are injectable and run only after immutable publication", async () => {
  await withTempRoot(async (root) => {
    const seenInstallIds: string[] = [];
    const seenProfileIds: string[] = [];
    const dataRoot = join(root, "data");
    const installs = new InstallStore({
      dataRoot,
      catalog: {
        updateInstallation(manifest) {
          seenInstallIds.push(manifest.installationId);
          return Promise.resolve();
        },
      },
    });
    const zig = await publishPrepared(installs, "zig");
    assertEquals(seenInstallIds, [zig.manifest.installationId]);
    assert(await pathExists(zig.root));

    const profiles = new ToolchainProfileStore({
      dataRoot,
      installs,
      catalog: {
        updateProfile(profile) {
          seenProfileIds.push(profile.profileId);
          return Promise.resolve();
        },
      },
    });
    const profile = await profiles.create({
      zigInstallationId: zig.manifest.installationId,
      source: zig.manifest.source,
      host: HOST,
    });
    assertEquals(seenProfileIds, [profile.profile.profileId]);
    assert(await pathExists(profile.root));
  });
});

Deno.test("uninstall refuses a Zig dependency until its exact ZLS installation is removed", async () => {
  await withTempRoot(async (root) => {
    const managerHome = join(root, "manager");
    const dataRoot = join(managerHome, "data");
    const stateRoot = join(managerHome, "state");
    const installs = new InstallStore(dataRoot);
    const zig = await publishPrepared(installs, "zig");
    const zls = await publishPrepared(installs, "zls", {
      zigDependency: zig.manifest.installationId,
    });
    const profiles = new ToolchainProfileStore({ dataRoot, installs });
    const catalog = new GlobalCatalog({ dataRoot, stateRoot, installs, profiles });
    const manager = new ZigManager({
      env: { HOME: root, ZIG_MANAGER_HOME: managerHome },
      home: root,
      cwd: root,
      platform: "linux",
      architecture: "x86_64",
      hostTarget: HOST.denoTarget,
      services: { installs, profiles, catalog, hostSupport: () => {} },
    });

    const error = await assertRejects(
      () => manager.uninstall(zig.manifest.installationId),
      ZigDependencyInUseError,
      "required by retained ZLS",
    );
    assertEquals(error.details.dependentInstallationIds, [zls.manifest.installationId]);
    assert(await pathExists(zig.root));

    assertEquals((await manager.uninstall(zls.manifest.installationId)).component, "zls");
    assertEquals((await manager.uninstall(zig.manifest.installationId)).component, "zig");
  });
});

interface PrepareOptions {
  readonly content?: string;
  readonly recipe?: Readonly<Record<string, unknown>>;
  readonly resolvedAt?: string;
  readonly createdAt?: string;
  readonly zigDependency?: string;
  readonly commit?: string;
  readonly version?: string;
  readonly host?: typeof HOST;
}

interface PreparedInstall {
  readonly installationId: string;
  readonly staging: InstallStaging;
  readonly manifest: InstallManifestV3;
}

async function prepareInstall(
  store: InstallStore,
  component: InstallComponent,
  options: PrepareOptions = {},
): Promise<PreparedInstall> {
  const dependencies: readonly InstallDependency[] = component === "zig"
    ? []
    : [{ component: "zig", installationId: options.zigDependency ?? "d".repeat(64) }];
  const identity = identityFixture(
    component,
    dependencies,
    options.recipe ?? { profile: "release", cpu: "baseline" },
    options.commit,
    options.version,
    options.resolvedAt,
    options.host,
  );
  const installationId = await computeInstallationId(identity);
  const staging = await store.createStaging(component, installationId);
  const executableName = component === "zig" ? "zig" : "zls";
  const executableRelative = `install/bin/${executableName}`;
  const executablePath = join(staging.root, ...executableRelative.split("/"));
  await Deno.mkdir(dirname(executablePath), { recursive: true });
  const header = elf64X86_64Fixture();
  const suffix = new TextEncoder().encode(options.content ?? `synthetic ${component}\n`);
  const bytes = new Uint8Array(header.length + suffix.length);
  bytes.set(header);
  bytes.set(suffix, header.length);
  await Deno.writeFile(executablePath, bytes, { mode: 0o755 });
  if (Deno.build.os !== "windows") await Deno.chmod(executablePath, 0o755);
  const libraries = component === "zig" ? ["install/lib/zig"] : [];
  for (const library of libraries) {
    await Deno.mkdir(join(staging.root, ...library.split("/")), { recursive: true });
  }
  const metadata = await fileMetadata(executablePath);
  const source = sourceFixture(component, {
    commit: options.commit,
    version: options.version,
    resolvedAt: options.resolvedAt,
  });
  const manifest = validateInstallManifest({
    schemaVersion: 3,
    installationId,
    component,
    identity,
    source,
    paths: { executable: executableRelative, libraries },
    executable: {
      version: source.version,
      hostTarget: (options.host ?? HOST).denoTarget,
      size: metadata.size,
      sha256: metadata.sha256,
      format: {
        format: "elf",
        class: 64,
        endianness: "little",
        machine: "x86_64",
        type: "executable",
        dynamicallyLinked: false,
        interpreter: null,
      },
    },
    runtime: { linkage: "static" },
    commands: [],
    dependencies,
    createdAt: options.createdAt ?? CREATED,
    verifierContractVersion: identity.adapter.verifierContractVersion,
  });
  return { installationId, staging, manifest };
}

async function publishPrepared(
  store: InstallStore,
  component: InstallComponent,
  options: PrepareOptions = {},
) {
  const prepared = await prepareInstall(store, component, options);
  return await store.publish(prepared.staging, prepared.manifest);
}

function identityFixture(
  component: InstallComponent,
  dependencies: readonly InstallDependency[],
  recipe: Readonly<Record<string, unknown>>,
  commit?: string,
  version?: string,
  resolvedAt?: string,
  host = HOST,
): InstallIdentityV1 {
  if (component === "zls") {
    if (dependencies.length !== 1 || dependencies[0].component !== "zig") {
      throw new TypeError("ZLS fixture requires exactly one Zig dependency");
    }
    return createZlsBuildRecipe({
      source: zlsSourceFixture({ commit, version, resolvedAt }),
      host,
      zigInstallationId: dependencies[0].installationId,
      zigExecutable: {
        installPath: "install/bin/zig",
        size: 1,
        sha256: "e".repeat(64),
      },
      adapter: {
        id: `fixture:${canonicalJson(recipe)}`,
        buildContractVersion: 1,
        verifierContractVersion: 1,
      },
    });
  }
  const source = sourceFixture(component, { commit, version });
  const environment = {
    CFLAGS: "",
    CXXFLAGS: "",
    CPPFLAGS: "",
    LDFLAGS: "",
    CPATH: "",
    C_INCLUDE_PATH: "",
    CPLUS_INCLUDE_PATH: "",
    LIBRARY_PATH: "",
    CMAKE_PREFIX_PATH: "",
    PKG_CONFIG_PATH: "",
    LANG: "C",
    LC_ALL: "C",
    PATH: "/fixture/tools",
    HOME: "$BUILD/home",
    TMPDIR: "$BUILD/tmp",
    XDG_CACHE_HOME: "$BUILD/cache/xdg",
    ZIG_GLOBAL_CACHE_DIR: "$BUILD/cache/zig-global",
    ZIG_LOCAL_CACHE_DIR: "$BUILD/cache/zig-local",
  };
  const tool = (name: string) => ({
    path: `/fixture/tools/${name}`,
    version: "1.0.0",
    size: 1,
    sha256: "a".repeat(64),
    queries: [{ args: ["--version"], stdout: `${name} 1.0.0\n`, stderr: "" }],
  });
  return validateInstallIdentity({
    schemaVersion: 1,
    component,
    source: {
      repository: source.repository,
      commit: source.commit,
      version: source.versionMetadata,
    },
    adapter: {
      id: `fixture:${canonicalJson(recipe)}`,
      buildContractVersion: 1,
      verifierContractVersion: 2,
    },
    host,
    cpuPolicy: "baseline",
    build: {
      strategy: "cmake",
      profile: "release",
      cmakeBuildType: "Release",
      generator: "Ninja",
      jobs: 4,
      cmakePrefixPath: "/fixture/llvm",
      cpu: "baseline",
    },
    cmake: {
      configureArguments: [
        "-S",
        "$SOURCE",
        "-B",
        "$BUILD/cmake-build",
        "-G",
        "Ninja",
        "-DCMAKE_INSTALL_PREFIX=$BUILD/install",
        "-DZIG_EXTRA_BUILD_ARGS=-Dno-langref",
      ],
      buildArguments: ["--build", "$BUILD/cmake-build"],
    },
    environment: { clearEnv: true, inherited: [], variables: environment },
    tools: {
      cmake: tool("cmake"),
      cCompiler: tool("cc"),
      cxxCompiler: tool("cxx"),
      llvmConfig: tool("llvm-config"),
      clang: tool("clang"),
      lld: tool("lld"),
      generatorTool: tool("ninja"),
    },
    development: {
      files: [{ path: "/fixture/llvm/include/header.h", size: 1, sha256: "b".repeat(64) }],
      packages: [{
        name: "fixture-devel",
        version: "1.0.0-1",
        query: { args: ["-Q", "fixture-devel"], stdout: "fixture-devel 1.0.0-1\n", stderr: "" },
      }],
    },
    dependencies,
  });
}

function sourceFixture(
  component: InstallComponent,
  options: { readonly commit?: string; readonly version?: string; readonly resolvedAt?: string } =
    {},
): ResolvedSource {
  if (component === "zls") return zlsSourceFixture(options);
  const commit = options.commit ?? (component === "zig" ? ZIG_COMMIT : ZLS_COMMIT);
  const version = options.version ?? (component === "zig" ? "0.16.0" : "0.14.0");
  return {
    component,
    repository: { identity: "codeberg/zig", url: "https://codeberg.org/ziglang/zig.git" },
    requestedSelector: version,
    resolvedRef: { kind: "tag", value: version },
    commit,
    version,
    versionMetadata: zigVersionMetadata(commit, version),
    resolvedAt: options.resolvedAt ?? CREATED,
  };
}

function zlsSourceFixture(
  options: { readonly commit?: string; readonly version?: string; readonly resolvedAt?: string } =
    {},
): ResolvedZlsSource {
  const commit = options.commit ?? ZLS_COMMIT;
  const version = options.version ?? "0.14.0";
  return validateResolvedZlsSource({
    component: "zls",
    repository: {
      identity: ZLS_SOURCE_REPOSITORY_IDENTITY,
      url: ZLS_SOURCE_REPOSITORY_URL,
    },
    requestedSelector: version,
    resolvedRef: { kind: "tag", value: version },
    commit,
    version,
    versionMetadata: {
      kind: "release",
      declaredVersion: version,
      base: version,
      text: version,
      versionString: version,
      taggedAncestor: version,
      commitsAfterTag: 0,
      commitAbbreviation: commit.slice(0, 9),
    },
    resolvedAt: options.resolvedAt ?? CREATED,
  });
}

async function withTempRoot(action: (root: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-install-store-" });
  try {
    await action(root);
  } finally {
    await cleanup(root);
  }
}

async function cleanup(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound)) throw cause;
  }
}
