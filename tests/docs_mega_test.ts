import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { validateDocsTree } from "../src/docs.ts";
import {
  buildMegaDocs,
  encodeBase64,
  escapeHtmlAttribute,
  escapeHtmlText,
  validateAssetContract,
} from "../src/mega_docs.ts";
import {
  DocsBuildRequiredError,
  MegaDocsUnsupportedFormatError,
  ZigDocsBuildError,
  ZigDocsOutputError,
  ZigManager,
} from "../src/mod.ts";
import { readZigManagerState } from "../src/state.ts";
import {
  cleanup,
  COMMIT_B,
  createDevelopmentFiles,
  createDocsFixture,
  FakeProcessRunner,
  FakeSourceRef,
  testConfig,
} from "./test_helpers.ts";

Deno.test("docs validation accepts only the complete nonempty Zig 0.16 output tree", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-doc-tree-" });
  try {
    await createDocsFixture(root);
    await validateDocsTree(root);
    await Deno.writeTextFile(join(root, "std", "unexpected.js"), "extra");
    await assertRejects(() => validateDocsTree(root), ZigDocsOutputError, "expected exactly");
    await Deno.remove(join(root, "std", "unexpected.js"));
    await Deno.writeFile(join(root, "std", "main.wasm"), new Uint8Array());
    await assertRejects(() => validateDocsTree(root), ZigDocsOutputError, "empty");
  } finally {
    await cleanup(root);
  }
});

Deno.test("failed docs generation preserves the prior valid reference directory", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-doc-atomic-" });
  try {
    const { manager, runner, sourceRef } = await builtManager(root);
    const prior = join(sourceRef.repositoryHome, "ref-docs");
    await Deno.mkdir(prior, { recursive: true });
    await Deno.writeTextFile(join(prior, "prior-valid.txt"), "preserve me\n");
    runner.omitDocsAsset = "std/main.wasm";
    await assertRejects(() => manager.docs(), ZigDocsOutputError);
    assertEquals(await Deno.readTextFile(join(prior, "prior-valid.txt")), "preserve me\n");
    assertEquals((await readZigManagerState(sourceRef.repositoryHome)).docs, null);
  } finally {
    await cleanup(root);
  }
});

Deno.test("docs recover staging directories left by an interrupted process", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-doc-recovery-" });
  try {
    const { manager, sourceRef } = await builtManager(root);
    const outputPrefix = join(sourceRef.repositoryHome, ".ref-docs-build");
    const publishStage = join(sourceRef.repositoryHome, ".ref-docs-staging");
    await Deno.mkdir(outputPrefix);
    await Deno.writeTextFile(join(outputPrefix, "abandoned.txt"), "incomplete\n");
    await Deno.mkdir(publishStage);
    await Deno.writeTextFile(join(publishStage, "abandoned.txt"), "incomplete\n");

    const result = await manager.docs();
    assertEquals(result.manifest.artifacts.length, 5);
    await assertRejects(() => Deno.stat(outputPrefix), Deno.errors.NotFound);
    await assertRejects(() => Deno.stat(publishStage), Deno.errors.NotFound);
  } finally {
    await cleanup(root);
  }
});

Deno.test("docs do not clean staging while another operation holds the lock", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-doc-contention-" });
  try {
    const { manager, runner, sourceRef } = await builtManager(root);
    let signalStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let releaseDocs: () => void = () => {};
    runner.docsGate = new Promise<void>((resolve) => {
      releaseDocs = resolve;
    });
    runner.docsStarted = signalStarted;
    const activeDocs = manager.docs();
    await started;
    const outputPrefix = join(sourceRef.repositoryHome, ".ref-docs-build");
    const sentinel = join(outputPrefix, "active.txt");
    await Deno.writeTextFile(sentinel, "active\n");
    try {
      await assertRejects(
        () => manager.docs(),
        ZigDocsBuildError,
        "already running",
      );
      assertEquals(await Deno.readTextFile(sentinel), "active\n");
    } finally {
      releaseDocs();
      await activeDocs;
    }
  } finally {
    await cleanup(root);
  }
});

