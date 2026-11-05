import { IndexPipeline } from '../../src/indexer/pipeline.js';
import type { EmbeddingProvider } from '../../src/types/index.js';

type PipelineOptions = ConstructorParameters<typeof IndexPipeline>[0];
type PipelineBase = Pick<PipelineOptions, 'metadataStore' | 'vectorStore' | 'chunker' | 'pluginRegistry'>;
type PipelineOverrides = Partial<Omit<PipelineOptions,
  'metadataStore' | 'vectorStore' | 'chunker' | 'pluginRegistry' | 'embeddingProvider'>>;

export function createDiagnosticPipeline(
  base: PipelineBase,
  embeddingProvider: EmbeddingProvider,
  overrides: PipelineOverrides = {},
): IndexPipeline {
  return new IndexPipeline({ ...base, embeddingProvider, ...overrides });
}
