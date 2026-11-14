import type { CodeChunk, IndexEvent, IMetadataStore, IVectorStore, IntegrityRecoveryRequest } from '../types/index.js';
import type { StructuredDeclaration, StructuredGeneration, StructuredImport } from '../structured/contracts.js';

export type IntegrityAssessment =
  | { readonly kind: 'MATCH' }
  | { readonly kind: 'CORRUPTION_CONFIRMED'; readonly reason: 'row_multiset_mismatch' | 'invalid_vector' }
  | { readonly kind: 'INTEGRITY_UNKNOWN'; readonly reason: 'expected_rows_unavailable' | 'expected_vector_invalid' };

export interface IntegrityPreparedFile {
  readonly event: IndexEvent;
  readonly sourceHash: string;
  readonly merkleHash: string;
  readonly chunks: readonly CodeChunk[];
  readonly structured: Readonly<{
    generation: StructuredGeneration;
    fileCompleteness: 'complete' | 'partial';
    declarations: readonly StructuredDeclaration[];
    imports: readonly StructuredImport[];
    chunks: readonly CodeChunk[];
  }> | undefined;
  readonly structuredRetirement: boolean;
  readonly structuredParseFailed: boolean;
  readonly skipped: boolean;
}

export type IntegrityPreflightResult =
  | { readonly kind: 'MATCH'; readonly request: IntegrityRecoveryRequest; readonly sourceIdentities: ReadonlyMap<string, string> }
  | { readonly kind: 'GENERATION_CHANGED' }
  | { readonly kind: 'CORRUPTION_CONFIRMED'; readonly request: IntegrityRecoveryRequest; readonly sourceIdentities: ReadonlyMap<string, string> }
  | { readonly kind: 'INTEGRITY_UNKNOWN'; readonly reason: string };

export interface IntegrityPreflightInput {
  readonly events: readonly IndexEvent[];
  readonly files: readonly IntegrityPreparedFile[];
  readonly metadataStore: IMetadataStore;
  readonly vectorStore: IVectorStore;
  readonly dimensions: number;
  readonly embeddingKeyFor: ((hash: string) => string) | undefined;
  readonly l1Embeddings: ReadonlyMap<string, readonly number[]>;
  readonly loadEmbeddingSource: (hashes: readonly string[]) => Promise<ReadonlyMap<string, number[]>>;
  readonly rescan: () => Promise<IndexEvent[]>;
  readonly readSourceHash: (filePath: string) => Promise<string>;
  readonly assertWriterLease: () => void;
  readonly queueIsQuiet: () => boolean;
  readonly signal: AbortSignal;
  readonly catalogEnabled: boolean;
}

export interface IntegrityRecoveryAbortedErrorCode {
  readonly code: 'state_changed_before_commit' | 'writer_lease_lost' | 'input_incomplete' | 'staged_input_changed';
}

export class IntegrityRecoveryAbortedError extends Error implements IntegrityRecoveryAbortedErrorCode {
  constructor(readonly code: IntegrityRecoveryAbortedErrorCode['code']) {
    super(code);
    this.name = 'IntegrityRecoveryAbortedError';
  }
}

export type CatalogRead = Readonly<{
  epoch: number;
  active: ReadonlyMap<string, string>;
  state: Awaited<ReturnType<NonNullable<IMetadataStore['getStructuredIndexState']>>>;
}>;
