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

export class MerkleTree {
  private readonly nodes = new Map<string, MerkleNodeRow>();

  private rootHash: string | null = null;

  constructor(private readonly metadataStore: IMetadataStore) {}

  async load(): Promise<void> {
    this.nodes.clear();

    for (const node of await this.metadataStore.getAllNodes()) {
      this.nodes.set(node.path, node);
    }

    this.rootHash = await this.computeRootHash();
  }

  async update(filePath: string, contentHash: string, skipPersist = false): Promise<void> {
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

    this.rootHash = await this.computeRootHash();
    if (!skipPersist) {
      await this.persistCurrentState();
    }
  }

  async remove(filePath: string, skipPersist = false): Promise<void> {
    const node = this.nodes.get(filePath);
    if (node?.isDirectory) {
      const prefix = filePath.endsWith(path.sep) ? filePath : filePath + path.sep;
      for (const nodePath of this.nodes.keys()) {
        if (nodePath.startsWith(prefix)) {
          this.nodes.delete(nodePath);
        }
      }
    }

    this.nodes.delete(filePath);
    this.pruneEmptyDirectories(path.dirname(filePath));

    this.rootHash = await this.computeRootHash();
    if (!skipPersist) {
      if (node?.isDirectory) {
        await this.metadataStore.bulkDeleteSubtrees([filePath]);
      }
      await this.persistCurrentState();
    }
  }

  async move(oldPath: string, newPath: string, contentHash: string): Promise<void> {
    const node = this.nodes.get(oldPath);
    const isDirectory = node?.isDirectory ?? false;

    // 1. Update in-memory state
    this.nodes.delete(oldPath);
    this.pruneEmptyDirectories(path.dirname(oldPath));

    const directories = this.collectDirectories(newPath);
    const newNode: MerkleNodeRow = {
      path: newPath,
      hash: contentHash,
      parentPath: path.dirname(newPath) === '.' ? null : path.dirname(newPath),
      isDirectory,
    };

    this.nodes.set(newPath, newNode);
    for (const directory of directories) {
      if (!this.nodes.has(directory.path)) {
        this.nodes.set(directory.path, directory);
      }
    }

    // 2. Perform atomic rename in metadata store
    await this.metadataStore.renamePath(oldPath, newPath, contentHash);

    // 3. Recompute and sync remaining state (e.g. newly created parent directories)
    this.rootHash = await this.computeRootHash();
    await this.persistCurrentState();
  }

  private pruneEmptyDirectories(dirPath: string): void {
    let current = dirPath;
    while (current !== '.' && current !== path.sep) {
      const parentNode = this.nodes.get(current);
      if (parentNode !== undefined && parentNode.isDirectory) {
        let hasChildren = false;
        for (const node of this.nodes.values()) {
          if (node.parentPath === current) {
            hasChildren = true;
            break;
          }
        }
        if (!hasChildren) {
          this.nodes.delete(current);
        } else {
          break;
        }
      } else {
        break;
      }
      current = path.dirname(current);
    }
  }

  getRootHash(): string | null {
    return this.rootHash;
  }

  getNode(nodePath: string): MerkleNodeRow | undefined {
    return this.nodes.get(nodePath);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  static async diff(oldTree: MerkleTree, newTree: MerkleTree): Promise<IndexEvent[]> {
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

    // Note: In cases where multiple files share the exact same content hash,
    // this mapping makes a best-effort 1:1 match. While this is sufficient for v1,
    // it may produce semantically arbitrary mappings among identical files.
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

  private async computeRootHash(): Promise<string | null> {
    const childMap = new Map<string | null, MerkleNodeRow[]>();

    for (const node of this.nodes.values()) {
      const key = node.parentPath;
      const entries = childMap.get(key) ?? [];
      entries.push(node);
      childMap.set(key, entries);
    }

    const computeNodeHash = async (nodePath: string): Promise<string> => {
      const node = this.nodes.get(nodePath);
      if (node === undefined) {
        return '';
      }

      if (!node.isDirectory) {
        return node.hash;
      }

      const children = (childMap.get(nodePath) ?? []).sort((left, right) => left.path.localeCompare(right.path));
      const childHashes = await Promise.all(
        children.map(async (child) => {
          const hash = await computeNodeHash(child.path);
          return `${child.path.length}:${child.path}:${hash}`;
        })
      );
      const serialized = childHashes.join('');
      return computeStringHash(serialized);
    };

    const roots = (childMap.get(null) ?? []).sort((left, right) => left.path.localeCompare(right.path));
    if (roots.length === 0) {
      return null;
    }

    const rootHashes = await Promise.all(
      roots.map(async (node) => {
        const hash = await computeNodeHash(node.path);
        return `${node.path.length}:${node.path}:${hash}`;
      })
    );
    const rootSerialized = rootHashes.join('');
    return computeStringHash(rootSerialized);
  }
}
