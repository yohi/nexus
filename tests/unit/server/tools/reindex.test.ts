import { describe, expect, it } from 'vitest';

import { executeReindex } from '../../../../src/server/tools/reindex.js';

const pipeline = {
  reindex: async () => ({
    startedAt: '2026-04-05T00:00:00.000Z',
    finishedAt: '2026-04-05T00:00:01.000Z',
    durationMs: 1000,
    reconciliation: { added: 1, modified: 0, deleted: 0, unchanged: 0 },
    chunksIndexed: 2,
  }),
};

describe('executeReindex', () => {
  it('delegates to the index pipeline reindex flow', async () => {
    const result = await executeReindex(pipeline as never, async () => [], async () => '', { fullRebuild: true });

    expect(result).toMatchObject({
      reconciliation: { added: 1, modified: 0, deleted: 0, unchanged: 0 },
      chunksIndexed: 2,
    });
  });
});
