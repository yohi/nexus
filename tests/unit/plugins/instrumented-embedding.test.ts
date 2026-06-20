import { describe, it, expect, vi } from 'vitest';
import { InstrumentedEmbeddingProvider } from '../../../src/plugins/embeddings/instrumented.js';
import type { EmbeddingProvider } from '../../../src/types/index.js';
import type { MetricsHooks } from '../../../src/observability/types.js';

describe('InstrumentedEmbeddingProvider', () => {
  it('instruments embed calls reporting performance to metricsHooks', async () => {
    const mockInner: EmbeddingProvider = {
      dimensions: 128,
      healthCheck: vi.fn().mockResolvedValue(true),
      embed: vi.fn().mockResolvedValue([[0.1, 0.2]]),
    };
    const mockHooks: MetricsHooks = {
      onEmbeddingRequest: vi.fn(),
    } as any;

    const provider = new InstrumentedEmbeddingProvider(mockInner, mockHooks, 'test-provider');
    const result = await provider.embed(['hello']);

    expect(result).toEqual([[0.1, 0.2]]);
    expect(mockInner.embed).toHaveBeenCalledWith(['hello']);
    expect(mockHooks.onEmbeddingRequest).toHaveBeenCalledWith(
      'test-provider',
      'success',
      expect.any(Number),
      1,
    );
  });

  it('instruments failed embed calls reporting error status', async () => {
    const mockInner: EmbeddingProvider = {
      dimensions: 128,
      healthCheck: vi.fn().mockResolvedValue(true),
      embed: vi.fn().mockRejectedValue(new Error('Embedding failed')),
    };
    const mockHooks: MetricsHooks = {
      onEmbeddingRequest: vi.fn(),
    } as any;

    const provider = new InstrumentedEmbeddingProvider(mockInner, mockHooks, 'test-provider');
    await expect(provider.embed(['hello'])).rejects.toThrow('Embedding failed');
    expect(mockHooks.onEmbeddingRequest).toHaveBeenCalledWith(
      'test-provider',
      'error',
      expect.any(Number),
      1,
    );
  });
});
