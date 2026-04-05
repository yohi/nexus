import { describe, expect, it } from 'vitest';

import { executeGetContext } from '../../../../src/server/tools/get-context.js';

describe('executeGetContext', () => {
  it('returns the requested line slice from the file content', async () => {
    const result = await executeGetContext(
      async () => 'line1\nline2\nline3\nline4',
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
