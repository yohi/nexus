import type { NexusRuntime, NexusRuntimeOptions } from '../index.js';
import type { RuntimeObserver } from '../../observability/runtime-observer.js';
import type { SqliteMetadataStore } from '../../storage/metadata-store.js';
import type { LanceVectorStore } from '../../storage/vector-store.js';
import type { EventQueue } from '../../indexer/event-queue.js';
import type { EmbeddingProviderFactory } from './plugins.js';
import type { PathSanitizer } from '../path-sanitizer.js';
import type { RuntimeDiagnosticContext } from '../../observability/diagnostic-stage-trace.js';
import type { WriterAdmission } from '../storage-ownership/admission.js';

export interface RuntimeAssemblyDependencies {
  readonly createEmbeddingProvider?: EmbeddingProviderFactory;
  readonly observer?: RuntimeObserver;
  readonly diagnosticTraceContext?: RuntimeDiagnosticContext;
  /** Issued writer admission transferred by the CLI/Factory; consumed once. Absent => the Assembly admits itself. */
  readonly writerAdmission?: WriterAdmission;
  /** Internal: lost-lease detection interval (tests only). */
  readonly writerLeaseCheckIntervalMs?: number;
}
export interface RuntimeDiagnostics {
  readonly metadataDbPath: string;
  readonly vectorDbPath: string;
  readonly sanitizer: PathSanitizer;
  readonly metadataStore: SqliteMetadataStore;
  readonly vectorStore: LanceVectorStore;
  readonly queueSnapshot: () => Readonly<{
    size: number; postScanSize: number; dropped: number; state: ReturnType<EventQueue['getState']>;
    postScanActive: boolean;
  }>;
  readonly pendingDrainCount: () => number;
  readonly stateRevision: () => number;
}
export interface RuntimeAssembly {
  readonly runtime: NexusRuntime;
  readonly options: NexusRuntimeOptions;
  readonly diagnostics: RuntimeDiagnostics;
}
