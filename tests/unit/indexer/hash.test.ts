import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { computeFileHash, computeFileHashStreaming, computePartialHash } from '../../../src/indexer/hash.js';

describe('hash utilities', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-hash-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('computeFileHashStreaming matches computeFileHash', async () => {
    const filePath = path.join(tempDir, 'sample.ts');
    await writeFile(filePath, 'export const value = 42;\n'.repeat(32), 'utf8');

    const syncHash = await computeFileHash(filePath);
    const streamingHash = await computeFileHashStreaming(filePath);

    expect(streamingHash).toBe(syncHash);
  });

  it('computePartialHash is stable for files larger than 10MB', async () => {
    const filePath = path.join(tempDir, 'large.txt');
    await new Promise<void>((resolve, reject) => {
      const stream = createWriteStream(filePath, 'utf8');
      const chunk = 'abcdefghij'.repeat(1024);

      for (let index = 0; index < 1100; index += 1) {
        stream.write(chunk);
      }

      stream.end(() => resolve());
      stream.on('error', reject);
    });

    const partialHashA = await computePartialHash(filePath, 11 * 1024 * 1024);
    const partialHashB = await computePartialHash(filePath, 11 * 1024 * 1024);

    expect(partialHashA).toBe(partialHashB);
  });
});