Deno.test("docs manifests and mega output are reproducible and become stale by commit", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-docs-" });
  try {
    const { manager, runner, sourceRef } = await builtManager(root);
    const first = await manager.docs();
    const manifestPath = join(first.manifest.outputPath, "manifest.json");
    const firstManifest = await Deno.readTextFile(manifestPath);
    const firstMega = await Deno.readFile(
      join(first.manifest.outputPath, first.manifest.mega?.path ?? "missing"),
    );
    const second = await manager.docs();
    assertEquals(await Deno.readTextFile(manifestPath), firstManifest);
    assertEquals(
      await Deno.readFile(
        join(second.manifest.outputPath, second.manifest.mega?.path ?? "missing"),
      ),
      firstMega,
    );
    assertEquals(second.manifest.artifacts.length, 5);
    assertEquals(second.manifest.mega?.formatVersion, 1);
    const docsCommand = runner.requests.find((request) => request.args.includes("docs"));
    assert(docsCommand);
    assertEquals(docsCommand.executable, "prlimit");
    assertEquals(docsCommand.args.slice(0, 3), ["--core=1:", "--", docsCommand.args[2]]);
    assert(docsCommand.args.includes("-Dversion-string=0.16.0"));

    sourceRef.refs.push({ kind: "tag", name: "0.16.1", commit: COMMIT_B });
    await manager.update();
    const status = await manager.status();
    assertEquals(status.docs.stale, true);
    await assertRejects(() => manager.docs(), DocsBuildRequiredError);
    assert(runner.requests.every((request) => !/(^|[/\\])git(?:\.exe)?$/.test(request.executable)));
  } finally {
    await cleanup(root);
  }
});

Deno.test("mega v1 escapes frames, embeds synthetic WASM/tar, and has no external runtime assets", async () => {
  const root = await Deno.makeTempDir({ prefix: "zig-manager-mega-" });
  const secondRoot = await Deno.makeTempDir({ prefix: "zig-manager-mega-copy-" });
  try {
    await createDocsFixture(root);
    await createDocsFixture(secondRoot);
    await Deno.writeTextFile(
      join(root, "langref.html"),
      '<!doctype html><html><body data-value="<&">Language & reference</body></html>',
    );
    await Deno.writeTextFile(
      join(secondRoot, "langref.html"),
      '<!doctype html><html><body data-value="<&">Language & reference</body></html>',
    );
    const artifacts = [
      { path: "langref.html", sha256: "1".repeat(64), size: 1 },
      { path: "std/index.html", sha256: "2".repeat(64), size: 1 },
      { path: "std/main.js", sha256: "3".repeat(64), size: 1 },
      { path: "std/main.wasm", sha256: "4".repeat(64), size: 1 },
      { path: "std/sources.tar", sha256: "5".repeat(64), size: 1 },
    ];
    const first = await buildMegaDocs({
      docsRoot: root,
      version: "0.16.0",
      commit: "a".repeat(40),
      artifacts,
    });
    const second = await buildMegaDocs({
      docsRoot: secondRoot,
      version: "0.16.0",
      commit: "a".repeat(40),
      artifacts,
    });
    const html = await Deno.readTextFile(join(root, first.path));
    assertEquals(
      await Deno.readFile(join(root, first.path)),
      await Deno.readFile(join(secondRoot, second.path)),
    );
    assertStringIncludes(html, "Zig 0.16.0");
    assertStringIncludes(html, "commit aaaaaaaaaa");
    assertStringIncludes(html, "application/wasm");
    assertStringIncludes(html, "AGFzbQEAAAA=");
    assertStringIncludes(html, "&lt;!doctype html&gt;");
    assertEquals(html.includes('<script src="main.js">'), false);
    assertEquals(/<script\b[^>]*\bsrc=/i.test(html), false);
    assertEquals(/fetch\s*\(\s*["']https?:/i.test(html), false);
    assertEquals(first.sha256, second.sha256);
  } finally {
    await cleanup(root);
    await cleanup(secondRoot);
  }
});

Deno.test("mega helpers escape HTML and reject autodoc contract drift", () => {
  assertEquals(escapeHtmlText('<&>"'), '&lt;&amp;&gt;"');
  assertEquals(escapeHtmlAttribute('<&>"'), "&lt;&amp;&gt;&quot;");
  assertEquals(encodeBase64(new Uint8Array([0, 97, 115, 109])), "AGFzbQ==");
  const index = '<html><script src="main.js"></script></html>';
  const official =
    'let wasm_promise = fetch("main.wasm"); let sources_promise = fetch("sources.tar"); // http://example.com/#foo documents hash parsing';
  validateAssetContract(index, official);
  assertThrows(
    () => validateAssetContract(index, `${official} fetch("extra.bin");`),
    MegaDocsUnsupportedFormatError,
  );
});

async function builtManager(root: string): Promise<{
  manager: ZigManager;
  runner: FakeProcessRunner;
  sourceRef: FakeSourceRef;
}> {
  const prefix = await createDevelopmentFiles(root);
  const sourceRef = new FakeSourceRef(root);
  const runner = new FakeProcessRunner(prefix);
  const manager = new ZigManager({
    projectRoot: root,
    config: testConfig(root, prefix),
    sourceRef,
    runner,
    platform: "linux",
    hostTarget: "x86_64-unknown-linux-gnu",
  });
  await manager.use("0.16");
  await manager.build();
  return { manager, runner, sourceRef };
}
