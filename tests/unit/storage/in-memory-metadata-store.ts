import { dirname } from 'node:path';

import type {
  DeadLetterEntry,
  EmbeddingCacheEntry,
  IMetadataStore,
  IndexStatsRow,
  MerkleNodeRow,
} from '../../../src/types/index.js';
import type {
  IStructuredCatalog,
  StructuredActivationResult,
  StructuredFileRetirement,
  StructuredFileResolution,
  StructuredFullRebuildActivation,
  StructuredGenerationActivation,
  StructuredGenerationStage,
  StructuredImportRecord,
  StructuredIndexCounts,
  StructuredIndexState,
  StructuredPendingClear,
  StructuredPendingSymbolResolution,
  StructuredReconciliationResult,
  StructuredSymbolResolution,
  StructuredTombstone,
} from '../../../src/storage/interfaces/structured-catalog.js';
import type { StructuredDeclaration, StructuredGeneration, StructuredImport } from '../../../src/structured/contracts.js';

interface StructuredCatalogBackup {
  readonly activation: StructuredFullRebuildActivation;
  readonly active: Map<string, StructuredGenerationStage>;
  readonly pending: Map<string, StructuredGenerationStage>;
  readonly tombstones: Map<string, StructuredTombstone>;
}

export class InMemoryMetadataStore implements IMetadataStore, IStructuredCatalog {
  private readonly nodes = new Map<string, MerkleNodeRow>();

  private stats: IndexStatsRow | null = null;

  private readonly deadLetterEntries = new Map<string, DeadLetterEntry>();

  private readonly embeddings = new Map<string, number[]>();

  private readonly active = new Map<string, StructuredGenerationStage>();

  private readonly pending = new Map<string, StructuredGenerationStage>();

  private readonly tombstones = new Map<string, StructuredTombstone>();

  private rebuildEpoch = 0;
  private rebuildState: string | null = null;
  private lastErrorCode: string | null = null;
  private fullRebuildBackup: StructuredCatalogBackup | undefined;

  async initialize(): Promise<void> {
    return;
  }

  private schemaVersion: number | null = null;

  async bootstrapStructuredSchema(): Promise<void> {
    this.schemaVersion = 1;
  }

  async getStructuredIndexState(): Promise<StructuredIndexState> {
    return {
      schemaVersion: this.schemaVersion,
      rebuildState: this.rebuildState,
      rebuildEpoch: this.rebuildEpoch,
      lastErrorCode: this.lastErrorCode,
      counts: await this.getStructuredCounts(),
      activeGenerations: await this.getActiveGenerationMap([...this.active.keys()]),
      reindexRequired: this.schemaVersion === null,
    };
  }

  async setStructuredRebuildState(input: { rebuildState: string; lastErrorCode?: string | null }): Promise<void> {
    this.rebuildState = input.rebuildState;
    this.lastErrorCode = input.lastErrorCode ?? null;
  }

  async incrementRebuildEpoch(): Promise<number> {
    this.rebuildEpoch += 1;
    return this.rebuildEpoch;
  }

  async stageGeneration(input: StructuredGenerationStage): Promise<void> {
    // If a pending generation exists for this file, replace it with the new one.
    this.rebuildEpoch = input.rebuildEpoch;
    this.pending.set(input.filePath, input);
  }

  async activateGeneration(input: StructuredGenerationActivation): Promise<StructuredActivationResult> {
    const pending = this.pending.get(input.filePath);
    const active = this.active.get(input.filePath);
    if (input.expectedRebuildEpoch !== this.rebuildEpoch) return { activated: false, reason: 'stale_rebuild_epoch' };
    if ((active?.generation.generationId ?? null) !== input.expectedActiveGeneration) return { activated: false, reason: 'stale_active_generation' };
    if (pending?.generation.generationId !== input.generationId) return { activated: false, reason: 'missing_generation' };
    const pendingSymbolIds = new Set(pending.declarations.map((declaration) => declaration.symbolId));
    if (active !== undefined) {
      for (const declaration of active.declarations) {
        if (!pendingSymbolIds.has(declaration.symbolId)) {
          this.tombstones.set(declaration.symbolId, { symbolId: declaration.symbolId, filePath: input.filePath, generationId: active.generation.generationId, retiredAtRebuildEpoch: input.expectedRebuildEpoch, retiredAt: Date.now() });
        }
      }
    }
    this.active.set(input.filePath, pending);
    this.pending.delete(input.filePath);
    for (const declaration of pending.declarations) this.tombstones.delete(declaration.symbolId);
    return { activated: true };
  }

