import type { IMetadataStore, IndexStatsRow, MerkleNodeRow } from '../../../src/types/index.js';

export class InMemoryMetadataStore implements IMetadataStore {
  private readonly nodes = new Map<string, MerkleNodeRow>();

  private stats: IndexStatsRow | null = null;

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

  async getMerkleNode(path: string): Promise<MerkleNodeRow | null> {
    return this.nodes.get(path) ?? null;
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
}
