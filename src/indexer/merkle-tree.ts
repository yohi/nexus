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
  // Simple FIFO cache for nodes to reduce DB hits
  private readonly cache = new Map<string, MerkleNodeRow>();
  private readonly maxCacheSize: number;

  private rootHash: string | null = null;

  // Cache metrics
  public cacheHits = 0;
  public cacheMisses = 0;
  public cacheEvictions = 0;

  constructor(
    private readonly metadataStore: IMetadataStore,
    options?: { maxCacheSize?: number },
  ) {
    this.maxCacheSize = options?.maxCacheSize ?? 10000;
  }

  private addToCache(path: string, node: MerkleNodeRow): void {
    if (this.cache.size >= this.maxCacheSize && !this.cache.has(path)) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
        this.cacheEvictions += 1;
      }
    }
    this.cache.set(path, node);
  }

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
    this.addToCache(filePath, fileNode);

    // 2. Recalculate hashes up to the root
    if (parentPath) {
      await this.bubbleUpHash(parentPath);
    } else {
      this.rootHash = await this.computeRootHashFromStore();
    }
  }

  async remove(filePath: string): Promise<void> {
    const node = await this.getNode(filePath);

    // 1. Remove the node or subtree
    if (node?.isDirectory) {
      const subtreePaths = await this.metadataStore.getSubtreePaths(filePath);
      await this.metadataStore.deleteSubtree(filePath);
      for (const p of subtreePaths) {
        this.cache.delete(p);
      }
    } else {
      await this.metadataStore.bulkDeleteMerkleNodes([filePath]);
      this.cache.delete(filePath);
    }

    // 2. Prune empty directories and update hashes
    const parentPath = path.dirname(filePath) === '.' ? null : path.dirname(filePath);
    if (parentPath) {
      await this.pruneAndBubble(parentPath);
    } else {
      this.rootHash = await this.computeRootHashFromStore();
    }
  }

  async move(oldPath: string, newPath: string, contentHash: string): Promise<void> {
    // Atomic rename in metadata store
    await this.metadataStore.renamePath(oldPath, newPath, contentHash);

    // Update local cache
    this.cache.delete(oldPath);
    const parentPath = path.dirname(newPath) === '.' ? null : path.dirname(newPath);
    this.addToCache(newPath, {
      path: newPath,
      hash: contentHash,
      parentPath,
      isDirectory: false,
    });

    // Bubble up hashes for both old and new paths
    const oldParentPath = path.dirname(oldPath) === '.' ? null : path.dirname(oldPath);
    if (oldParentPath) {
      await this.pruneAndBubble(oldParentPath);
    }
    if (parentPath) {
      await this.bubbleUpHash(parentPath);
    } else {
      this.rootHash = await this.computeRootHashFromStore();
    }
  }

  private async pruneAndBubble(dirPath: string): Promise<void> {
    let current: string | null = dirPath;
    while (current !== null && current !== '.' && current !== path.sep) {
      const hasChildren = await this.metadataStore.hasChildren(current);
      if (!hasChildren) {
        const parentOfCurrent: string | null = path.dirname(current) === '.' ? null : path.dirname(current);
        await this.metadataStore.bulkDeleteMerkleNodes([current]);
        this.cache.delete(current);
        current = parentOfCurrent;
      } else {
        await this.bubbleUpHash(current);
        return;
      }
    }
    
    // Always refresh root hash if we pruned up to the top
    this.rootHash = await this.computeRootHashFromStore();
  }

  /**
   * Updates directory hashes from the given path up to the root.
   */
  private async bubbleUpHash(startDirPath: string): Promise<void> {
    let current: string | null = startDirPath;
    const visited = new Set<string>();
    const nodesToUpsert: MerkleNodeRow[] = [];

    while (current !== null && current !== '.' && current !== path.sep) {
      if (visited.has(current)) {
        break; // Prevent infinite loops
      }
      visited.add(current);

      const children: MerkleNodeRow[] = await this.metadataStore.getChildren(current);
      const hash = await this.calculateDirectoryHash(children);
      
      const parentPath: string | null = path.dirname(current) === '.' ? null : path.dirname(current);
      const dirNode: MerkleNodeRow = {
        path: current,
        hash,
        parentPath,
        isDirectory: true,
      };

      nodesToUpsert.push(dirNode);
      this.addToCache(current, dirNode);

      // Important: prevent getting stuck if dirname doesn't change anything
      if (parentPath === current) break;
      current = parentPath;
    }

    if (nodesToUpsert.length > 0) {
      await this.metadataStore.bulkUpsertMerkleNodes(nodesToUpsert);
    }

    this.rootHash = await this.computeRootHashFromStore();
  }

  private async calculateDirectoryHash(children: MerkleNodeRow[]): Promise<string> {
    const childHashes = children.map((child) => {
      return `${child.path.length}:${child.path}:${child.hash}`;
    });
    return computeStringHash(childHashes.join(''));
  }

  private async computeRootHashFromStore(): Promise<string | null> {
    // Top-level nodes are those where parentPath is null
    const roots = await this.metadataStore.getChildren(null);
    if (roots.length === 0) {
      return null;
    }

    const rootHashes = roots.map((node) => {
      return `${node.path.length}:${node.path}:${node.hash}`;
    });
    
    return computeStringHash(rootHashes.join(''));
  }

  getRootHash(): string | null {
    return this.rootHash;
  }

  async getNode(nodePath: string): Promise<MerkleNodeRow | undefined> {
    if (this.cache.has(nodePath)) {
      this.cacheHits += 1;
      return this.cache.get(nodePath);
    }
    this.cacheMisses += 1;
    const node = await this.metadataStore.getMerkleNode(nodePath);
    if (node) {
      this.addToCache(nodePath, node);
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
  static diff(): Promise<IndexEvent[]> {
    return Promise.reject(new Error('MerkleTree.diff() is deprecated. Use direct DB comparison.'));
  }
}