  async clearPendingGeneration(input: StructuredPendingClear): Promise<{ cleared: boolean }> {
    const pending = this.pending.get(input.filePath);
    const active = this.active.get(input.filePath);
    if (input.expectedRebuildEpoch !== this.rebuildEpoch || (active?.generation.generationId ?? null) !== input.expectedActiveGeneration || pending?.generation.generationId !== input.expectedPendingGeneration) return { cleared: false };
    this.pending.delete(input.filePath);
    return { cleared: true };
  }

  async retireFile(input: StructuredFileRetirement): Promise<void> {
    const active = this.active.get(input.filePath);
    if (active === undefined || active.generation.generationId !== input.expectedActiveGeneration || input.rebuildEpoch !== this.rebuildEpoch) return;
    for (const declaration of active.declarations) this.tombstones.set(declaration.symbolId, { symbolId: declaration.symbolId, filePath: input.filePath, generationId: active.generation.generationId, retiredAtRebuildEpoch: this.rebuildEpoch, retiredAt: input.tombstoneTimestamp ?? Date.now() });
    this.active.delete(input.filePath);
    this.pending.delete(input.filePath);
  }

  async resolveFile(filePath: string): Promise<StructuredFileResolution> {
    const active = this.active.get(filePath);
    if (active) return { kind: 'active', generationId: active.generation.generationId };
    const pending = this.pending.get(filePath);
    return pending ? { kind: 'pending', generationId: pending.generation.generationId } : { kind: 'missing' };
  }

  async getActiveGenerationMap(filePaths: readonly string[]): Promise<ReadonlyMap<string, string>> {
    return new Map(filePaths.flatMap((filePath) => { const generation = this.active.get(filePath)?.generation.generationId; return generation ? [[filePath, generation] as const] : []; }));
  }

  async resolveSymbol(symbolId: string): Promise<StructuredSymbolResolution> {
    for (const [filePath, generation] of this.active.entries()) {
      const declaration = generation.declarations.find((item) => item.symbolId === symbolId);
      if (declaration) return { kind: 'active', declaration, filePath };
    }
    const tombstone = this.tombstones.get(symbolId);
    return tombstone ? { kind: 'tombstone', tombstone } : { kind: 'missing' };
  }

  async getPendingSymbol(symbolId: string): Promise<StructuredPendingSymbolResolution> {
    for (const generation of this.pending.values()) { const declaration = generation.declarations.find((item) => item.symbolId === symbolId); if (declaration) return { kind: 'pending', declaration }; }
    return { kind: 'missing' };
  }

  async getTombstone(symbolId: string): Promise<StructuredTombstone | null> { return this.tombstones.get(symbolId) ?? null; }

  async getStructuredCounts(): Promise<StructuredIndexCounts> {
    return { activeFiles: this.active.size, activeSymbols: [...this.active.values()].reduce((sum, item) => sum + item.declarations.length, 0), pendingFiles: this.pending.size, pendingSymbols: [...this.pending.values()].reduce((sum, item) => sum + item.declarations.length, 0), tombstones: this.tombstones.size };
  }

  async getImportsForSymbol(symbolId: string): Promise<readonly StructuredImportRecord[]> {
    for (const generation of this.active.values()) {
      const declaration = generation.declarations.find((item) => item.symbolId === symbolId);
      if (declaration !== undefined) {
        const bindingIds = new Set(declaration.importBindingIds ?? []);
        return generation.imports
          .filter((imported) => bindingIds.has(imported.id))
          .map((imported) => ({
            id: imported.id,
            moduleSpecifier: imported.moduleSpecifier,
            bindingName: imported.bindingName,
            startByte: imported.startByte,
            endByte: imported.endByte,
            sourceHash: imported.sourceHash,
            completeness: imported.completeness,
          }));
      }
    }
    return [];
  }

  async getFileDeclarations(filePath: string): Promise<readonly StructuredDeclaration[]> {
    const active = this.active.get(filePath);
    if (active === undefined) return [];
    return [...active.declarations].sort((a, b) => {
      if (a.startByte !== b.startByte) return a.startByte - b.startByte;
      return a.qualifiedName.localeCompare(b.qualifiedName);
    });
  }

