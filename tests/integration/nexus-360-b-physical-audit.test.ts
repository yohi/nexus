import * as lancedb from '@lancedb/lancedb';
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LanceVectorStore } from '../../src/storage/vector-store.js';

describe('Nexus #360 fresh physical vector snapshot', () => {
  let directory: string | undefined;
  let store: LanceVectorStore | undefined;

  afterEach(async () => {
    await store?.close();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
  });

  it('reads rows added after the store opened its cached Table handle', async () => {
    directory = await mkdtemp(join(tmpdir(), 'nexus-360-physical-audit-'));
    const writer = await lancedb.connect(directory);
    const writerTable = await writer.createTable('chunks', [{
      id: 'first', filepath: 'a.ts', content: 'a', language: 'typescript', symbolname: '',
      symbolkind: 'function', startline: 1, endline: 1, hash: 'hash-a', vector: [0.25, 0.75],
    }]);
    store = new LanceVectorStore({ dbPath: directory, dimensions: 2 });
    await store.initialize();

    await writerTable.add([{
      id: 'second', filepath: 'b.ts', content: 'b', language: 'typescript', symbolname: '',
      symbolkind: 'function', startline: 1, endline: 1, hash: 'hash-b', vector: [0.5, 0.5],
    }]);

    const rows = [];
    for await (const row of store.iteratePhysicalRows({ pageSize: 1, signal: new AbortController().signal })) {
      rows.push(row);
    }

    expect(rows.map((row) => row.id).sort()).toEqual(['first', 'second']);
    expect(rows.find((row) => row.id === 'second')?.vector).toEqual([0.5, 0.5]);
    writerTable.close();
    writer.close();
  });

  it('returns pending structured rows and their exact vector values', async () => {
    directory = await mkdtemp(join(tmpdir(), 'nexus-360-pending-audit-'));
    store = new LanceVectorStore({ dbPath: directory, dimensions: 2 });
    await store.initialize();
    const chunk = {
      id: 'pending', filePath: 'pending.ts', content: 'pending', language: 'typescript',
      symbolKind: 'function' as const, startLine: 1, endLine: 1, hash: 'content-hash',
      symbolId: 'symbol-id', generationId: 'generation-id',
    };
    await store.stageGenerationChunks({
      filePath: chunk.filePath, generationId: 'generation-id', chunks: [chunk], vectors: [[0.125, 0.875]],
    });

    const rows = [];
    for await (const row of store.iteratePhysicalRows({ pageSize: 1, signal: new AbortController().signal })) {
      rows.push(row);
    }

    expect(rows).toEqual([expect.objectContaining({
      view: 'structured', id: 'pending', generationId: 'generation-id',
      visibility: 'pending', vector: [0.125, 0.875],
    })]);
  });
});
