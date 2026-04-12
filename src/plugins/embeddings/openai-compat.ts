import pLimit from 'p-limit';

import type { EmbeddingConfig, EmbeddingProvider } from '../../types/index.js';
import { RetryExhaustedError } from '../../types/index.js';

interface OpenAIDependencies {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

interface OpenAIEmbedResponse {
  data: Array<{
    embedding: number[];
  }>;
}

const defaultDependencies: OpenAIDependencies = {
  fetch: globalThis.fetch,
  sleep: async (ms: number) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

export class OpenAICompatEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;

  private readonly limit;

  constructor(
    private readonly config: Pick<EmbeddingConfig, 'baseUrl' | 'apiKey' | 'model' | 'dimensions' | 'maxConcurrency' | 'batchSize' | 'retryCount' | 'retryBaseDelayMs'>,
    private readonly dependencies: OpenAIDependencies = defaultDependencies,
  ) {
    this.dimensions = config.dimensions;
    this.limit = pLimit(config.maxConcurrency);
  }

  async embed(texts: string[]): Promise<number[][]> {
    const batches = this.chunkTexts(texts);
    const promises = batches.map(async (batch) => this.limit(async () => this.embedBatchWithRetry(batch)));
    const results = await Promise.all(promises);

    return results.flat();
  }

  async healthCheck(): Promise<boolean> {
    try {
      const url = new URL('/v1/models', this.config.baseUrl || 'https://api.openai.com').toString();
      const headers: Record<string, string> = {};
      if (this.config.apiKey) {
        headers['Authorization'] = `Bearer ${this.config.apiKey}`;
      }
      const response = await this.dependencies.fetch(url, {
        method: 'GET',
        headers,
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

    throw new RetryExhaustedError('Failed to fetch embeddings from OpenAI-compatible API', attempt, {
      cause: lastError,
    });
  }

  private async requestEmbeddings(batch: string[]): Promise<number[][]> {
    const url = new URL('/v1/embeddings', this.config.baseUrl || 'https://api.openai.com').toString();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const response = await this.dependencies.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: this.config.model,
        input: batch,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OpenAI-compatible API embed request failed (${response.status}): ${body}`);
    }

    const payload = (await response.json()) as OpenAIEmbedResponse;
    const embeddings = payload.data.map((d) => d.embedding);

    for (const vector of embeddings) {
      if (vector.length !== this.dimensions) {
        throw new Error(`Unexpected embedding dimension: expected ${this.dimensions}, received ${vector.length}`);
      }
    }

    return embeddings;
  }

  private chunkTexts(texts: string[]): string[][] {
    const batches: string[][] = [];

    for (let index = 0; index < texts.length; index += this.config.batchSize) {
      batches.push(texts.slice(index, index + this.config.batchSize));
    }

    return batches;
  }
}
