import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const findProjectRoot = (start: string): string => {
  let current = start;
  while (current !== "/") {
    try {
      readFileSync(join(current, "package.json"), "utf-8");
      return current;
    } catch {
      const parent = join(current, "..");
      if (parent === current) break;
      current = parent;
    }
  }
  throw new Error(`Could not find project root from ${start}`);
};

const PROJECT_ROOT = findProjectRoot(dirname(fileURLToPath(import.meta.url)));

function readGuidanceFile(filePath: string): string {
  return readFileSync(join(PROJECT_ROOT, filePath), "utf-8");
}

const GUIDANCE_FILES = {
  readme: "README.md",
  readmeJa: "README.ja.md",
  spec: "SPEC.md",
  roadmap: "ROADMAP.md",
  agents: "AGENTS.md",
  mcpTools: "docs/mcp-tools.md",
  setup: "docs/setup.md",
  skill: "skills/code-search/SKILL.md",
} as const;

describe("documentation architecture and structured retrieval guidance", () => {
  const readme = readGuidanceFile(GUIDANCE_FILES.readme);
  const readmeJa = readGuidanceFile(GUIDANCE_FILES.readmeJa);
  const spec = readGuidanceFile(GUIDANCE_FILES.spec);
  const roadmap = readGuidanceFile(GUIDANCE_FILES.roadmap);
  const agents = readGuidanceFile(GUIDANCE_FILES.agents);
  const mcpTools = readGuidanceFile(GUIDANCE_FILES.mcpTools);
  const setup = readGuidanceFile(GUIDANCE_FILES.setup);
  const skill = readGuidanceFile(GUIDANCE_FILES.skill);

  it("routes readers from the README instead of duplicating canonical references", () => {
    expect(readme).toContain("[日本語](README.ja.md)");
    expect(readme).toContain("[SPEC.md](SPEC.md)");
    expect(readme).toContain("[AGENTS.md](AGENTS.md)");
    expect(readme).toContain("[ROADMAP.md](ROADMAP.md)");
    expect(readme).toContain("[docs/mcp-tools.md](docs/mcp-tools.md)");
    expect(readme).toContain("[docs/configuration.md](docs/configuration.md)");
    expect(readmeJa).toContain("[English](README.md)");
  });

  it("separates current specification from future roadmap state", () => {
    expect(spec).toContain("canonical source for **current** Nexus architecture");
    expect(spec).toContain("[ROADMAP.md](ROADMAP.md)");
    expect(roadmap).toContain("**future target state and planned work**");
    expect(roadmap).toContain("**Planned**");
    expect(roadmap).toContain("[SPEC.md](SPEC.md)");
  });

  it("documents exact structured retrieval in the canonical MCP reference", () => {
    expect(mcpTools).toContain("get_file_outline");
    expect(mcpTools).toContain("get_symbol_source");
    expect(mcpTools).toContain("get_symbol_context");
    expect(mcpTools).toContain("usable `symbolId`");
    expect(mcpTools).toContain("stale_identity");
    expect(mcpTools).toContain("INDEX_FILE_HASH_MISMATCH");
    expect(mcpTools).toContain("STRUCTURED_INDEX_MISSING");
  });

  it("prefers exact symbol retrieval in the agent search workflow", () => {
    expect(skill).toContain("chunk.symbolId");
    expect(skill).toContain("get_symbol_source");
    expect(skill).toContain("get_symbol_context");
    expect(skill).toContain("get_file_outline");
    expect(skill).toContain("get_context");
    expect(skill).toContain("stale_identity");
  });

  it("uses the official Agent Skills metadata format", () => {
    expect(skill).toMatch(
      /^---\nname: code-search\ndescription: [^\n]+\n---\n/m,
    );
  });

  it("keeps repository-wide agent behavior out of human setup guidance", () => {
    expect(agents).toContain("Source Build");
    expect(agents).toContain("Package Usage");
    expect(agents).toContain("Do not choose on their behalf");
    expect(readmeJa).not.toContain("Do not choose on their behalf");
    expect(setup).not.toContain("Do not choose on their behalf");
    expect(setup).toContain("This guide is for people");
    expect(setup).toContain("Source Build");
    expect(setup).toContain("Package Usage");
    expect(setup).toContain("GitHub Packages");
  });

  it("requires the AI setup prompt and protocol to cover MCP and Skill separately", () => {
    for (const prompt of [readme, readmeJa]) {
      expect(prompt).toContain("https://github.com/yohi/nexus");
      expect(prompt).toContain(
        "https://raw.githubusercontent.com/yohi/nexus/master/AGENTS.md",
      );
      expect(prompt).toContain(
        "https://raw.githubusercontent.com/yohi/nexus/master/docs/setup.md",
      );
      expect(prompt).toContain(
        "https://raw.githubusercontent.com/yohi/nexus/master/skills/code-search/SKILL.md",
      );
    }

    expect(agents).toContain("MCP gate");
    expect(agents).toContain("Skill gate");
    expect(setup).toContain("Verify the Skill");
    expect(setup).toContain("code-search/SKILL.md");
    expect(setup).toContain("loaded");
  });

  it("requires setup completion to report both verification gates", () => {
    expect(agents).toContain("MCP: connected");
    expect(agents).toContain("Skill:");
    expect(setup).toContain("MCP: connected");
    expect(setup).toContain("Skill:");
    expect(setup).toContain("both gates pass");
  });

  it("keeps bridge commands mode-specific in the setup guide", () => {
    expect(setup).toContain("node dist/bin/nexus.js http-bridge");
    expect(setup).toContain("npx @yohi/nexus http-bridge");
    expect(setup).not.toMatch(/^nexus http-bridge$/m);
  });

  it("preserves structured retrieval invariants in SPEC.md", () => {
    expect(spec).toContain("Logical symbols are independent of search chunks");
    expect(spec).toContain("complete verified logical declaration");
    expect(spec).toContain("Embedding independence");
    expect(spec).toContain("Repository scope and exclusions");
    expect(spec).toContain("INDEX_FILE_HASH_MISMATCH");
  });
});
