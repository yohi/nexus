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

function extractSpecSection(
  source: string,
  heading: string,
  nextHeading: RegExp,
): string {
  const start = source.indexOf(heading);
  if (start === -1) {
    throw new Error(`SPEC.md heading not found: ${heading}`);
  }
  const bodyStart = source.indexOf("\n", start) + 1;
  const end = source.slice(bodyStart).search(nextHeading);
  if (end === -1) {
    throw new Error(`SPEC.md next section heading not found after: ${heading}`);
  }
  return source.slice(start, bodyStart + end);
}

const normalizeSpecText = (text: string): string =>
  text
    .replace(/[`*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

function sliceBetween(text: string, startAnchor: string, endAnchor: string): string {
  const start = text.indexOf(startAnchor);
  if (start === -1) {
    return "";
  }
  const after = start + startAnchor.length;
  const end = text.indexOf(endAnchor, after);
  return end === -1 ? text.slice(after) : text.slice(after, end);
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

describe("SPEC.md §6 retrieval architecture boundary guidance (subsection-scoped)", () => {
  const spec = readGuidanceFile(GUIDANCE_FILES.spec);

  const SIX_HEADING = "## 6. Retrieval Architecture Boundaries and Source of Truth";
  const SIX_SUBSECTION_END = /^(### 6\.\d|## 7\.)/m;

  const sixSubsection = (n: number): string =>
    extractSpecSection(spec, `### 6.${n} `, SIX_SUBSECTION_END);

  const expectPhraseInSection = (section: string, phrase: string): void => {
    expect(normalizeSpecText(section)).toContain(normalizeSpecText(phrase));
  };

  const expectNotPhraseInSection = (section: string, phrase: string): void => {
    expect(normalizeSpecText(section)).not.toContain(normalizeSpecText(phrase));
  };

  it("localizes the boundary guidance to §6 with all eight subsections before §7", () => {
    const six = extractSpecSection(spec, SIX_HEADING, /^## 7\./m);
    expect(six).toContain(SIX_HEADING);
    expect(six).not.toContain("## 7. Structured Symbol Retrieval");
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(six).toContain(`### 6.${n} `);
    }
  });

  it("keeps 6.1 scoped to source files as the only source of truth", () => {
    const section = sixSubsection(1);
    expectPhraseInSection(section, "### 6.1 Source files are the only source of truth");
    expectPhraseInSection(section, "the only source of truth is the current working tree");
    expectPhraseInSection(section, "derived data");
    expectPhraseInSection(section, "not authoritative source content");
  });

  it("keeps 6.2 scoped to one responsibility per retrieval layer", () => {
    const section = sixSubsection(2);
    expectPhraseInSection(section, "### 6.2 Retrieval layers and responsibilities");
    expectPhraseInSection(section, "semantic index");
    expectPhraseInSection(section, "derived cache");
    expectPhraseInSection(section, "text search");
    expectPhraseInSection(section, "grep_search");
    expectPhraseInSection(section, "directly against source files");
    expectPhraseInSection(section, "structured catalog");
    expectPhraseInSection(section, "persistent symbol locator");
    expectPhraseInSection(section, "current working tree");
    expectPhraseInSection(section, "authoritative source content");
    expectPhraseInSection(section, "lsp");
    expectPhraseInSection(section, "on-demand semantic relationships");
    expectPhraseInSection(section, "computed live rather than persisted as authoritative state");
  });

  it("keeps 6.3 scoped to approximate discovery versus verified/current-source retrieval", () => {
    const section = sixSubsection(3);
    expectPhraseInSection(
      section,
      "### 6.3 Approximate discovery vs verified/current-source retrieval",
    );
    expectPhraseInSection(section, "approximate discovery");
    expectPhraseInSection(
      section,
      "must be verified before being treated as authoritative declarations",
    );
    expectPhraseInSection(section, "verified/current-source retrieval");
    expectPhraseInSection(section, "stale");
    expectPhraseInSection(section, "stale_identity");
    expectPhraseInSection(section, "degraded");
    expectPhraseInSection(section, "index_incomplete");
    expectPhraseInSection(section, "unsupported");
    expectPhraseInSection(section, "not_indexed");
    expectPhraseInSection(
      section,
      "rather than presenting stale or guessed source as current",
    );
  });

  it("keeps 6.4 scoped to distinct chunk and logical symbol units", () => {
    const section = sixSubsection(4);
    expectPhraseInSection(section, "### 6.4 Search chunks and logical symbols are distinct units");
    expectPhraseInSection(section, "search chunks are ranking/retrieval units");
    expectPhraseInSection(
      section,
      "chunk boundaries must not become authoritative declaration boundaries",
    );
    expectPhraseInSection(section, "stable `symbolid`");
  });

  it("keeps 6.5 scoped to what the structured catalog owns and does not own", () => {
    const whole = normalizeSpecText(sixSubsection(5));
    const ownsPart = sliceBetween(whole, "the structured catalog owns", "does not own");
    const doesNotOwnPart = sliceBetween(
      whole,
      "does not own",
      "when these relationships are needed",
    );

    expectPhraseInSection(whole, "### 6.5 Structured Catalog persistence boundaries");
    // ownership boundary statements
    expectPhraseInSection(whole, "the structured catalog owns");
    expectPhraseInSection(whole, "must never be treated as the source of truth");
    expectPhraseInSection(whole, "derived from the current working tree through lsp");

    // owned items must appear inside the owns list
    expectPhraseInSection(ownsPart, "symbolid identity");
    expectPhraseInSection(ownsPart, "kind");
    expectPhraseInSection(ownsPart, "logical name");
    expectPhraseInSection(ownsPart, "qualified name");
    expectPhraseInSection(ownsPart, "declaration range");
    expectPhraseInSection(ownsPart, "file hashes");
    expectPhraseInSection(ownsPart, "retirement state");
    expectPhraseInSection(ownsPart, "parser coverage");

    // non-owned items must appear inside the does-not-own list
    expectPhraseInSection(doesNotOwnPart, "references");
    expectPhraseInSection(doesNotOwnPart, "caller/callee graphs");
    expectPhraseInSection(doesNotOwnPart, "type hierarchies");
    expectPhraseInSection(doesNotOwnPart, "resolved import graphs");
    expectPhraseInSection(doesNotOwnPart, "inferred type information");
  });

  it("keeps 6.6 scoped to lsp observations not persisted as authoritative graphs", () => {
    const section = sixSubsection(6);
    expectPhraseInSection(section, "### 6.6 LSP-backed semantic navigation role");
    expectPhraseInSection(section, "lsp results are live semantic observations");
    expectPhraseInSection(
      section,
      "not persisted as authoritative reference/call/type graphs",
    );
    expectPhraseInSection(section, "yohi/nexus#298");
  });

  it("keeps 6.7 scoped to evidence-gated non-goals rejecting persistent graphs in general", () => {
    const section = sixSubsection(7);
    expectPhraseInSection(section, "### 6.7 Architecture non-goals");
    expectPhraseInSection(section, "retrieval architecture non-goals");
    expectPhraseInSection(
      section,
      "does not pursue persistent reference, call, or type graphs",
    );
    expectPhraseInSection(
      section,
      "The Structured Catalog must not become a persistent semantic graph",
    );
    expectPhraseInSection(
      section,
      "not pursued unless future evidence justifies",
    );
    expectPhraseInSection(section, "any exception requires explicit evidence");
    expectPhraseInSection(
      section,
      "reimplementing language-server semantics",
    );
    expectNotPhraseInSection(section, "authoritative state");
  });

  it("keeps 6.8 scoped to language adapters limited to declaration discovery", () => {
    const section = sixSubsection(8);
    expectPhraseInSection(section, "### 6.8 Language adapter expectations");
    expectPhraseInSection(section, "language adapters");
    expectPhraseInSection(section, "declaration discovery");
    expectPhraseInSection(section, "stable identity");
    expectPhraseInSection(section, "declaration range");
    expectPhraseInSection(section, "parser coverage");
    expectPhraseInSection(section, "not required or expected");
    expectPhraseInSection(section, "resolve references");
    expectPhraseInSection(section, "build call graphs");
    expectPhraseInSection(section, "reconstruct type hierarchies");
    expectPhraseInSection(section, "infer types");
  });
});
