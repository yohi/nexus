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
});
