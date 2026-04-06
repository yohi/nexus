import { describe, expect, it } from 'vitest';

import { executeReindex } from '../../../../src/server/tools/reindex.js';

let lastFullRebuild: boolean | undefined;

const pipeline = {
  reindex: async (_run: unknown, _load: unknown, fullRebuild?: boolean) => {
    lastFullRebuild = fullRebuild;
    return {
      startedAt: '2026-04-05T00:00:00.000Z',
      finishedAt: '2026-04-05T00:00:01.000Z',
      durationMs: 1000,
      reconciliation: { added: 1, modified: 0, deleted: 0, unchanged: 0 },
      chunksIndexed: 2,
    };
  },
  getSkippedFiles: () => new Map<string, string>(),
  reconcileOnStartup: async () => ({ startedAt: '', finishedAt: '', durationMs: 0, reconciliation: { added: 0, modified: 0, deleted: 0, unchanged: 0 }, chunksIndexed: 0 }),
};

describe('executeReindex', () => {
  it('delegates to the index pipeline reindex flow with fullRebuild flag', async () => {
    const result = await executeReindex(pipeline, async () => [], async () => '', { fullRebuild: true });

    expect(result).toMatchObject({
      reconciliation: { added: 1, modified: 0, deleted: 0, unchanged: 0 },
      chunksIndexed: 2,
    });
    expect(lastFullRebuild).toBe(true);
  });
});
