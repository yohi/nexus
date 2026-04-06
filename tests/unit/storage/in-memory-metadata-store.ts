import type { DeadLetterEntry, IMetadataStore, IndexStatsRow, MerkleNodeRow } from '../../../src/types/index.js';

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

  async renamePath(oldPath: string, newPath: string, hash: string): Promise<void> {
    this.nodes.delete(oldPath);
    this.nodes.set(newPath, {
      path: newPath,
      hash,
      parentPath: newPath.includes('/') ? newPath.split('/').slice(0, -1).join('/') : null,
      isDirectory: false,
    });
  }

  async getMerkleNode(path: string): Promise<MerkleNodeRow | null> {
    return this.nodes.get(path) ?? null;
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
