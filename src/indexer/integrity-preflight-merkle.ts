import { dirname } from 'node:path';
import type { MerkleNodeRow } from '../types/index.js';
import { computeStringHash } from './hash.js';
import type { IntegrityPreparedFile } from './integrity-preflight-types.js';

export function merkleNodeKey(node: MerkleNodeRow): string {
  return JSON.stringify([node.path, node.hash, node.parentPath, node.isDirectory]);
}

export async function expectedMerkleNodes(files: readonly IntegrityPreparedFile[]): Promise<readonly MerkleNodeRow[]> {
  const nodes = new Map<string, MerkleNodeRow>();
  const directories = new Set<string>();
  for (const file of files) {
    const parentPath = dirname(file.event.filePath) === '.' ? null : dirname(file.event.filePath);
    nodes.set(file.event.filePath, {
      path: file.event.filePath, hash: file.merkleHash, parentPath, isDirectory: false,
    });
    let parent = parentPath;
    while (parent !== null && parent !== '.') {
      directories.add(parent);
      const next = dirname(parent);
      parent = next === '.' ? null : next;
    }
  }
  const orderedDirectories = [...directories].sort((left, right) =>
    right.split(/[\\/]/).length - left.split(/[\\/]/).length || right.localeCompare(left));
  for (const directory of orderedDirectories) {
    const children = [...nodes.values()].filter((node) => node.parentPath === directory)
      .sort((left, right) => left.path.localeCompare(right.path));
    const hashInput = children.map((node) => `${node.path.length}:${node.path}:${node.hash}`).join('');
    const parentPath = dirname(directory) === '.' ? null : dirname(directory);
    nodes.set(directory, {
      path: directory, hash: await computeStringHash(hashInput), parentPath, isDirectory: true,
    });
  }
  return [...nodes.values()].sort((left, right) => left.path.localeCompare(right.path));
}
