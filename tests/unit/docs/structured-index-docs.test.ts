import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

describe('structured-index documentation', () => {
  it('lists all new supported extensions', async () => {
    const content = await readFile('docs/structured-index.md', 'utf8');
    for (const ext of ['.rs', '.java', '.cs', '.c', '.h', '.cc', '.cpp', '.cxx', '.hh', '.hpp', '.hxx', '.pyi']) {
      expect(content).toContain(ext);
    }
    expect(content).toContain('C++');
    expect(content).toContain('`nexus --reindex --full`');
  });

  it('documents structured parsing failure and full-rebuild recovery invariants', async () => {
    const [structuredIndex, spec] = await Promise.all([
      readFile('docs/structured-index.md', 'utf8'),
      readFile('SPEC.md', 'utf8'),
    ]);

    expect(structuredIndex).toContain('incremental update');
    expect(structuredIndex).toContain('dead-letter queue');
    expect(structuredIndex).toContain('active structured generation');
    expect(spec).toContain('journal-referenced');
  });

  it('documents language-specific outline and import semantics', async () => {
    const [structuredIndex, mcpTools] = await Promise.all([
      readFile('docs/structured-index.md', 'utf8'),
      readFile('docs/mcp-tools.md', 'utf8'),
    ]);

    expect(structuredIndex).toContain('C# / C / C++ member variables');
    expect(structuredIndex).toContain('file-scoped namespace');
    expect(mcpTools).toContain('Import completeness');
    expect(mcpTools).toContain('direct binding');
    expect(mcpTools).toContain('wildcard, static, unresolved, or diagnostic');
  });
});
