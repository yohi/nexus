import type { EmbeddingProvider } from '../../types/index.js';
import type { MetricsHooks } from '../../observability/types.js';

export class InstrumentedEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly inner: EmbeddingProvider,
    private readonly hooks: MetricsHooks,
    private readonly providerName: string,
  ) {}

  get dimensions(): number {
    return this.inner.dimensions;
  }

  async healthCheck(): Promise<boolean> {
    return this.inner.healthCheck();
  }

  async embed(texts: string[]): Promise<number[][]> {
    const start = performance.now();
    try {
      const result = await this.inner.embed(texts);
      this.hooks.onEmbeddingRequest(
        this.providerName,
        'success',
        (performance.now() - start) / 1000,
        texts.length,
      );
      return result;
    } catch (error) {
      this.hooks.onEmbeddingRequest(
        this.providerName,
        'error',
        (performance.now() - start) / 1000,
        texts.length,
      );
      throw error;
    }
  }
}
