import path from 'node:path';

import type { IMetadataStore, IndexEvent, MerkleNodeRow } from '../types/index.js';

export interface RenameCandidate {
  oldPath: string;
  newPath: string;
  hash: string;
}

export class MerkleTree {
  private readonly nodes = new Map<string, MerkleNodeRow>();

  private rootHash: string | null = null;

  constructor(private readonly metadataStore: IMetadataStore) {}

  async load(): Promise<void> {
    this.nodes.clear();

    for (const node of await this.metadataStore.getAllFileNodes()) {
      this.nodes.set(node.path, node);
    }

    const allPaths = await this.metadataStore.getAllPaths();
    for (const nodePath of allPaths) {
      if (!this.nodes.has(nodePath)) {
        const node = await this.metadataStore.getMerkleNode(nodePath);
        if (node !== null) {
          this.nodes.set(node.path, node);
        }
      }
    }

    this.rootHash = this.computeRootHash();
  }

  async update(filePath: string, contentHash: string): Promise<void> {
    const directories = this.collectDirectories(filePath);
    const fileNode: MerkleNodeRow = {
      path: filePath,
      hash: contentHash,
      parentPath: path.dirname(filePath) === '.' ? null : path.dirname(filePath),
      isDirectory: false,
    };

    this.nodes.set(filePath, fileNode);
    for (const directory of directories) {
      this.nodes.set(directory.path, directory);
    }

    this.rootHash = this.computeRootHash();
    await this.persistCurrentState();
  }

  async remove(filePath: string): Promise<void> {
    this.nodes.delete(filePath);
    this.rootHash = this.computeRootHash();
    await this.persistCurrentState();
  }

  getRootHash(): string | null {
    return this.rootHash;
  }

  getNode(nodePath: string): MerkleNodeRow | undefined {
    return this.nodes.get(nodePath);
  }

  static async diff(oldTree: MerkleTree, newTree: MerkleTree): Promise<IndexEvent[]> {
    await Promise.resolve();
    const events: IndexEvent[] = [];
    const seen = new Set<string>();
    const now = new Date().toISOString();

    for (const [nodePath, newNode] of [...newTree.nodes.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      if (newNode.isDirectory) {
        continue;
      }

      seen.add(nodePath);
      const oldNode = oldTree.nodes.get(nodePath);

      if (oldNode === undefined) {
        events.push({ type: 'added', filePath: nodePath, contentHash: newNode.hash, detectedAt: now });
      } else if (oldNode.hash !== newNode.hash) {
        events.push({ type: 'modified', filePath: nodePath, contentHash: newNode.hash, detectedAt: now });
      }
    }

    for (const [nodePath, oldNode] of [...oldTree.nodes.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      if (oldNode.isDirectory || seen.has(nodePath)) {
        continue;
      }

      events.push({ type: 'deleted', filePath: nodePath, contentHash: oldNode.hash, detectedAt: now });
    }

    return events;
  }

  static detectRenameCandidates(events: IndexEvent[]): RenameCandidate[] {
    const added = events.filter((event) => event.type === 'added' && event.contentHash !== undefined);
    const deleted = events.filter((event) => event.type === 'deleted' && event.contentHash !== undefined);
    const matches: RenameCandidate[] = [];

    for (const removed of deleted) {
      const addedMatch = added.find((event) => event.contentHash === removed.contentHash);
      if (addedMatch?.contentHash !== undefined && removed.contentHash !== undefined) {
        matches.push({
          oldPath: removed.filePath,
          newPath: addedMatch.filePath,
          hash: addedMatch.contentHash,
        });
      }
    }

    return matches;
  }

  private async persistCurrentState(): Promise<void> {
    const persistedPaths = new Set(await this.metadataStore.getAllPaths());
    const currentPaths = new Set(this.nodes.keys());

    const deletedPaths = [...persistedPaths].filter((nodePath) => !currentPaths.has(nodePath));
    if (deletedPaths.length > 0) {
      await this.metadataStore.bulkDeleteMerkleNodes(deletedPaths);
    }

    await this.metadataStore.bulkUpsertMerkleNodes([...this.nodes.values()]);
  }

  private collectDirectories(filePath: string): MerkleNodeRow[] {
    const directories: MerkleNodeRow[] = [];
    let current = path.dirname(filePath);

    while (current !== '.' && current !== path.sep) {
      directories.push({
        path: current,
        hash: '',
        parentPath: path.dirname(current) === '.' ? null : path.dirname(current),
        isDirectory: true,
      });
      current = path.dirname(current);
    }

    return directories;
  }

  private computeRootHash(): string | null {
    const childMap = new Map<string | null, MerkleNodeRow[]>();

    for (const node of this.nodes.values()) {
      const key = node.parentPath;
      const entries = childMap.get(key) ?? [];
      entries.push(node);
      childMap.set(key, entries);
    }

    const computeNodeHash = (nodePath: string): string => {
      const node = this.nodes.get(nodePath);
      if (node === undefined) {
        return '';
      }

      if (!node.isDirectory) {
        return node.hash;
      }

      const children = (childMap.get(nodePath) ?? []).sort((left, right) => left.path.localeCompare(right.path));
      return children.map((child) => `${child.path}:${computeNodeHash(child.path)}`).join('|');
    };

    const roots = (childMap.get(null) ?? []).sort((left, right) => left.path.localeCompare(right.path));
    if (roots.length === 0) {
      return null;
    }

    return roots.map((node) => `${node.path}:${computeNodeHash(node.path)}`).join('|');
  }
}
