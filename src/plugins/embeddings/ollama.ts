import pLimit from 'p-limit';

import type { EmbeddingConfig } from '../../types/index.js';
import { RetryExhaustedError, DimensionMismatchError, NonRetryableEmbeddingError } from '../../types/index.js';
import { BaseEmbeddingProvider } from './base.js';

import { acquireGlobalLock } from '../../utils/global-lock.js';

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

const DEFAULT_TIMEOUT_MS = 60_000; // 60 seconds

export class OllamaEmbeddingProvider extends BaseEmbeddingProvider {
  readonly dimensions: number;

  private readonly limit;

  constructor(
    private readonly config: Pick<
      EmbeddingConfig,
      'baseUrl' | 'model' | 'dimensions' | 'maxConcurrency' | 'batchSize' | 'retryCount' | 'retryBaseDelayMs' | 'timeoutMs' | 'ollamaNumThread'
    >,
    private readonly dependencies: OllamaDependencies = defaultDependencies,
  ) {
    super();
    this.dimensions = config.dimensions;
    this.limit = pLimit(config.maxConcurrency);
  }

  async embed(texts: string[]): Promise<number[][]> {
    const batches = this.chunkTexts(texts, this.config.batchSize);
    const lock = await acquireGlobalLock('ollama');

    try {
      const promises = batches.map(async (batch) => this.limit(async () => this.embedBatchWithRetry(batch)));
      const results = await Promise.all(promises);

      return results.flat();
    } finally {
      await lock.release().catch(() => {});
    }
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

    // attempt=0 is the first try, so we allow up to retryCount retries (total attempts: retryCount + 1)
    while (attempt <= this.config.retryCount) {
      try {
        return await this.requestEmbeddings(batch);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (error instanceof DimensionMismatchError) {
          throw error;
        }

        // Non-retryable errors (e.g. HTTP 400 context length) must not be retried,
        // but the pipeline expects RetryExhaustedError to route to DLQ.
        if (error instanceof NonRetryableEmbeddingError) {
          throw new RetryExhaustedError(error.message, 1, { cause: error });
        }

        if (attempt >= this.config.retryCount) {
          break;
        }

        attempt += 1;
        await this.dependencies.sleep(this.config.retryBaseDelayMs * 2 ** (attempt - 1));
      }
    }

    throw new RetryExhaustedError('Failed to fetch embeddings from Ollama', attempt + 1, {
      cause: lastError,
    });
  }

  private async requestEmbeddings(batch: string[]): Promise<number[][]> {
    const timeoutMs = this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
    }

    try {
      const response = await this.dependencies.fetch(new URL('/api/embed', this.config.baseUrl).toString(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.model,
          input: batch,
          truncate: true,
          options: {
            num_thread: this.config.ollamaNumThread,
          },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        // 400 means the input is irrecoverably bad (e.g. context length exceeded).
        // Retrying the same content will never succeed, so surface immediately.
        if (response.status === 400) {
          throw new NonRetryableEmbeddingError(
            `Ollama embed request failed (${response.status}): ${body}`,
          );
        }
        throw new Error(`Ollama embed request failed (${response.status}): ${body}`);
      }

      const payload = (await response.json()) as OllamaEmbedResponse;

      if (payload.embeddings.length !== batch.length) {
        throw new Error(`Ollama returned ${payload.embeddings.length} embeddings for ${batch.length} inputs`);
      }

      for (const vector of payload.embeddings) {
        if (vector.length !== this.dimensions) {
          throw new DimensionMismatchError(
            `Unexpected embedding dimension: expected ${this.dimensions}, received ${vector.length}`,
          );
        }
      }

      return payload.embeddings;
    } finally {
      clearTimeout(timer);
    }
  }
}
