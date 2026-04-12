import pLimit from 'p-limit';

import type { EmbeddingConfig } from '../../types/index.js';
import { RetryExhaustedError, DimensionMismatchError } from '../../types/index.js';
import { BaseEmbeddingProvider } from './base.js';

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

export class EmbedError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retriable: boolean = true,
  ) {
    super(message);
    this.name = 'EmbedError';
  }
}

export class OpenAICompatEmbeddingProvider extends BaseEmbeddingProvider {
  readonly dimensions: number;

  private readonly limit;

  constructor(
    private readonly config: Pick<
      EmbeddingConfig,
      'baseUrl' | 'apiKey' | 'model' | 'dimensions' | 'maxConcurrency' | 'batchSize' | 'retryCount' | 'retryBaseDelayMs'
    >,
    private readonly dependencies: OpenAIDependencies = defaultDependencies,
  ) {
    super();
    this.dimensions = config.dimensions;
    this.limit = pLimit(config.maxConcurrency);
  }

  async embed(texts: string[]): Promise<number[][]> {
    const batches = this.chunkTexts(texts, this.config.batchSize);
    const promises = batches.map(async (batch) => this.limit(async () => this.embedBatchWithRetry(batch)));
    const results = await Promise.all(promises);

    return results.flat();
  }

  async healthCheck(): Promise<boolean> {
    try {
      const url = this.buildUrl('v1/models');
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

  private buildUrl(path: string): string {
    const base = this.config.baseUrl || 'https://api.openai.com';
    const baseUrlWithSlash = base.endsWith('/') ? base : `${base}/`;
    // Ensure path doesn't start with a slash to preserve baseUrl's subpath
    const cleanPath = path.replace(/^\//, '');
    return new URL(cleanPath, baseUrlWithSlash).toString();
  }

  private async embedBatchWithRetry(batch: string[]): Promise<number[][]> {
    let attempt = 0;
    let lastError: Error | undefined;

    // attempt=0 is the first try, so we allow up to retryCount retries (total attempts: retryCount + 1)
    while (attempt <= this.config.retryCount) {
      try {
        return await this.requestEmbeddings(batch);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Non-retriable errors should be thrown immediately
        if (error instanceof DimensionMismatchError) {
          throw error;
        }
        if (error instanceof EmbedError && !error.retriable) {
          throw error;
        }

        if (attempt >= this.config.retryCount) {
          break;
        }

        attempt += 1;
        await this.dependencies.sleep(this.config.retryBaseDelayMs * 2 ** (attempt - 1));
      }
    }

    throw new RetryExhaustedError('Failed to fetch embeddings from OpenAI-compatible API', attempt + 1, {
      cause: lastError,
    });
  }

  private async requestEmbeddings(batch: string[]): Promise<number[][]> {
    if (!this.dimensions || this.dimensions <= 0) {
      throw new EmbedError('Embedding dimensions must be a positive integer', undefined, false);
    }

    const url = this.buildUrl('v1/embeddings');
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
        dimensions: this.dimensions,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      const status = response.status;
      // 400 (Bad Request), 401 (Unauthorized), 403 (Forbidden), 404 (Not Found) are usually non-retriable
      const retriable = status === 429 || status >= 500;
      throw new EmbedError(`OpenAI-compatible API embed request failed (${status}): ${body}`, status, retriable);
    }

    const payload = (await response.json()) as OpenAIEmbedResponse;
    if (!payload || !Array.isArray(payload.data)) {
      throw new EmbedError('Invalid response payload from OpenAI-compatible API', response.status, false);
    }

    if (payload.data.length !== batch.length) {
      throw new EmbedError(
        `OpenAI-compatible API returned ${payload.data.length} embeddings for ${batch.length} inputs`,
        response.status,
        false,
      );
    }

    const embeddings: number[][] = [];
    for (let i = 0; i < payload.data.length; i += 1) {
      const entry = payload.data[i];
      if (!entry || !Array.isArray(entry.embedding)) {
        throw new EmbedError(
          `Missing embedding for response entry at index ${i} (status: ${response.status})`,
          response.status,
          false,
        );
      }

      const vector = entry.embedding;
      if (vector.length !== this.dimensions) {
        throw new DimensionMismatchError(
          `Unexpected embedding dimension at index ${i}: expected ${this.dimensions}, received ${vector.length}`,
        );
      }
      embeddings.push(vector);
    }

    return embeddings;
  }
}
