import { describe, expect, it } from 'vitest';

import { executeGetContext } from '../../../../src/server/tools/get-context.js';
import { PathSanitizer } from '../../../../src/server/path-sanitizer.js';

describe('executeGetContext', () => {
  it('returns the requested line slice from the file content', async () => {
    const sanitizer = await PathSanitizer.create(process.cwd());
    const result = await executeGetContext(
      async () => 'line1\nline2\nline3\nline4',
      sanitizer,
      {
        filePath: 'src/auth.ts',
        startLine: 2,
        endLine: 3,
      },
    );

    expect(result).toEqual({
      filePath: 'src/auth.ts',
      content: 'line2\nline3',
      startLine: 2,
      endLine: 3,
    });
  });
});
