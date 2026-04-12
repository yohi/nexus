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

const DEFAULT_TIMEOUT_MS = 30000;

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
      | 'baseUrl'
      | 'apiKey'
      | 'model'
      | 'dimensions'
      | 'maxConcurrency'
      | 'batchSize'
      | 'retryCount'
      | 'retryBaseDelayMs'
      | 'timeoutMs'
    >,
    private readonly dependencies: OpenAIDependencies = defaultDependencies,
  ) {
    super();
    this.dimensions = config.dimensions;
    this.limit = pLimit(config.maxConcurrency);
  }

  async embed(texts: string[]): Promise<number[][]> {
    const batches = this.chunkTexts(texts, this.config.batchSize);
    const promises = batches.map((batch) => this.limit(() => this.embedBatchWithRetry(batch)));
    const results = await Promise.all(promises);

    return results.flat();
  }

  async healthCheck(): Promise<boolean> {
    const controller = new AbortController();
    const timeoutMs = this.config.timeoutMs || DEFAULT_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const url = this.buildUrl('v1/models');
      const headers: Record<string, string> = {};
      if (this.config.apiKey) {
        headers['Authorization'] = `Bearer ${this.config.apiKey}`;
      }
      const response = await this.dependencies.fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildUrl(path: string): string {
    const baseUrl = this.config.baseUrl || 'https://api.openai.com';
    const url = new URL(baseUrl);

    // Ensure pathname ends with a slash before joining
    if (!url.pathname.endsWith('/')) {
      url.pathname += '/';
    }

    // Resolve the clean path relative to the normalized base
    const cleanPath = path.replace(/^\//, '');
    return new URL(cleanPath, url.toString()).toString();
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
    if (!Number.isInteger(this.dimensions) || this.dimensions <= 0) {
      throw new EmbedError('Embedding dimensions must be a positive integer', undefined, false);
    }

    const url = this.buildUrl('v1/embeddings');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const controller = new AbortController();
    const timeoutMs = this.config.timeoutMs || DEFAULT_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      controller.abort();
    }, timeoutMs);

    try {
      const response = await this.dependencies.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.config.model,
          input: batch,
          dimensions: this.dimensions,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        const status = response.status;
        // 400 (Bad Request), 401 (Unauthorized), 403 (Forbidden), 404 (Not Found) are usually non-retriable
        const retriable = status === 429 || status >= 500;
        throw new EmbedError(`OpenAI-compatible API embed request failed (${status}): ${body}`, status, retriable);
      }

      const payload = (await response.json()) as OpenAIEmbedResponse;
      const data = payload.data;
      if (!Array.isArray(data)) {
        throw new EmbedError('Invalid response payload from OpenAI-compatible API', response.status, false);
      }

      if (data.length !== batch.length) {
        throw new EmbedError(
          `OpenAI-compatible API returned ${data.length} embeddings for ${batch.length} inputs`,
          response.status,
          false,
        );
      }

      const embeddings: number[][] = [];
      let i = 0;
      for (const entry of data) {
        // Validate entry structure and remove redundant checks
        if (!Array.isArray(entry.embedding)) {
          throw new EmbedError(
            `Missing or malformed embedding for response entry at index ${i} (status: ${response.status})`,
            response.status,
            false,
          );
        }

        const vector = entry.embedding;
        // Security: Ensure the embedding contains only numbers
        if (!vector.every((v) => typeof v === 'number')) {
          throw new EmbedError(`Invalid embedding data at index ${i}: not a number array`, undefined, false);
        }

        if (vector.length !== this.dimensions) {
          throw new DimensionMismatchError(
            `Unexpected embedding dimension at index ${i}: expected ${this.dimensions}, received ${vector.length}`,
          );
        }
        embeddings.push(vector);
        i += 1;
      }

      return embeddings;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new EmbedError('OpenAI-compatible API request timed out', 408, true);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