  getActiveImportsForFile(filePath: string): readonly StructuredImport[] {
    const active = this.active.get(filePath);
    if (active === undefined) return [];
    return active.imports;
  }

  async getGeneration(filePath: string, generationId: string): Promise<StructuredGeneration | null> {
    const active = this.active.get(filePath);
    if (active !== undefined && active.generation.generationId === generationId) {
      return active.generation;
    }
    const pending = this.pending.get(filePath);
    if (pending !== undefined && pending.generation.generationId === generationId) {
      return pending.generation;
    }
    return null;
  }

  async prepareFullRebuild(input: StructuredFullRebuildActivation): Promise<void> {
    this.validateFullRebuildTargets(input);
    this.fullRebuildBackup = {
      activation: input,
      active: new Map(this.active),
      pending: new Map(this.pending),
      tombstones: new Map(this.tombstones),
    };
  }

  async activateFullRebuild(input: StructuredFullRebuildActivation): Promise<void> {
    if (input.rebuildEpoch !== this.rebuildEpoch) {
      throw new Error(`InMemoryMetadataStore.activateFullRebuild: stale rebuild epoch ${input.rebuildEpoch}`);
    }
    if (this.fullRebuildBackup?.activation.rebuildEpoch !== input.rebuildEpoch) {
      throw new Error(`InMemoryMetadataStore.activateFullRebuild: missing rebuild backup for epoch ${input.rebuildEpoch}`);
    }

    for (const file of input.files) {
      const active = this.active.get(file.filePath);
      const pending = this.pending.get(file.filePath);
      if ((active?.generation.generationId ?? null) !== file.expectedActiveGeneration) {
        throw new Error(`InMemoryMetadataStore.activateFullRebuild: stale active generation for ${file.filePath}`);
      }
      if (pending?.generation.generationId !== file.generationId) {
        throw new Error(`InMemoryMetadataStore.activateFullRebuild: missing generation for ${file.filePath}`);
      }
    }
    for (const file of input.retiredFiles) {
      const active = this.active.get(file.filePath);
      if (active?.generation.generationId !== file.expectedActiveGeneration) {
        throw new Error(`InMemoryMetadataStore.activateFullRebuild: stale retired generation for ${file.filePath}`);
      }
    }

    for (const file of input.files) {
      this.activateGenerationState(file.filePath, file.generationId, input.rebuildEpoch);
    }
    for (const file of input.retiredFiles) {
      this.retireGenerationState(file.filePath, input.rebuildEpoch);
    }
  }

  async rollbackFullRebuild(input: StructuredFullRebuildActivation): Promise<void> {
    if (this.fullRebuildBackup?.activation.rebuildEpoch !== input.rebuildEpoch) {
      return;
    }
    const backup = this.fullRebuildBackup;
    if (backup === undefined) return;
    this.active.clear();
    for (const [filePath, generation] of backup.active) this.active.set(filePath, generation);
    this.pending.clear();
    for (const [filePath, generation] of backup.pending) this.pending.set(filePath, generation);
    this.tombstones.clear();
    for (const [symbolId, tombstone] of backup.tombstones) this.tombstones.set(symbolId, tombstone);
    this.fullRebuildBackup = undefined;
  }

  async finalizeFullRebuild(input: StructuredFullRebuildActivation): Promise<void> {
    if (this.fullRebuildBackup?.activation.rebuildEpoch === input.rebuildEpoch) {
      this.fullRebuildBackup = undefined;
    }
  }

