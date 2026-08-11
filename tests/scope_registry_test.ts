import { assert, assertEquals, assertFalse, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { ZigOperationAbortedError } from "../src/errors.ts";
import { ScopePinStore } from "../src/scope_pin.ts";
import {
  parseScopeRegistry,
  SCOPE_REGISTRY_MAX_BYTES,
  ScopeRegistryStore,
  ScopeRegistryValidationError,
  serializeScopeRegistry,
  validateScopeRegistry,
} from "../src/scope_registry.ts";

const PROFILE_A = "a".repeat(64);
const PROFILE_B = "b".repeat(64);
const PROFILE_C = "c".repeat(64);
const PROFILE_D = "d".repeat(64);
const PROFILE_E = "e".repeat(64);
const PROFILE_F = "f".repeat(64);
const TIME_A = "2026-08-10T10:11:12.000Z";
const TIME_B = "2026-08-10T10:12:13.000Z";

Deno.test("scope registry parser accepts only the canonical strict v1 shape", () => {
  const valid = {
    schemaVersion: 1 as const,
    scopes: [
      entry("/a scope", PROFILE_A, "use latest", TIME_A),
      entry("/z-scope", PROFILE_B, "update latest", TIME_B),
    ],
  };
  assertEquals(validateScopeRegistry(valid), valid);
  assertEquals(parseScopeRegistry(serializeScopeRegistry(valid)), valid);

  const invalid: unknown[] = [
    null,
    [],
    {},
    { schemaVersion: 2, scopes: [] },
    { schemaVersion: 1, scopes: [], unknown: true },
    { schemaVersion: 1, scopes: [entry("relative", PROFILE_A, "use", TIME_A)] },
    { schemaVersion: 1, scopes: [entry("/not/../normalized", PROFILE_A, "use", TIME_A)] },
    { schemaVersion: 1, scopes: [entry("/bad\npath", PROFILE_A, "use", TIME_A)] },
    { schemaVersion: 1, scopes: [entry("/scope", "A".repeat(64), "use", TIME_A)] },
    { schemaVersion: 1, scopes: [entry("/scope", PROFILE_A, " use", TIME_A)] },
    { schemaVersion: 1, scopes: [entry("/scope", PROFILE_A, "use\u007fnow", TIME_A)] },
    { schemaVersion: 1, scopes: [entry("/scope", PROFILE_A, "use", "2026-02-30T00:00:00Z")] },
    {
      schemaVersion: 1,
      scopes: [{ ...entry("/scope", PROFILE_A, "use", TIME_A), unknown: true }],
    },
    {
      schemaVersion: 1,
      scopes: [
        entry("/z-scope", PROFILE_A, "use", TIME_A),
        entry("/a-scope", PROFILE_B, "use", TIME_A),
      ],
    },
    {
      schemaVersion: 1,
      scopes: [
        entry("/scope", PROFILE_A, "use", TIME_A),
        entry("/scope", PROFILE_B, "update", TIME_B),
      ],
    },
  ];
  for (const value of invalid) assertThrows(() => validateScopeRegistry(value), TypeError);
  assertThrows(
    () => parseScopeRegistry("{not-json\n", "/state/scopes.json"),
    ScopeRegistryValidationError,
    "JSON",
  );
});

Deno.test("scope pin temporary files are operation-owned and foreign collisions are retained", async () => {
  await withTempRoot(async (root) => {
    const project = join(root, "project");
    const metadata = join(project, ".zig-manager");
    const operationId = "11111111-1111-4111-8111-111111111111";
    await Deno.mkdir(metadata, { recursive: true });
    const foreign = join(metadata, `.toolchain.tmp-${operationId}`);
    await Deno.writeTextFile(foreign, "foreign temporary bytes\n");
    const pins = new ScopePinStore();
    await assertRejects(
      () => pins.write(project, PROFILE_A, { operationId }),
      Error,
      "atomically",
    );
    assertEquals(await Deno.readTextFile(foreign), "foreign temporary bytes\n");

    const controller = new AbortController();
    controller.abort("SIGINT");
    await assertRejects(
      () =>
        pins.write(project, PROFILE_A, {
          operationId: "22222222-2222-4222-8222-222222222222",
          signal: controller.signal,
        }),
      ZigOperationAbortedError,
    );
    assertEquals(await names(metadata), [`.toolchain.tmp-${operationId}`]);
  });
});

Deno.test("record verifies publication, stores physical roots, upserts, and writes atomically", async () => {
  await withTempRoot(async (root) => {
    const registryPath = join(root, "manager state", "scopes.json");
    const project = join(root, "project space '$;[]");
    const other = join(root, "a-project");
    const alias = join(root, "project-alias");
    await Deno.mkdir(project);
    await Deno.mkdir(other);
    await Deno.symlink(project, alias);
    const times = [new Date(TIME_A), new Date(TIME_B), new Date(TIME_B)];
    const registry = new ScopeRegistryStore({
      registryPath,
      now: () => times.shift()!,
    });
    const pins = new ScopePinStore();

    await assertRejects(
      () => registry.record(project, PROFILE_A, "use latest"),
      ScopeRegistryValidationError,
      "must be published",
    );
    await pins.write(project, PROFILE_A);
    const first = await registry.record(alias, PROFILE_A, "use latest");
    assertEquals(first.scopeRoot, await Deno.realPath(project));
    assertEquals(first.updatedAt, TIME_A);

    await pins.write(project, PROFILE_B);
    const updated = await registry.record(project, PROFILE_B, "update latest");
    assertEquals(updated.profileId, PROFILE_B);
    assertEquals(updated.updatedAt, TIME_B);
    await pins.write(other, PROFILE_C);
    await registry.record(other, PROFILE_C, "use 0.16");

    const stored = await registry.read();
    assertEquals(stored?.scopes.length, 2);
    assertEquals(stored?.scopes.map((item) => item.scopeRoot), [
      await Deno.realPath(other),
      await Deno.realPath(project),
    ]);
    assertEquals(stored?.scopes[1].profileId, PROFILE_B);
    assertEquals((await Deno.lstat(registryPath)).mode! & 0o777, 0o600);
    assertEquals(
      (await names(join(root, "manager state"))).filter((name) => name.includes(".tmp-")),
      [],
    );

    const stableBytes = await Deno.readTextFile(registryPath);
    await assertRejects(
      () => registry.record(project, PROFILE_A, "stale update"),
      ScopeRegistryValidationError,
      "not",
    );
    assertEquals(await Deno.readTextFile(registryPath), stableBytes);
  });
});

Deno.test("concurrent in-process registry mutations retain every published scope", async () => {
  await withTempRoot(async (root) => {
    const registryPath = join(root, "state", "scopes.json");
    const first = join(root, "first");
    const second = join(root, "second");
    await Deno.mkdir(first);
    await Deno.mkdir(second);
    const pins = new ScopePinStore();
    await pins.write(first, PROFILE_A);
    await pins.write(second, PROFILE_B);
    const left = new ScopeRegistryStore({ registryPath, now: () => new Date(TIME_A) });
    const right = new ScopeRegistryStore({ registryPath, now: () => new Date(TIME_B) });

    await Promise.all([
      left.record(first, PROFILE_A, "use first"),
      right.record(second, PROFILE_B, "use second"),
    ]);
    assertEquals((await left.read())?.scopes.map((item) => item.profileId), [
      PROFILE_A,
      PROFILE_B,
    ]);
  });
});

Deno.test("remove requires prior exact unpublication and never removes an inherited scope", async () => {
  await withTempRoot(async (root) => {
    const parent = join(root, "parent");
    const nested = join(parent, "nested");
    const deep = join(nested, "deep");
    await Deno.mkdir(deep, { recursive: true });
    const pins = new ScopePinStore();
    const registry = new ScopeRegistryStore({
      registryPath: join(root, "state", "scopes.json"),
      now: () => new Date(TIME_A),
    });
    await pins.write(parent, PROFILE_A);
    await pins.write(nested, PROFILE_B);
    await registry.record(parent, PROFILE_A, "use parent");
    await registry.record(nested, PROFILE_B, "use nested");

    await assertRejects(
      () => registry.remove(nested),
      ScopeRegistryValidationError,
      "still published",
    );
    assertFalse(await registry.remove(deep));
    assertEquals((await registry.read())?.scopes.length, 2);

    assert(await pins.remove(nested));
    assert(await registry.remove(nested));
    assertFalse(await registry.remove(nested));
    assertEquals((await registry.read())?.scopes.map((item) => item.profileId), [PROFILE_A]);
    assert(await pins.remove(parent));
    assert(await registry.remove(parent));
    const inspection = await registry.inspect();
    assert(inspection.registryPresent);
    assert(inspection.profilePruningSafe);
    assertEquals(inspection.referencedProfileIds, []);
  });
});

Deno.test("inspection classifies conservatively and supplies safe cleanup references", async () => {
  await withTempRoot(async (root) => {
    const live = join(root, "01-live");
    const moved = join(root, "02-moved");
    const movedDestination = join(root, "moved destination");
    const deleted = join(root, "03-deleted");
    const invalid = join(root, "04-invalid");
    const stale = join(root, "05-stale");
    for (const path of [live, moved, deleted, invalid, stale]) await Deno.mkdir(path);
    const pins = new ScopePinStore();
    const registry = new ScopeRegistryStore({
      registryPath: join(root, "state", "scopes.json"),
      now: () => new Date(TIME_A),
    });
    const records: readonly [string, string][] = [
      [live, PROFILE_A],
      [moved, PROFILE_B],
      [deleted, PROFILE_C],
      [invalid, PROFILE_D],
      [stale, PROFILE_E],
    ];
    for (const [path, profileId] of records) {
      await pins.write(path, profileId);
      await registry.record(path, profileId, `use ${profileId[0]}`);
    }

    await Deno.rename(moved, movedDestination);
    await Deno.symlink(movedDestination, moved);
    await Deno.remove(deleted, { recursive: true });
    await Deno.writeTextFile(
      join(invalid, ".zig-manager", "toolchain"),
      "zig-manager-scope-v1\nprofile=invalid\n",
    );
    await pins.write(stale, PROFILE_F);

    const inspection = await registry.inspect();
    const byRoot = new Map(inspection.entries.map((item) => [item.entry.scopeRoot, item]));
    assertEquals(byRoot.get(live)?.classification, "live");
    assertEquals(byRoot.get(live)?.profileMatches, true);
    assertEquals(byRoot.get(moved)?.classification, "moved");
    assertEquals(byRoot.get(moved)?.physicalScopeRoot, await Deno.realPath(movedDestination));
    assertEquals(byRoot.get(deleted)?.classification, "deleted");
    assertEquals(byRoot.get(invalid)?.classification, "unverifiable");
    assertEquals(byRoot.get(stale)?.classification, "live");
    assertEquals(byRoot.get(stale)?.observedProfileId, PROFILE_F);
    assertEquals(byRoot.get(stale)?.profileMatches, false);

    assertEquals(inspection.definitelyReferencedProfileIds, [PROFILE_A, PROFILE_B, PROFILE_F]);
    assertEquals(inspection.uncertainProfileIds, [PROFILE_C, PROFILE_D, PROFILE_E]);
    assertEquals(inspection.referencedProfileIds, [
      PROFILE_A,
      PROFILE_B,
      PROFILE_C,
      PROFILE_D,
      PROFILE_E,
      PROFILE_F,
    ]);
    assertFalse(inspection.profilePruningSafe);
    assertEquals(inspection.knownPins.map((pin) => pin.pinPath), [
      join(live, ".zig-manager", "toolchain"),
      join(invalid, ".zig-manager", "toolchain"),
      join(stale, ".zig-manager", "toolchain"),
      join(movedDestination, ".zig-manager", "toolchain"),
    ]);
    assertEquals(inspection.knownPins.map((pin) => pin.valid), [true, false, true, true]);

    const references = await registry.referencedProfiles();
    assertEquals(references.profileIds, inspection.referencedProfileIds);
    assertFalse(references.complete);
  });
});

Deno.test("missing, malformed, oversized, and symlinked registries are never trusted", async () => {
  await withTempRoot(async (root) => {
    const missing = new ScopeRegistryStore(join(root, "missing state", "scopes.json"));
    const missingInspection = await missing.inspect();
    assertFalse(missingInspection.registryPresent);
    assertFalse(missingInspection.profilePruningSafe);

    const malformedPath = join(root, "malformed", "scopes.json");
    await Deno.mkdir(join(root, "malformed"));
    await Deno.writeTextFile(malformedPath, '{"schemaVersion":1,"scopes":[],"extra":true}\n');
    const malformed = new ScopeRegistryStore(malformedPath);
    await assertRejects(
      () => malformed.read(),
      ScopeRegistryValidationError,
      "unknown key",
    );

    const oversizedPath = join(root, "oversized.json");
    await Deno.writeTextFile(oversizedPath, "x".repeat(SCOPE_REGISTRY_MAX_BYTES + 1));
    await assertRejects(
      () => new ScopeRegistryStore(oversizedPath).read(),
      ScopeRegistryValidationError,
      "exceeds",
    );

    const target = join(root, "target.json");
    const linked = join(root, "linked.json");
    await Deno.writeTextFile(target, '{"schemaVersion":1,"scopes":[]}\n');
    await Deno.symlink(target, linked);
    await assertRejects(
      () => new ScopeRegistryStore(linked).read(),
      ScopeRegistryValidationError,
      "physical regular file",
    );

    const realParent = join(root, "real-parent");
    const linkedParent = join(root, "linked-parent");
    await Deno.mkdir(realParent);
    await Deno.symlink(realParent, linkedParent);
    await Deno.writeTextFile(join(realParent, "scopes.json"), '{"schemaVersion":1,"scopes":[]}\n');
    await assertRejects(
      () => new ScopeRegistryStore(join(linkedParent, "scopes.json")).read(),
      ScopeRegistryValidationError,
      "physical directory",
    );
  });
});

Deno.test("scope registry JSON schema is versioned and strict", async () => {
  const schema = JSON.parse(
    await Deno.readTextFile(new URL("../schema/scopes-v1.schema.json", import.meta.url)),
  );
  assertEquals(schema.$id, "https://jsr.io/@zignado/zig-manager/scopes-v1.schema.json");
  assertEquals(schema.additionalProperties, false);
  assertEquals(schema.required, ["schemaVersion", "scopes"]);
  assertEquals(schema.properties.schemaVersion.const, 1);
  assertEquals(schema.properties.scopes.maxItems, 16_384);
  assertEquals(schema.$defs.scope.additionalProperties, false);
  assertEquals(schema.$defs.scope.required, [
    "scopeRoot",
    "profileId",
    "lastOperation",
    "updatedAt",
  ]);
});

function entry(
  scopeRoot: string,
  profileId: string,
  lastOperation: string,
  updatedAt: string,
) {
  return { scopeRoot, profileId, lastOperation, updatedAt };
}

async function names(path: string): Promise<string[]> {
  const result: string[] = [];
  for await (const item of Deno.readDir(path)) result.push(item.name);
  return result.sort();
}

async function withTempRoot(action: (root: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-scope-registry-" });
  try {
    await action(root);
  } finally {
    await removeTree(root);
  }
}

async function removeTree(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (cause) {
    if (!(cause instanceof Deno.errors.NotFound)) throw cause;
  }
}
