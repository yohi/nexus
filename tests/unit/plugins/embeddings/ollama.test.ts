import { afterEach, describe, expect, it, vi } from 'vitest';

import { RetryExhaustedError } from '../../../../src/types/index.js';
import { OllamaEmbeddingProvider } from '../../../../src/plugins/embeddings/ollama.js';
import { TestEmbeddingProvider } from './test-embedding-provider.js';

describe('OllamaEmbeddingProvider', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns vectors with the configured dimensions for batched embedding', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[1, 2, 3, 4], [4, 3, 2, 1]] }),
    });

    const provider = new OllamaEmbeddingProvider(
      {
        baseUrl: 'http://localhost:11434',
        model: 'nomic-embed-text',
        dimensions: 4,
        maxConcurrency: 2,
        batchSize: 2,
        retryCount: 3,
        retryBaseDelayMs: 1,
      },
      { fetch: fetchMock, sleep: async () => {} },
    );

    const vectors = await provider.embed(['alpha', 'beta']);

    expect(vectors).toEqual([
      [1, 2, 3, 4],
      [4, 3, 2, 1],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries failed requests and throws RetryExhaustedError after max attempts', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'server error',
    });

    const provider = new OllamaEmbeddingProvider(
      {
        baseUrl: 'http://localhost:11434',
        model: 'nomic-embed-text',
        dimensions: 4,
        maxConcurrency: 1,
        batchSize: 1,
        retryCount: 3,
        retryBaseDelayMs: 1,
      },
      { fetch: fetchMock, sleep: async () => {} },
    );

    await expect(provider.embed(['alpha'])).rejects.toBeInstanceOf(RetryExhaustedError);
    // retryCount=3 means 1 initial try + 3 retries = 4 total attempts
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('healthCheck does not consume the concurrency semaphore', async () => {
    let release: (() => void) | undefined;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () =>
              resolve({
                ok: true,
                json: async () => ({ embeddings: [[1, 2, 3, 4]] }),
              });
          }),
      )
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embeddings: [[1, 2, 3, 4]] }),
      });

    const provider = new OllamaEmbeddingProvider(
      {
        baseUrl: 'http://localhost:11434',
        model: 'nomic-embed-text',
        dimensions: 4,
        maxConcurrency: 1,
        batchSize: 1,
        retryCount: 1,
        retryBaseDelayMs: 1,
      },
      { fetch: fetchMock, sleep: async () => {} },
    );

    const pendingEmbed = provider.embed(['alpha']);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const healthy = await provider.healthCheck();
    release?.();
    await pendingEmbed;

    expect(healthy).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('blocks embed requests above maxConcurrency until a slot is released', async () => {
    const order: string[] = [];
    let firstRelease: (() => void) | undefined;

    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            order.push('first-start');
            firstRelease = () => {
              order.push('first-end');
              resolve({
                ok: true,
                json: async () => ({ embeddings: [[1, 2, 3, 4]] }),
              });
            };
          }),
      )
      .mockImplementationOnce(async () => {
        order.push('second-start');
        return {
          ok: true,
          json: async () => ({ embeddings: [[4, 3, 2, 1]] }),
        };
      });

    const provider = new OllamaEmbeddingProvider(
      {
        baseUrl: 'http://localhost:11434',
        model: 'nomic-embed-text',
        dimensions: 4,
        maxConcurrency: 1,
        batchSize: 1,
        retryCount: 1,
        retryBaseDelayMs: 1,
      },
      { fetch: fetchMock, sleep: async () => {} },
    );

    const first = provider.embed(['alpha']);
    const second = provider.embed(['beta']);
    await vi.waitFor(() => expect(order).toEqual(['first-start']));

    firstRelease?.();

    await Promise.all([first, second]);

    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });

  it('aborts hanging fetch after timeoutMs elapses and throws RetryExhaustedError', async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn().mockImplementation(
      (_url: unknown, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
          // intentionally never resolves — simulates Ollama hanging
        }),
    );

    const provider = new OllamaEmbeddingProvider(
      {
        baseUrl: 'http://localhost:11434',
        model: 'nomic-embed-text',
        dimensions: 4,
        maxConcurrency: 1,
        batchSize: 1,
        retryCount: 0,
        retryBaseDelayMs: 1,
        timeoutMs: 5_000,
      },
      { fetch: fetchMock, sleep: async () => {} },
    );

    const pending = provider.embed(['alpha']);
    await vi.runAllTimersAsync();

    await expect(pending).rejects.toBeInstanceOf(RetryExhaustedError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('TestEmbeddingProvider', () => {
  it('returns deterministic 64-dimensional vectors for the same text', async () => {
    const provider = new TestEmbeddingProvider();

    const first = await provider.embed(['same text']);
    const second = await provider.embed(['same text']);

    expect(first).toEqual(second);
    expect(first[0]).toHaveLength(64);
  });
});
