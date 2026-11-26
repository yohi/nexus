import { describe, expect, it } from 'vitest';
import { simpleGlobMatch } from '../../../../tests/benchmarks/quality/runner.js';

describe('simpleGlobMatch', () => {
  it('matches arbitrary characters for a star wildcard and treats dots literally', () => {
    expect(simpleGlobMatch('src/file.test.ts', 'src/*.ts')).toBe(true);
    expect(simpleGlobMatch('src/fileXts', 'src/*.ts')).toBe(false);
  });

  it('escapes other regular expression metacharacters in glob patterns', () => {
    expect(simpleGlobMatch('src/[file]+.ts', 'src/*[file]+.ts')).toBe(true);
    expect(simpleGlobMatch('src/file+.ts', 'src/*[file]+.ts')).toBe(false);
  });
});
