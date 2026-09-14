import type {
  StructuredDeclaration,
  StructuredGeneration,
  StructuredImport,
} from '../../structured/contracts.js';

export interface StructuredImportRecord {
  readonly id: string;
  readonly moduleSpecifier?: string;
  readonly bindingName?: string;
  readonly startByte: number;
  readonly endByte: number;
  readonly sourceHash: string;
  readonly completeness: 'complete' | 'partial';
}

export interface StructuredPendingClear {
  readonly filePath: string;
  readonly expectedActiveGeneration: string | null;
  readonly expectedPendingGeneration: string;
  readonly expectedRebuildEpoch: number;
}

export interface StructuredGenerationStage {
  readonly filePath: string;
  readonly generation: StructuredGeneration;
  readonly declarations: readonly StructuredDeclaration[];
  readonly imports: readonly StructuredImport[];
  readonly rebuildEpoch: number;
  readonly bytes: Uint8Array;
  readonly fileHash: string;
  readonly fileCompleteness: 'complete' | 'partial';
  readonly fileDiagnostics?: readonly unknown[];
}

export interface StructuredGenerationActivation {
  readonly filePath: string;
  readonly generationId: string;
  readonly expectedActiveGeneration: string | null;
  readonly expectedRebuildEpoch: number;
}

export interface StructuredFileRetirement {
  readonly filePath: string;
  readonly expectedActiveGeneration: string | null;
  readonly rebuildEpoch: number;
  readonly tombstoneTimestamp?: number;
}

export interface StructuredIndexState {
  readonly schemaVersion: number | null;
  readonly rebuildState: string | null;
  readonly rebuildEpoch: number;
  readonly lastErrorCode: string | null;
  readonly counts: StructuredIndexCounts;
  readonly activeGenerations: ReadonlyMap<string, string>;
  readonly reindexRequired: boolean;
}

export interface StructuredActivationResult {
  readonly activated: boolean;
  readonly reason?: 'stale_active_generation' | 'stale_rebuild_epoch' | 'missing_generation';
}

export type StructuredFileResolution =
  | { readonly kind: 'active'; readonly generationId: string }
  | { readonly kind: 'pending'; readonly generationId: string }
  | { readonly kind: 'missing' };

export type StructuredSymbolResolution =
  | { readonly kind: 'active'; readonly declaration: StructuredDeclaration; readonly filePath: string }
  | { readonly kind: 'tombstone'; readonly tombstone: StructuredTombstone }
  | { readonly kind: 'missing' };

export type StructuredPendingSymbolResolution =
  | { readonly kind: 'pending'; readonly declaration: StructuredDeclaration }
  | { readonly kind: 'missing' };

export interface StructuredTombstone {
  readonly symbolId: string;
  readonly filePath: string;
  readonly generationId: string;
  readonly retiredAtRebuildEpoch: number;
  readonly retiredAt: number;
}

export interface StructuredIndexCounts {
  readonly activeFiles: number;
  readonly activeSymbols: number;
  readonly pendingFiles: number;
  readonly pendingSymbols: number;
  readonly tombstones: number;
}

export interface StructuredReconciliationResult {
  readonly repaired: boolean;
  readonly prunedTombstones: number;
}

export type FullRebuildCommitPhase =
  | 'building'
  | 'legacy-swapped'
  | 'structured-swapped'
  | 'catalog-activated'
  | 'merkle-activated'
  | 'idle'
  | 'failed';

export interface MerkleSnapshotNode {
  readonly path: string;
  readonly hash: string;
  readonly parentPath: string | null;
  readonly isDirectory: boolean;
}

export interface FullRebuildRecovery {
  readonly rebuildEpoch: number;
  readonly phase: FullRebuildCommitPhase;
  readonly merkleSnapshot: readonly MerkleSnapshotNode[] | null;
}

export interface StructuredFullRebuildFile {
  readonly filePath: string;
  readonly generationId: string;
  readonly expectedActiveGeneration: string | null;
}

export interface StructuredFullRebuildActivation {
  readonly rebuildEpoch: number;
  readonly files: readonly StructuredFullRebuildFile[];
  readonly retiredFiles: readonly {
    readonly filePath: string;
    readonly expectedActiveGeneration: string;
  }[];
}

export interface IStructuredCatalog {
  bootstrapStructuredSchema(): Promise<void>;
  getStructuredIndexState(): Promise<StructuredIndexState>;
  setStructuredRebuildState(input: { rebuildState: FullRebuildCommitPhase; lastErrorCode?: string | null }): Promise<void>;
  incrementRebuildEpoch(): Promise<number>;
  stageGeneration(input: StructuredGenerationStage): Promise<void>;
  activateGeneration(input: StructuredGenerationActivation): Promise<StructuredActivationResult>;
  clearPendingGeneration(input: StructuredPendingClear): Promise<{ cleared: boolean }>;
  retireFile(input: StructuredFileRetirement): Promise<void>;
  resolveFile(filePath: string): Promise<StructuredFileResolution>;
  getActiveGenerationMap(filePaths: readonly string[]): Promise<ReadonlyMap<string, string>>;
  resolveSymbol(symbolId: string): Promise<StructuredSymbolResolution>;
  getPendingSymbol(symbolId: string): Promise<StructuredPendingSymbolResolution>;
  getTombstone(symbolId: string): Promise<StructuredTombstone | null>;
  getStructuredCounts(): Promise<StructuredIndexCounts>;
  getImportsForSymbol(symbolId: string): Promise<readonly StructuredImportRecord[]>;
  getFileDeclarations(filePath: string): Promise<readonly StructuredDeclaration[]>;
  getGeneration(filePath: string, generationId: string): Promise<StructuredGeneration | null>;
  prepareFullRebuild(input: StructuredFullRebuildActivation, merkleSnapshot?: readonly MerkleSnapshotNode[]): Promise<void>;
  activateFullRebuild(input: StructuredFullRebuildActivation): Promise<void>;
  rollbackFullRebuild(input: StructuredFullRebuildActivation): Promise<void>;
  finalizeFullRebuild(input: StructuredFullRebuildActivation): Promise<void>;
  getFullRebuildRecovery?(): Promise<FullRebuildRecovery | null>;
  recoverInterruptedFullRebuild?(): Promise<void>;
  finalizeInterruptedFullRebuild?(): Promise<void>;
  reconcileStructuredState(): Promise<StructuredReconciliationResult>;
}
