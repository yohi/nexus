import { describe, expect, it } from 'vitest';
import { createQualityFixture } from '../../../../tests/benchmarks/quality/fixtures.js';
import {
  createNexusAdapterForRoot,
  LocalGrepEngine,
  simpleGlobMatch,
} from '../../../../tests/benchmarks/quality/runner.js';

describe('simpleGlobMatch', () => {
  it('matches arbitrary characters for a star wildcard and treats dots literally', () => {
    expect(simpleGlobMatch('src/file.test.ts', 'src/*.ts')).toBe(true);
    expect(simpleGlobMatch('src/fileXts', 'src/*.ts')).toBe(false);
  });

  it('escapes other regular expression metacharacters in glob patterns', () => {
    expect(simpleGlobMatch('src/[file]+.ts', 'src/*[file]+.ts')).toBe(true);
    expect(simpleGlobMatch('src/file+.ts', 'src/*[file]+.ts')).toBe(false);
  });

  it('treats exclusion-only patterns as all files except the exclusions', async () => {
    const fixture = await createQualityFixture(['Q14@quality-v1'], new AbortController().signal);
    try {
      const root = fixture.roots.single;
      if (root === undefined) throw new Error('Q14 fixture root missing');
      const matches = await new LocalGrepEngine().search({
        query: 'return',
        cwd: root,
        glob: ['!*.py'],
      });

      expect(matches.map(({ filePath }) => filePath)).toEqual(['Q14/answer.ts']);
    } finally {
      await fixture.dispose();
    }
  });

  it('applies semantic-search exclusions instead of treating them as inclusions', async () => {
    const fixture = await createQualityFixture(['Q14@quality-v1'], new AbortController().signal);
    try {
      const task = fixture.oracleCases[0];
      const root = fixture.roots.single;
      if (task === undefined || root === undefined) throw new Error('Q14 fixture missing');
      const adapter = await createNexusAdapterForRoot(root);
      try {
        const observation = await adapter.invoke(
          'semantic_search',
          { query: 'answer', filePatterns: ['!*.py'] },
          new AbortController().signal,
          { traceSequence: 1 },
        );

      expect(observation.status).toBe('ok');
      expect(observation.results.every(({ filePath }) => !filePath.endsWith('.py'))).toBe(true);
      } finally {
        await adapter.close();
      }
    } finally {
      await fixture.dispose();
    }
  });
});
