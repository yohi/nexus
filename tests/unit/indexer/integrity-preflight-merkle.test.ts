import { join, parse } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectExpectedDirectoryPaths } from '../../../src/indexer/integrity-preflight-merkle.js';

describe('integrity preflight Merkle directory paths', () => {
  it('terminates at the filesystem root for an absolute file path', () => {
    const root = parse(process.cwd()).root;
    const parentDirectory = join(root, 'a');
    const filePath = join(parentDirectory, 'b.ts');

    expect(collectExpectedDirectoryPaths([filePath])).toEqual(new Set([parentDirectory]));
  });
});
