import { describe, expect, it } from 'vitest';

import { executeGrepSearch } from '../../../../src/server/tools/grep-search.js';
import { TestGrepEngine } from '../../search/test-grep-engine.js';
import { PathTraversalError } from '../../../../src/types/index.js';

describe('executeGrepSearch', () => {
  it('returns grep matches with filePattern and maxResults applied', async () => {
    const grepEngine = new TestGrepEngine();
    grepEngine.addFile('src/auth.ts', 'export function authenticate() {}\n');
    grepEngine.addFile('src/config.ts', 'export function configure() {}\n');

    const result = await executeGrepSearch(grepEngine, process.cwd(), {
      pattern: 'function',
      filePattern: 'src/*.ts',
      maxResults: 1,
    });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.filePath).toBe('src/auth.ts');
  });

  it('rejects filePattern with parent traversal', async () => {
    const grepEngine = new TestGrepEngine();

    await expect(
      executeGrepSearch(grepEngine, process.cwd(), {
        pattern: 'function',
        filePattern: '../*.ts',
      }),
    ).rejects.toBeInstanceOf(PathTraversalError);
  });
});
