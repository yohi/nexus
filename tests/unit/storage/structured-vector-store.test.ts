import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as lancedb from '@lancedb/lancedb';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LanceVectorStore } from '../../../src/storage/vector-store.js';
import type { CodeChunk } from '../../../src/types/index.js';

const legacyChunk: CodeChunk = {
  id: 'legacy',
  filePath: 'src/legacy.ts',
  content: 'export const value = 1;',
  language: 'typescript',
  symbolKind: 'function',
  startLine: 1,
  endLine: 1,
  hash: 'hash-1',
};

describe('LanceVectorStore structured rows', () => {
  let tmpDir: string;
  let store: LanceVectorStore;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'nexus-lance-structured-'));
    store = new LanceVectorStore({ dbPath: tmpDir, dimensions: 64 });
    await store.initialize();
  });

  afterEach(async () => {
    try {
      await store.close();
    } catch {}
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it('does not add structured columns to the legacy chunks table', async () => {
    await store.upsertChunks([legacyChunk]);

    const schema = await store['table']!.schema();
    const columnNames = schema.fields.map((f) => f.name);
    expect(columnNames).not.toContain('symbolid');
    expect(columnNames).not.toContain('generationid');
    expect(columnNames).not.toContain('visibility');
  });

  it('creates legacy shadow tables with the optional generationid column', async () => {
    const shadow = await store.beginLegacyShadowTable();
    const shadowTable = store['legacyShadowTable'];
    if (shadowTable === undefined) {
      throw new Error('legacy shadow table was not created');
    }

    const columnNames = (await shadowTable.schema()).fields.map((field) => field.name);
    expect(columnNames).toContain('generationid');
    await store.abortLegacyShadowTable(shadow);
  });

  it('removes all orphaned rebuild tables while retaining live tables on initialize', async () => {
    const db = await lancedb.connect(tmpDir);
    const row = {
      vector: Array(64).fill(0),
      id: 'row',
      filepath: 'src/a.ts',
      content: 'content',
      language: 'typescript',
      symbolname: 'a',
      symbolkind: 'function',
      startline: 1,
      endline: 1,
      hash: 'hash',
      generationid: 'g1',
    };
    await db.createTable('chunks', [row]);
    await db.createTable('structured_chunks', [row]);
    for (const name of [
      'chunks_shadow_orphan',
      'chunks_replacement_orphan',
      'chunks_backup_orphan',
      'structured_chunks_shadow_orphan',
      'structured_chunks_replacement_orphan',
      'structured_chunks_backup_orphan',
    ]) {
      await db.createTable(name, [row]);
    }
    await store.close();

    const restarted = new LanceVectorStore({ dbPath: tmpDir, dimensions: 64 });
    await restarted.initialize();
    const names = await (await lancedb.connect(tmpDir)).tableNames();

    expect(names).toContain('chunks');
    expect(names).toContain('structured_chunks');
    expect(names.filter((name) => name.includes('orphan'))).toEqual([]);
    await restarted.close();
  });
});
