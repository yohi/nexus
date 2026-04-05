import pLimit from 'p-limit';

import type { EmbeddingConfig, EmbeddingProvider } from '../../types/index.js';
import { RetryExhaustedError } from '../../types/index.js';

interface OllamaDependencies {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

interface OllamaEmbedResponse {
  embeddings: number[][];
}

const defaultDependencies: OllamaDependencies = {
  fetch: globalThis.fetch,
  sleep: async (ms: number) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;

  private readonly limit;

  constructor(
    private readonly config: Pick<EmbeddingConfig, 'baseUrl' | 'model' | 'dimensions' | 'maxConcurrency' | 'batchSize' | 'retryCount' | 'retryBaseDelayMs'>,
    private readonly dependencies: OllamaDependencies = defaultDependencies,
  ) {
    this.dimensions = config.dimensions;
    this.limit = pLimit(config.maxConcurrency);
  }

  async embed(texts: string[]): Promise<number[][]> {
    const batches = this.chunkTexts(texts);
    const results: number[][] = [];

    for (const batch of batches) {
      const vectors = await this.limit(async () => this.embedBatchWithRetry(batch));
      results.push(...vectors);
    }

    return results;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.dependencies.fetch(new URL('/api/tags', this.config.baseUrl).toString(), {
        method: 'GET',
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async embedBatchWithRetry(batch: string[]): Promise<number[][]> {
    let attempt = 0;
    let lastError: Error | undefined;

    while (attempt < this.config.retryCount) {
      attempt += 1;

      try {
        return await this.requestEmbeddings(batch);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt >= this.config.retryCount) {
          break;
        }

        await this.dependencies.sleep(this.config.retryBaseDelayMs * 2 ** (attempt - 1));
      }
    }

    throw new RetryExhaustedError('Failed to fetch embeddings from Ollama', attempt, {
      cause: lastError,
    });
  }

  private async requestEmbeddings(batch: string[]): Promise<number[][]> {
    const response = await this.dependencies.fetch(new URL('/api/embed', this.config.baseUrl).toString(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model,
        input: batch,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama embed request failed (${response.status}): ${body}`);
    }

    const payload = (await response.json()) as OllamaEmbedResponse;

    for (const vector of payload.embeddings) {
      if (vector.length !== this.dimensions) {
        throw new Error(`Unexpected embedding dimension: expected ${this.dimensions}, received ${vector.length}`);
      }
    }

    return payload.embeddings;
  }

  private chunkTexts(texts: string[]): string[][] {
    const batches: string[][] = [];

    for (let index = 0; index < texts.length; index += this.config.batchSize) {
      batches.push(texts.slice(index, index + this.config.batchSize));
    }

    return batches;
  }
}
