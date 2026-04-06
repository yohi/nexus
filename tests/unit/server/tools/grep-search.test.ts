import { describe, expect, it } from 'vitest';

import { executeGrepSearch } from '../../../../src/server/tools/grep-search.js';
import { TestGrepEngine } from '../../search/test-grep-engine.js';
import type { GrepParams } from '../../../../src/types/index.js';
import { PathTraversalError } from '../../../../src/server/path-sanitizer.js';

describe('executeGrepSearch', () => {
  it('returns grep matches with filePattern and maxResults applied', async () => {
    const grepEngine = new TestGrepEngine();
    grepEngine.addFile('src/auth.ts', 'export function authenticate() {}\n');
    grepEngine.addFile('src/config.ts', 'export function configure() {}\n');

    const mockSanitizer = {
      validateGlob: (p: string) => p,
    };

    const result = await executeGrepSearch(
      grepEngine,
      process.cwd(),
      mockSanitizer as any,
      {
        pattern: 'function',
        filePattern: 'src/*.ts',
        maxResults: 1,
      },
    );

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.filePath).toBe('src/auth.ts');
  });

  it('forwards abortSignal to the grep engine', async () => {
    class StubGrepEngine {
      public lastParams?: GrepParams;

      async search(params: GrepParams) {
        this.lastParams = params;
        return [];
      }
    }

    const grepEngine = new StubGrepEngine();
    const controller = new AbortController();

    const mockSanitizer = {
      validateGlob: (p: string) => p,
    };

    await executeGrepSearch(
      grepEngine as never,
      process.cwd(),
      mockSanitizer as any,
      {
        pattern: 'function',
      },
      controller.signal,
    );

    expect(grepEngine.lastParams?.abortSignal).toBe(controller.signal);
  });

  it('rejects invalid filePattern before calling the grep engine', async () => {
    const mockSanitizer = {
      validateGlob: () => {
        throw new PathTraversalError('invalid');
      },
    };

    class StubGrepEngine {
      public called = false;

      async search() {
        this.called = true;
        return [];
      }
    }

    const grepEngine = new StubGrepEngine();

    await expect(
      executeGrepSearch(
        grepEngine as never,
        process.cwd(),
        mockSanitizer as any,
        {
          pattern: 'function',
          filePattern: '../outside',
        },
      ),
    ).rejects.toThrow(PathTraversalError);

    expect(grepEngine.called).toBe(false);
  });
});