  async reconcileStructuredState(): Promise<StructuredReconciliationResult> {
    const activeSymbolIds = new Set([...this.active.values()].flatMap((generation) => generation.declarations.map((declaration) => declaration.symbolId)));
    let prunedTombstones = 0;
    for (const symbolId of this.tombstones.keys()) {
      if (activeSymbolIds.has(symbolId)) {
        this.tombstones.delete(symbolId);
        prunedTombstones += 1;
      }
    }
    return { repaired: prunedTombstones > 0, prunedTombstones };
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

  async replaceAllMerkleNodes(nodes: MerkleNodeRow[]): Promise<void> {
    this.nodes.clear();
    for (const node of nodes) {
      this.nodes.set(node.path, node);
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

  async getSubtreePaths(pathPrefix: string): Promise<string[]> {
    const normalizedPrefix = `${pathPrefix}/`;
    const paths: string[] = [];

    for (const key of this.nodes.keys()) {
      if (key === pathPrefix || key.startsWith(normalizedPrefix)) {
        paths.push(key);
      }
    }

    return paths;
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
    const normalizedParentPath = parentPath === '.' || parentPath === '/' || parentPath === '' ? null : parentPath;

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

  async atomicCompletionCheck(stats: IndexStatsRow): Promise<{
    dlqEmpty: boolean;
    dlqEntries: DeadLetterEntry[];
  }> {
    const dlqEntries = await this.getDeadLetterEntries();
    if (dlqEntries.length === 0) {
      this.stats = stats;
    }
    return { dlqEmpty: dlqEntries.length === 0, dlqEntries };
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

  async getEmbeddings(hashes: string[]): Promise<Map<string, number[]>> {
    const result = new Map<string, number[]>();
    for (const hash of hashes) {
      const vector = this.embeddings.get(hash);
      if (vector !== undefined) {
        result.set(hash, [...vector]);
      }
    }
    return result;
  }

  async setEmbeddings(entries: EmbeddingCacheEntry[]): Promise<void> {
    for (const entry of entries) {
      this.embeddings.set(entry.hash, [...entry.vector]);
    }
  }

  async deleteEmbeddings(hashes: string[]): Promise<void> {
    for (const hash of hashes) {
      this.embeddings.delete(hash);
    }
  }

  async clearEmbeddings(): Promise<void> {
    this.embeddings.clear();
  }

  async pruneEmbeddings(_maxAgeDays: number): Promise<number> {
    // In-memory store has no persistent TTL concern for tests
    return 0;
  }

  private activateGenerationState(filePath: string, generationId: string, rebuildEpoch: number): void {
    const pending = this.pending.get(filePath);
    const active = this.active.get(filePath);
    if (pending === undefined || pending.generation.generationId !== generationId) {
      throw new Error(`InMemoryMetadataStore.activateFullRebuild: missing generation for ${filePath}`);
    }
    if (active !== undefined) {
      const pendingSymbolIds = new Set(pending.declarations.map((declaration) => declaration.symbolId));
      for (const declaration of active.declarations) {
        if (!pendingSymbolIds.has(declaration.symbolId)) {
          this.tombstones.set(declaration.symbolId, {
            symbolId: declaration.symbolId,
            filePath,
            generationId: active.generation.generationId,
            retiredAtRebuildEpoch: rebuildEpoch,
            retiredAt: Date.now(),
          });
        }
      }
    }
    this.active.set(filePath, pending);
    this.pending.delete(filePath);
    for (const declaration of pending.declarations) this.tombstones.delete(declaration.symbolId);
  }

  private validateFullRebuildTargets(input: StructuredFullRebuildActivation): void {
    if (input.rebuildEpoch !== this.rebuildEpoch) {
      throw new Error(`InMemoryMetadataStore.prepareFullRebuild: stale rebuild epoch ${input.rebuildEpoch}`);
    }
    const paths = new Set<string>();
    for (const file of input.files) {
      if (paths.has(file.filePath)) {
        throw new Error(`InMemoryMetadataStore.prepareFullRebuild: duplicate file ${file.filePath}`);
      }
      paths.add(file.filePath);
      const activeGeneration = this.active.get(file.filePath)?.generation.generationId ?? null;
      if (activeGeneration !== file.expectedActiveGeneration) {
        throw new Error(`InMemoryMetadataStore.prepareFullRebuild: stale active generation for ${file.filePath}`);
      }
    }
    for (const file of input.retiredFiles) {
      if (paths.has(file.filePath)) {
        throw new Error(`InMemoryMetadataStore.prepareFullRebuild: duplicate file ${file.filePath}`);
      }
      paths.add(file.filePath);
      const activeGeneration = this.active.get(file.filePath)?.generation.generationId;
      if (activeGeneration !== file.expectedActiveGeneration) {
        throw new Error(`InMemoryMetadataStore.prepareFullRebuild: stale retired generation for ${file.filePath}`);
      }
    }
  }

  private retireGenerationState(filePath: string, rebuildEpoch: number): void {
    const active = this.active.get(filePath);
    if (active === undefined) return;
    for (const declaration of active.declarations) {
      this.tombstones.set(declaration.symbolId, {
        symbolId: declaration.symbolId,
        filePath,
        generationId: active.generation.generationId,
        retiredAtRebuildEpoch: rebuildEpoch,
        retiredAt: Date.now(),
      });
    }
    this.active.delete(filePath);
    this.pending.delete(filePath);
  }
}
