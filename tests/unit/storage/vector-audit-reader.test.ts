import type { Table } from '@lancedb/lancedb';
import { describe, expect, it, vi } from 'vitest';
import { iteratePhysicalVectorRows } from '../../../src/storage/vector-audit-reader.js';

describe('physical vector audit snapshot', () => {
  it('detects an external table update by refreshing to the latest version after iteration', async () => {
    let latestVersion = 1;
    let checkedOutVersion = 0;
    let hasIterated = false;
    const query = {
      select: vi.fn(() => query),
      where: vi.fn(() => query),
      limit: vi.fn(() => query),
      offset: vi.fn(() => query),
      toArray: vi.fn(async () => {
        if (!hasIterated) {
          hasIterated = true;
          latestVersion += 1;
        }
        return [];
      }),
    };
    const table = {
      checkoutLatest: vi.fn(async () => { checkedOutVersion = latestVersion; }),
      version: vi.fn(async () => checkedOutVersion),
      schema: vi.fn(async () => ({ fields: [] })),
      query: vi.fn(() => query),
    } as unknown as Table;
    const read = async <T>(operation: () => Promise<T>): Promise<T> => await operation();
    const consume = async (): Promise<void> => {
      for await (const _row of iteratePhysicalVectorRows(
        { legacy: table }, { pageSize: 8, signal: new AbortController().signal }, read,
      )) {
        void _row;
      }
    };

    await expect(consume()).rejects.toThrow('audit_snapshot_changed');
    expect(table.checkoutLatest).toHaveBeenCalledTimes(2);
  });
});
