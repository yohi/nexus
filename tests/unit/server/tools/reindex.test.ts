import { describe, expect, it, vi } from 'vitest';

import type { IIndexPipeline, ReindexOptions } from '../../../../src/types/index.js';
import { executeReindex } from '../../../../src/server/tools/reindex.js';
let lastFullRebuild: boolean | undefined;
let lastReason: ReindexOptions['reason'];

const pipeline = {
  reindex: async (
    _run: unknown,
    _load: unknown,
    fullRebuild?: boolean,
    reason?: ReindexOptions['reason'],
  ) => {
    lastFullRebuild = fullRebuild;
    lastReason = reason;
    return {
      startedAt: '2026-04-05T00:00:00.000Z',
      finishedAt: '2026-04-05T00:00:01.000Z',
      durationMs: 1000,
      reconciliation: { added: 1, modified: 0, deleted: 0, unchanged: 0 },
      chunksIndexed: 2,
    };
  },
  getSkippedFiles: () => new Map<string, string>(),
  getProgress: () => ({ totalFiles: 0, processedFiles: 0, status: 'idle' }),
  reconcileOnStartup: async () => ({ startedAt: '', finishedAt: '', durationMs: 0, reconciliation: { added: 0, modified: 0, deleted: 0, unchanged: 0 }, chunksIndexed: 0 }),
  start: () => undefined,
  stop: async () => {},
  waitForActiveReindex: async () => {},
} as IIndexPipeline;

describe('executeReindex', () => {
  it('delegates to the index pipeline reindex flow with fullRebuild flag', async () => {
    const result = await executeReindex(pipeline, async () => [], async () => '', { fullRebuild: true });

    expect(result).toMatchObject({
      reconciliation: { added: 1, modified: 0, deleted: 0, unchanged: 0 },
      chunksIndexed: 2,
    });
    expect(lastFullRebuild).toBe(true);
  });

  it('forwards the reindex reason to the index pipeline', async () => {
    await executeReindex(
      pipeline,
      async () => [],
      async () => '',
      { fullRebuild: true, reason: 'overflow-recovery' },
    );

    expect(lastReason).toBe('overflow-recovery');
  });

  it('hands confirmed corruption to a second reindex after the first mutex scope returns', async () => {
    const request = { rebuildEpoch: 7, fingerprint: 'integrity-proof' };
    const reindex = vi.fn()
      .mockResolvedValueOnce({ status: 'rebuild_required', request })
      .mockResolvedValueOnce({
        startedAt: '2026-04-05T00:00:00.000Z', finishedAt: '2026-04-05T00:00:01.000Z',
        durationMs: 1000, reconciliation: { added: 0, modified: 0, deleted: 0, unchanged: 1 }, chunksIndexed: 2,
      });
    const current = { ...pipeline, reindex } as IIndexPipeline;
    const runReindex = async () => [];
    const loadContent = async () => '';

    const result = await executeReindex(current, runReindex, loadContent, { fullRebuild: true });

    expect(reindex).toHaveBeenNthCalledWith(1, runReindex, loadContent, true, undefined);
    expect(reindex).toHaveBeenNthCalledWith(2, runReindex, loadContent, true, 'integrity-recovery', request);
    expect(result).toMatchObject({ reconciliation: { unchanged: 1 }, chunksIndexed: 2 });
  });
});
