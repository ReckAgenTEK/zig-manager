import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { ZigManager } from "../src/mod.ts";
import { readZigManagerState, writeZigManagerState } from "../src/state.ts";
import {
  cleanup,
  COMMIT_A,
  COMMIT_B,
  FakeProcessRunner,
  FakeSourceRef,
  testConfig,
} from "./test_helpers.ts";

Deno.test("use resolves before pinned ensure, sync preserves lock, and update re-resolves", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-state-" });
  try {
    const sourceRef = new FakeSourceRef(root);
    const manager = new ZigManager({
      projectRoot: root,
      config: testConfig(root),
      sourceRef,
      runner: new FakeProcessRunner(join(root, "toolchain")),
    });
    const selected = await manager.use("0.16");
    assertEquals(selected.commit, COMMIT_A);
    assertEquals(sourceRef.calls.slice(0, 3), ["listRemoteRefs", "ensure", "path"]);

    sourceRef.refs.push({ kind: "tag", name: "0.16.1", commit: COMMIT_B });
    const listCount = sourceRef.calls.filter((call) => call === "listRemoteRefs").length;
    const synced = await manager.sync();
    assertEquals(synced.commit, COMMIT_A);
    assertEquals(sourceRef.calls.filter((call) => call === "listRemoteRefs").length, listCount);

    const updated = await manager.update();
    assertEquals(updated.commit, COMMIT_B);
    assertEquals(updated.version.text, "0.16.1");
    assert(sourceRef.calls.includes("update"));
    const state = await readZigManagerState(sourceRef.repositoryHome);
    assertEquals(state.source?.commit, COMMIT_B);
  } finally {
    await cleanup(root);
  }
});

Deno.test("failed remote discovery leaves source state untouched and invokes no process", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-failed-use-" });
  try {
    const sourceRef = new FakeSourceRef(root);
    sourceRef.failRemote = true;
    const runner = new FakeProcessRunner(join(root, "toolchain"));
    const manager = new ZigManager({
      projectRoot: root,
      config: testConfig(root),
      sourceRef,
      runner,
    });
    await assertRejects(() => manager.use("0.16"), Error, "remote unavailable");
    assertEquals(runner.requests.length, 0);
    assertEquals((await readZigManagerState(sourceRef.repositoryHome)).source, null);
  } finally {
    await cleanup(root);
  }
});

Deno.test("source switches preserve prior build/docs pointers and status marks both stale by commit", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-stale-" });
  try {
    const sourceRef = new FakeSourceRef(root);
    const manager = new ZigManager({ projectRoot: root, config: testConfig(root), sourceRef });
    await manager.use("0.16");
    const state = await readZigManagerState(sourceRef.repositoryHome);
    await writeZigManagerState(sourceRef.repositoryHome, {
      ...state,
      activeBuild: {
        commit: COMMIT_A,
        identity: "1".repeat(64),
        manifestPath: join(sourceRef.repositoryHome, "missing-build.json"),
        executablePath: join(sourceRef.repositoryHome, "missing-zig"),
      },
      docs: {
        commit: COMMIT_A,
        manifestPath: join(sourceRef.repositoryHome, "missing-docs.json"),
        directory: join(sourceRef.repositoryHome, "ref-docs"),
        megaPath: null,
      },
    });
    sourceRef.refs.push({ kind: "tag", name: "0.16.1", commit: COMMIT_B });
    await manager.update();
    const status = await manager.status();
    assertEquals(status.build.stale, true);
    assertEquals(status.docs.stale, true);
    assertEquals(status.build.commit, COMMIT_A);
    assertEquals(status.docs.commit, COMMIT_A);
  } finally {
    await cleanup(root);
  }
});
