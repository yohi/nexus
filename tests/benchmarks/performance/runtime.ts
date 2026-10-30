import { basename, dirname, join } from 'node:path';
import { DEFAULT_BATCH_SIZE } from '../../../src/config/index.js';
import { createRuntimeAssembly } from '../../../src/server/runtime-assembly.js';
import type { RuntimeAssembly } from '../../../src/server/runtime/assembly-types.js';
import type { RuntimeObserver } from '../../../src/observability/runtime-observer.js';
import type { Config } from '../../../src/types/index.js';
import { observeRuntimeWork } from '../../../src/observability/runtime-work.js';
import { createSyntheticProvider, syntheticEmbeddingConfig } from './synthetic-provider.js';
import type { RuntimeDiagnosticContext } from '../../../src/observability/diagnostic-stage-trace.js';

export type RuntimeFactory = (signal: AbortSignal) => Promise<RuntimeAssembly>;

export function createBenchmarkRuntimeFactory(root: string, observer?: RuntimeObserver, diagnosticTraceContext?: RuntimeDiagnosticContext): RuntimeFactory {
  const storageRoot = join(dirname(root), `${basename(root)}.nexus-perf-state`);
  const config: Config = {
    projectRoot: root, projectName: 'nexus-performance', packageMode: false,
    storage: { rootDir: storageRoot, metadataDbPath: join(storageRoot, 'metadata.db'),
      vectorDbPath: join(storageRoot, 'vectors'), batchSize: DEFAULT_BATCH_SIZE },
    embedding: syntheticEmbeddingConfig,
    indexing: { maxFileBytes: 1_048_576, maxChunkChars: 4096, chunkConcurrency: 2, embedBatchWindowSize: 16 },
    watcher: { debounceMs: 100, maxQueueSize: 10_000, fullScanThreshold: 5_000,
      ignorePaths: ['.git', '.nexus', 'node_modules'] },
  };
  return async (signal) => {
    signal.throwIfAborted();
    const assembly = await createRuntimeAssembly(config, { createEmbeddingProvider: createSyntheticProvider, observer, diagnosticTraceContext });
    const initialize = assembly.runtime.initialize.bind(assembly.runtime);
    assembly.runtime.initialize = () => observeRuntimeWork(observer, 'initialization', initialize).catch(async (error: unknown) => {
      await assembly.runtime.close();
      throw error;
    });
    if (signal.aborted) {
      await assembly.runtime.close();
      signal.throwIfAborted();
    }
    return assembly;
  };
}
