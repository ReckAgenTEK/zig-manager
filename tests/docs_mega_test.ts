import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { validateDocsTree } from "../src/docs.ts";
import {
  buildMegaDocs,
  encodeBase64,
  escapeHtmlAttribute,
  escapeHtmlText,
  validateAssetContract,
} from "../src/mega_docs.ts";
import { MegaDocsUnsupportedFormatError, ZigDocsOutputError } from "../src/mod.ts";
import { cleanup, createDocsFixture } from "./test_helpers.ts";

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
