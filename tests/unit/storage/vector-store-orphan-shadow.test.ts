import * as lancedb from '@lancedb/lancedb';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LanceVectorStore } from '../../../src/storage/vector-store.js';

describe('LanceVectorStore - orphan shadow cleanup on initialize', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(tmpdir(), `nexus-test-orphan-${randomUUID()}`);
  });

  afterEach(async () => {
    try {
      await rm(dbPath, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('drops leftover chunks_shadow_* and structured_chunks_shadow_* tables on initialize', async () => {
    const previous = new LanceVectorStore({ dbPath, dimensions: 3 });
    await previous.initialize();
    await previous.beginLegacyShadowTable();
    await previous.beginStructuredShadowTable();
    await previous.close();

    const namesBefore = await (await lancedb.connect(dbPath)).tableNames();
    expect(namesBefore.some((name) => name.startsWith('chunks_shadow_'))).toBe(true);
    expect(namesBefore.some((name) => name.startsWith('structured_chunks_shadow_'))).toBe(true);

    const next = new LanceVectorStore({ dbPath, dimensions: 3 });
    await next.initialize();
    await next.close();

    const namesAfter = await (await lancedb.connect(dbPath)).tableNames();
    expect(namesAfter.some((name) => name.startsWith('chunks_shadow_'))).toBe(false);
    expect(namesAfter.some((name) => name.startsWith('structured_chunks_shadow_'))).toBe(false);
  });
});
