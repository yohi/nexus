import { join, parse } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectExpectedDirectoryPaths, expectedMerkleNodes } from '../../../src/indexer/integrity-preflight-merkle.js';
import { computeStringHash } from '../../../src/indexer/hash.js';
import type { IntegrityPreparedFile } from '../../../src/indexer/integrity-preflight-types.js';

describe('integrity preflight Merkle directory paths', () => {
  it('terminates at the filesystem root for an absolute file path', () => {
    const root = parse(process.cwd()).root;
    const parentDirectory = join(root, 'a');
    const filePath = join(parentDirectory, 'b.ts');

    expect(collectExpectedDirectoryPaths([filePath])).toEqual(new Set([parentDirectory]));
  });

  it('builds directory hashes for nested sibling paths using their direct children', async () => {
    const files = [
      preparedFile('packages/pkg/src/a.ts', 'hash-a'),
      preparedFile('packages/pkg/src/b.ts', 'hash-b'),
      preparedFile('packages/pkg/test/c.ts', 'hash-c'),
    ];
    const nodes = await expectedMerkleNodes(files);
    const srcHash = await computeStringHash([
      'packages/pkg/src/a.ts', 'packages/pkg/src/b.ts',
    ].map((path, index) => `${path.length}:${path}:${index === 0 ? 'hash-a' : 'hash-b'}`).join(''));
    const testHash = await computeStringHash(
      `${'packages/pkg/test/c.ts'.length}:packages/pkg/test/c.ts:hash-c`,
    );
    const pkgChildren = ['packages/pkg/src', 'packages/pkg/test'].sort((left, right) => left.localeCompare(right));
    const pkgHash = await computeStringHash(pkgChildren.map((path) => {
      const hash = path.endsWith('/src') ? srcHash : testHash;
      return `${path.length}:${path}:${hash}`;
    }).join(''));

    expect(nodes.find((node) => node.path === 'packages/pkg')?.hash).toBe(pkgHash);
    expect(nodes.map((node) => node.path)).toEqual(nodes.map((node) => node.path).toSorted());
  });
});

function preparedFile(filePath: string, merkleHash: string): IntegrityPreparedFile {
  return {
    event: { type: 'added', filePath, detectedAt: '2026-01-01T00:00:00.000Z' },
    sourceHash: merkleHash,
    merkleHash,
    chunks: [],
    structured: undefined,
    structuredRetirement: false,
    structuredParseFailed: false,
    skipped: false,
  };
}
