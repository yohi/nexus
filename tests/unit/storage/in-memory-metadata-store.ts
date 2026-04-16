import { dirname } from 'node:path';

import type {
  DeadLetterEntry,
  IMetadataStore,
  IndexStatsRow,
  MerkleNodeRow,
} from '../../../src/types/index.js';

export class InMemoryMetadataStore implements IMetadataStore {
  private readonly nodes = new Map<string, MerkleNodeRow>();

  private stats: IndexStatsRow | null = null;

  private readonly deadLetterEntries = new Map<string, DeadLetterEntry>();

  async initialize(): Promise<void> {
    return;
  }

  async bulkUpsertMerkleNodes(nodes: MerkleNodeRow[]): Promise<void> {
    for (const node of nodes) {
      this.nodes.set(node.path, node);
    }
  }

  async bulkDeleteMerkleNodes(paths: string[]): Promise<void> {
    for (const targetPath of paths) {
      this.nodes.delete(targetPath);
    }
  }

  async bulkDeleteSubtrees(paths: string[]): Promise<number> {
    let totalDeleted = 0;
    for (const pathPrefix of paths) {
      totalDeleted += await this.deleteSubtree(pathPrefix);
    }
    return totalDeleted;
  }

  async deleteSubtree(pathPrefix: string): Promise<number> {
    const normalizedPrefix = `${pathPrefix}/`;
    let deleted = 0;

    for (const key of [...this.nodes.keys()]) {
      if (key === pathPrefix || key.startsWith(normalizedPrefix)) {
        this.nodes.delete(key);
        deleted += 1;
      }
    }

    return deleted;
  }


  async pruneEmptyParents(
    path: string,
    pathExists: (targetPath: string) => Promise<boolean>,
  ): Promise<void> {
    let currentPath = dirname(path);

    while (currentPath !== '.' && currentPath !== '/' && currentPath !== '') {
      const hasChildren = await this.hasChildren(currentPath);
      if (!hasChildren) {
        if (await pathExists(currentPath)) {
          break;
        }
        this.nodes.delete(currentPath);
        currentPath = dirname(currentPath);
      } else {
        break;
      }
    }
  }

  async renamePath(oldPath: string, newPath: string, hash: string): Promise<void> {
    const oldNode = this.nodes.get(oldPath);
    const isDirectory = oldNode?.isDirectory ?? false;

    const parentPath = dirname(newPath);
    const normalizedParentPath = (parentPath === '.' || parentPath === '/' || parentPath === '') ? null : parentPath;

    this.nodes.delete(oldPath);
    this.nodes.set(newPath, {
      path: newPath,
      hash,
      parentPath: normalizedParentPath,
      isDirectory,
    });
  }


  async getMerkleNode(path: string): Promise<MerkleNodeRow | null> {
    return this.nodes.get(path) ?? null;
  }

  async getChildren(path: string | null): Promise<MerkleNodeRow[]> {
    return [...this.nodes.values()]
      .filter((node) => node.parentPath === path)
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  async hasChildren(path: string | null): Promise<boolean> {
    for (const node of this.nodes.values()) {
      if (node.parentPath === path) {
        return true;
      }
    }
    return false;
  }

  async getAllNodes(): Promise<MerkleNodeRow[]> {
    return [...this.nodes.values()].sort((left, right) => left.path.localeCompare(right.path));
  }

  async getAllFileNodes(): Promise<MerkleNodeRow[]> {
    return [...this.nodes.values()]
      .filter((node) => !node.isDirectory)
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  async getAllPaths(): Promise<string[]> {
    return [...this.nodes.keys()].sort((left, right) => left.localeCompare(right));
  }

  async getIndexStats(): Promise<IndexStatsRow | null> {
    return this.stats;
  }

  async setIndexStats(stats: IndexStatsRow): Promise<void> {
    this.stats = stats;
  }

  async upsertDeadLetterEntries(entries: DeadLetterEntry[]): Promise<void> {
    for (const entry of entries) {
      this.deadLetterEntries.set(entry.id, entry);
    }
  }

  async removeDeadLetterEntries(ids: string[]): Promise<void> {
    for (const id of ids) {
      this.deadLetterEntries.delete(id);
    }
  }

  async getDeadLetterEntries(): Promise<DeadLetterEntry[]> {
    return [...this.deadLetterEntries.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
}
