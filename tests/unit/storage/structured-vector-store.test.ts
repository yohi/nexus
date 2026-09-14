import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
});
