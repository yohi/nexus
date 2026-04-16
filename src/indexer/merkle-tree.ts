import path from 'node:path';

import type { IMetadataStore, IndexEvent, MerkleNodeRow } from '../types/index.js';
import { computeStringHash } from './hash.js';

export interface RenameCandidate {
  oldPath: string;
  newPath: string;
  hash: string;
  oldEvent: IndexEvent;
  newEvent: IndexEvent;
}

/**
 * Memory-efficient MerkleTree implementation.
 * Instead of loading all nodes into memory, it persists directory hashes
 * and updates them incrementally from leaf to root.
 */
export class MerkleTree {
  // Simple LRU-like cache for nodes to reduce DB hits
  private readonly cache = new Map<string, MerkleNodeRow>();

  private rootHash: string | null = null;

  constructor(private readonly metadataStore: IMetadataStore) {}

  /**
   * Initializes the tree by loading the root hash if it exists.
   */
  async load(): Promise<void> {
    this.cache.clear();
    // We don't have a single "root" entry, but we can compute the root hash
    // by looking at top-level nodes (parentPath is null).
    this.rootHash = await this.computeRootHashFromStore();
  }

  async update(filePath: string, contentHash: string): Promise<void> {
    const parentPath = path.dirname(filePath) === '.' ? null : path.dirname(filePath);
    const fileNode: MerkleNodeRow = {
      path: filePath,
      hash: contentHash,
      parentPath,
      isDirectory: false,
    };

    // 1. Update the file node itself
    await this.metadataStore.bulkUpsertMerkleNodes([fileNode]);
    this.cache.set(filePath, fileNode);

    // 2. Recalculate hashes up to the root
    await this.bubbleUpHash(filePath);
  }

  async remove(filePath: string): Promise<void> {
    // 1. Remove the node
    await this.metadataStore.bulkDeleteMerkleNodes([filePath]);
    this.cache.delete(filePath);

    // 2. Prune empty directories and update hashes
    const parentPath = path.dirname(filePath) === '.' ? null : path.dirname(filePath);
    if (parentPath) {
      await this.pruneAndBubble(parentPath);
    } else {
      this.rootHash = await this.computeRootHashFromStore();
    }
  }

  async move(oldPath: string, newPath: string, contentHash: string): Promise<void> {
    // This is essentially a remove + update
    await this.remove(oldPath);
    await this.update(newPath, contentHash);
  }

  private async pruneAndBubble(dirPath: string): Promise<void> {
    let current: string | null = dirPath;
    while (current !== null && current !== '.' && current !== path.sep) {
      const hasChildren = await this.metadataStore.hasChildren(current);
      if (!hasChildren) {
        const parentOfCurrent = path.dirname(current) === '.' ? null : path.dirname(current);
        await this.metadataStore.bulkDeleteMerkleNodes([current]);
        this.cache.delete(current);
        current = parentOfCurrent;
      } else {
        await this.bubbleUpHash(current);
        break;
      }
    }
    
    // Always refresh root hash if we pruned up to the top
    if (current === null || current === '.' || current === path.sep) {
      this.rootHash = await this.computeRootHashFromStore();
    }
  }

  /**
   * Updates directory hashes from the given path up to the root.
   */
  private async bubbleUpHash(nodePath: string): Promise<void> {
    let current = path.dirname(nodePath);
    if (current === '.' || current === path.sep) {
      this.rootHash = await this.computeRootHashFromStore();
      return;
    }

    while (current !== '.' && current !== path.sep) {
      const children = await this.metadataStore.getChildren(current);
      const hash = await this.calculateDirectoryHash(children);
      
      const parentPath = path.dirname(current) === '.' ? null : path.dirname(current);
      const dirNode: MerkleNodeRow = {
        path: current,
        hash,
        parentPath,
        isDirectory: true,
      };

      await this.metadataStore.bulkUpsertMerkleNodes([dirNode]);
      this.cache.set(current, dirNode);

      current = parentPath ?? '.';
    }

    this.rootHash = await this.computeRootHashFromStore();
  }

  private async calculateDirectoryHash(children: MerkleNodeRow[]): Promise<string> {
    const sortedChildren = [...children].sort((a, b) => a.path.localeCompare(b.path));
    const childHashes = sortedChildren.map((child) => {
      return `${child.path.length}:${child.path}:${child.hash}`;
    });
    return computeStringHash(childHashes.join(''));
  }

  private async computeRootHashFromStore(): Promise<string | null> {
    // Top-level nodes are those where parentPath is null
    const roots = await this.metadataStore.getChildren(''); // SqliteMetadataStore implementation uses null check
    if (roots.length === 0) {
      return null;
    }

    const rootHashes = roots
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((node) => {
        return `${node.path.length}:${node.path}:${node.hash}`;
      });
    
    return computeStringHash(rootHashes.join(''));
  }

  getRootHash(): string | null {
    return this.rootHash;
  }

  async getNode(nodePath: string): Promise<MerkleNodeRow | undefined> {
    if (this.cache.has(nodePath)) {
      return this.cache.get(nodePath);
    }
    const node = await this.metadataStore.getMerkleNode(nodePath);
    if (node) {
      this.cache.set(nodePath, node);
    }
    return node ?? undefined;
  }

  /**
   * Detects rename candidates through matching deleted and added hashes.
   */
  static detectRenameCandidates(events: IndexEvent[]): RenameCandidate[] {
    const added = events.filter((event) => event.type === 'added' && event.contentHash !== undefined);
    const deleted = events.filter((event) => event.type === 'deleted' && event.contentHash !== undefined);
    const matches: RenameCandidate[] = [];

    const addedMap = new Map<string, IndexEvent[]>();
    for (const event of added) {
      if (event.contentHash !== undefined) {
        const list = addedMap.get(event.contentHash) ?? [];
        list.push(event);
        addedMap.set(event.contentHash, list);
      }
    }

    for (const removed of deleted) {
      if (removed.contentHash !== undefined) {
        const list = addedMap.get(removed.contentHash);
        if (list !== undefined && list.length > 0) {
          const addedMatch = list.shift()!;
          matches.push({
            oldPath: removed.filePath,
            newPath: addedMatch.filePath,
            hash: addedMatch.contentHash!,
            oldEvent: removed,
            newEvent: addedMatch,
          });
        }
      }
    }

    return matches;
  }

  /**
   * Note: The static diff method is now deprecated for large trees.
   * Real diffing should be done using database-backed comparison.
   */
  static async diff(): Promise<IndexEvent[]> {
    throw new Error('MerkleTree.diff() is deprecated. Use direct DB comparison.');
  }
}
