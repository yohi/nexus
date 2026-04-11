import { describe, it, expect, afterEach } from 'vitest';
// Spike 結果: パス (B) 確定 — mergeInsert は旧行を自動削除しない
// upsertChunks は delete-then-add パターンを使用する必要がある
import * as lancedb from '@lancedb/lancedb';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Spike: mergeInsert behavior verification', () => {
  let tmpDir: string;
  let db: lancedb.Connection;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('should clarify whether mergeInsert removes unmatched old rows', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'nexus-spike-'));
    db = await lancedb.connect(tmpDir);

    const initialData = [
      { id: 'file:1-10', filePath: 'src/file.ts', content: 'line1', vector: [1, 0, 0] },
      { id: 'file:11-20', filePath: 'src/file.ts', content: 'line2', vector: [0, 1, 0] },
    ];
    const table = await db.createTable('chunks', initialData);

    const newData = [
      { id: 'file:1-10', filePath: 'src/file.ts', content: 'updated-line1', vector: [1, 0, 0] },
      { id: 'file:21-30', filePath: 'src/file.ts', content: 'line3', vector: [0, 0, 1] },
    ];

    await table
      .mergeInsert('id')
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(newData);

    const allRows = await table.query().toArray();
    const allIds = allRows.map((row: Record<string, unknown>) => row['id']).sort();

    const oldRowExists = allIds.includes('file:11-20');
    console.log('--- Spike Result ---');
    console.log('All IDs after mergeInsert:', allIds);
    console.log('Old row (file:11-20) exists:', oldRowExists);

    if (oldRowExists) {
      console.log('=> Path (B): mergeInsert does NOT remove unmatched old rows');
      console.log('=> upsertChunks must use delete-then-add pattern');
      expect(allRows).toHaveLength(3);
      expect(allIds).toEqual(['file:1-10', 'file:11-20', 'file:21-30']);
    } else {
      console.log('=> Path (A): mergeInsert DOES remove unmatched old rows');
      console.log('=> upsertChunks can use mergeInsert as single operation');
      expect(allRows).toHaveLength(2);
      expect(allIds).toEqual(['file:1-10', 'file:21-30']);
    }
  });
});