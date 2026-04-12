import { describe, expect, it, vi } from 'vitest';

import { OpenAICompatEmbeddingProvider, EmbedError } from '../../../../src/plugins/embeddings/openai-compat.js';
import { RetryExhaustedError, DimensionMismatchError } from '../../../../src/types/index.js';

describe('OpenAICompatEmbeddingProvider', () => {
  const mockConfig = {
    baseUrl: 'https://api.openai.com',
    apiKey: 'sk-test-key',
    model: 'text-embedding-3-small',
    dimensions: 2,
    maxConcurrency: 1,
    batchSize: 2,
    retryCount: 3,
    retryBaseDelayMs: 10,
  };

  it('embeds texts successfully via OpenAI API', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { embedding: [0.1, 0.2] },
          { embedding: [0.3, 0.4] },
        ],
      }),
    });

    const provider = new OpenAICompatEmbeddingProvider(mockConfig, {
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const result = await provider.embed(['text1', 'text2']);

    expect(result).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(mockFetch).toHaveBeenCalledOnce();
    
    const callArgs = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(callArgs[0]).toBe('https://api.openai.com/v1/embeddings');
    expect(callArgs[1].headers).toHaveProperty('Authorization', 'Bearer sk-test-key');
    expect(JSON.parse(callArgs[1].body as string)).toEqual({
      model: 'text-embedding-3-small',
      input: ['text1', 'text2'],
      dimensions: 2,
    });
  });

  it('throws EmbedError immediately if dimensions are not positive', async () => {
    const provider = new OpenAICompatEmbeddingProvider({ ...mockConfig, dimensions: 0 });
    await expect(provider.embed(['text1'])).rejects.toThrow('Embedding dimensions must be a positive integer');
  });

  it('retries on failure and succeeds', async () => {
    let attempts = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      attempts += 1;
      if (attempts < 3) {
        return { ok: false, status: 500, text: async () => 'Internal Server Error' };
      }
      return {
        ok: true,
        json: async () => ({
          data: [{ embedding: [0.5, 0.6] }],
        }),
      };
    });

    const mockSleep = vi.fn();

    const provider = new OpenAICompatEmbeddingProvider(mockConfig, {
      fetch: mockFetch,
      sleep: mockSleep,
    });

    const result = await provider.embed(['text1']);

    expect(result).toEqual([[0.5, 0.6]]);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockSleep).toHaveBeenCalledTimes(2);
  });

  it('throws RetryExhaustedError when all retries fail', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => 'Too Many Requests',
    });

    const provider = new OpenAICompatEmbeddingProvider(mockConfig, {
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const retryCount = mockConfig.retryCount;
    await expect(provider.embed(['text1'])).rejects.toThrow(RetryExhaustedError);
    // retryCount=3 means 1 initial try + 3 retries = 4 total attempts
    expect(mockFetch).toHaveBeenCalledTimes(retryCount + 1);
  });

  it('throws EmbedError immediately on 401 Unauthorized', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    const provider = new OpenAICompatEmbeddingProvider(mockConfig, {
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const promise = provider.embed(['text1']);
    await expect(promise).rejects.toThrow(EmbedError);
    await expect(promise).rejects.toThrow(/401/);
    expect(mockFetch).toHaveBeenCalledTimes(1); // No retry
  });

  it('throws DimensionMismatchError immediately if returned dimensions do not match', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ embedding: [0.1, 0.2, 0.3] }], // 3 dimensions instead of 2
      }),
    });

    const provider = new OpenAICompatEmbeddingProvider(mockConfig, {
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const promise = provider.embed(['text1']);
    await expect(promise).rejects.toThrow(DimensionMismatchError);
    await expect(promise).rejects.toThrow(/Unexpected embedding dimension/);
    expect(mockFetch).toHaveBeenCalledTimes(1); // No retry
  });

  it('throws EmbedError immediately if returned embedding count does not match input count', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{ embedding: [0.1, 0.2] }], // Only 1 embedding for 2 inputs
      }),
    });

    const provider = new OpenAICompatEmbeddingProvider(mockConfig, {
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const promise = provider.embed(['text1', 'text2']);
    await expect(promise).rejects.toThrow(EmbedError);
    await expect(promise).rejects.toThrow(/returned 1 embeddings for 2 inputs/);
    expect(mockFetch).toHaveBeenCalledTimes(1); // No retry
  });

  it('returns true from healthCheck when API is reachable', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    const provider = new OpenAICompatEmbeddingProvider(mockConfig, {
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const isHealthy = await provider.healthCheck();
    expect(isHealthy).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith('https://api.openai.com/v1/models', expect.objectContaining({
      headers: { Authorization: 'Bearer sk-test-key' }
    }));
  });

  it('returns false from healthCheck when API is unreachable', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const provider = new OpenAICompatEmbeddingProvider(mockConfig, {
      fetch: mockFetch,
      sleep: vi.fn(),
    });

    const isHealthy = await provider.healthCheck();
    expect(isHealthy).toBe(false);
  });
});
