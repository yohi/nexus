import type { IMetadataStore, IVectorStore, PipelineProgress, IIndexPipeline } from "../../types/index.js";
import type { StructuredIndexState } from "../../storage/interfaces/structured-catalog.js";

export interface StructuredIndexStatus {
  schemaVersion: number | null;
  targetSchemaVersion: number;
  status: "idle" | "building" | "failed" | "reindex_required" | "unsupported";
  rebuildState: string | null;
  lastErrorCode: string | null;
  totalFiles: number;
  totalSymbols: number;
  exactFiles: number;
  degradedFiles: number;
  pendingFiles: number;
  reindexRequired: boolean;
}

export interface SharedIndexStatus {
  indexStats: Awaited<ReturnType<IMetadataStore["getIndexStats"]>>;
  vectorStats: Awaited<ReturnType<IVectorStore["getStats"]>>;
  skippedFiles: number;
  pipelineProgress: PipelineProgress;
  structuredIndex?: StructuredIndexStatus;
}

const deriveStructuredStatus = (state: StructuredIndexState): StructuredIndexStatus["status"] => {
  if (state.schemaVersion === null) return "reindex_required";
  if (state.schemaVersion !== 1) return "unsupported";
  if (state.rebuildState === "building") return "building";
  if (state.rebuildState === "failed") return "failed";
  return "idle";
};

export const buildSharedIndexStatus = async (
  metadataStore: IMetadataStore,
  vectorStore: IVectorStore,
  pipeline: IIndexPipeline,
): Promise<SharedIndexStatus> => {
  const structuredStatePromise =
    metadataStore.getStructuredIndexState === undefined
      ? Promise.resolve(undefined)
      : metadataStore.getStructuredIndexState();

  const [indexStats, vectorStats, deadLetterEntries, structuredState] = await Promise.all([
    metadataStore.getIndexStats(),
    vectorStore.getStats(),
    metadataStore.getDeadLetterEntries(),
    structuredStatePromise.catch(() => undefined),
  ]);

  const structuredIndex: StructuredIndexStatus | undefined =
    structuredState === undefined
      ? undefined
      : {
          schemaVersion: structuredState.schemaVersion,
          targetSchemaVersion: 1,
          status: deriveStructuredStatus(structuredState),
          rebuildState: structuredState.rebuildState,
          lastErrorCode: structuredState.lastErrorCode,
          totalFiles: structuredState.counts.activeFiles,
          totalSymbols: structuredState.counts.activeSymbols,
          exactFiles: structuredState.counts.activeFiles,
          degradedFiles: 0,
          pendingFiles: structuredState.counts.pendingFiles,
          reindexRequired: structuredState.reindexRequired,
        };

  return {
    indexStats,
    vectorStats,
    skippedFiles: deadLetterEntries.length,
    pipelineProgress: pipeline.getProgress(),
    structuredIndex,
  };
};
