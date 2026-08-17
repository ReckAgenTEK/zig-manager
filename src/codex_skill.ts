import { dirname, join } from "@std/path";
import { assertRealPathContained, atomicWriteText } from "./filesystem.ts";
import { MANAGED_ZIG_SOURCE_DIRECTORY } from "./source_snapshot.ts";
import type { ZigUseResult } from "./types.ts";

export interface CodexSkillWriteResult {
  readonly root: string;
  readonly skill: string;
  readonly metadata: string;
}

/** Write one repository-scoped Codex skill for the exact selected toolchain. */
export async function writeCodexToolchainSkill(
  scopeRoot: string,
  result: ZigUseResult,
): Promise<CodexSkillWriteResult> {
  const zig = result.zig;
  if (zig === undefined) throw new TypeError("Codex skill requires a schema-v2 Zig selection");
  const install = dirname(dirname(zig.executable));
  const source = join(install, ...MANAGED_ZIG_SOURCE_DIRECTORY.split("/"));
  const docs = join(install, "doc");
  const std = join(install, "lib", "zig", "std");
  const root = join(scopeRoot, ".agents", "skills", "zig-manager-toolchain");
  await assertRealPathContained(scopeRoot, root);
  await Deno.mkdir(join(root, "agents"), { recursive: true });
  await assertRealPathContained(scopeRoot, root);
  const skill = join(root, "SKILL.md");
  const metadata = join(root, "agents", "openai.yaml");
  await atomicWriteText(
    skill,
    `---\n` +
      `name: zig-manager-toolchain\n` +
      `description: Use the exact managed Zig compiler, ZLS, source snapshot, language reference, and standard-library documentation selected for this repository. Use when implementing, debugging, reviewing, or answering questions about Zig in this project.\n` +
      `---\n\n` +
      `# Managed Zig ${zig.version}\n\n` +
      `Use this exact toolchain. Do not substitute another installed Zig version.\n\n` +
      `- Zig commit: ${inlineCode(zig.commit)}\n` +
      `- Zig executable: ${inlineCode(zig.executable)}\n` +
      `- ZLS executable: ${inlineCode(result.zls?.executable ?? "not installed")}\n` +
      `- Zig source: ${inlineCode(source)}\n` +
      `- Documentation root: ${inlineCode(docs)}\n` +
      `- AI documentation guide: ${inlineCode(join(docs, "AI_README.md"))}\n` +
      `- Documentation index: ${inlineCode(join(docs, "ai-index.json"))}\n` +
      `- Language reference: ${inlineCode(join(docs, "langref.html"))}\n` +
      `- Standard-library docs: ${inlineCode(join(docs, "std", "index.html"))}\n` +
      `- Standard-library source: ${inlineCode(std)}\n\n` +
      `Search source and docs locally with \`rg\` before using external references. Treat managed installation as immutable: read it, but make project changes only inside current repository. Use exact Zig executable above for builds, formatting, and tests.\n`,
  );
  await atomicWriteText(
    metadata,
    `interface:\n` +
      `  display_name: "Managed Zig Toolchain"\n` +
      `  short_description: "Use exact project Zig source and docs"\n` +
      `  default_prompt: "Use $zig-manager-toolchain for this project's Zig work."\n`,
  );
  return { root, skill, metadata };
}

function inlineCode(value: string): string {
  const longest = Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}${value}${fence}`;
}
