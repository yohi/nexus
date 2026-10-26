import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { EmbeddingProvider } from '../../../../src/types/index.js';
import { createSyntheticProvider, syntheticEmbeddingConfig, validateSyntheticDistribution,
  validateVectorDistribution } from '../../../benchmarks/performance/synthetic-provider.js';

describe('fixed synthetic embeddings', () => {
  it('keeps identical text stable across batches and independent providers', async () => {
    const first = createSyntheticProvider();
    const second = createSyntheticProvider();
    const [a, b, c] = await Promise.all([first.embed(['same']), first.embed(['other', 'same']), second.embed(['same'])]);
    expect(a[0]).toEqual(b[1]);
    expect(a).toEqual(c);
    expect(syntheticEmbeddingConfig).toMatchObject({ provider: 'test', model: 'nexus-synthetic-sha256-v1', dimensions: 128 });
    expect(await first.healthCheck()).toBe(true);
  });

  it('rejects an aborted embedding request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(createSyntheticProvider().embed(['text'], controller.signal)).rejects.toThrow();
  });

  it('emits 128 finite components with unit L2 norm', async () => {
    const vectors = await createSyntheticProvider().embed(['', 'preflight-0', '日本語']);
    for (const vector of vectors) {
      expect(vector).toHaveLength(128);
      expect(vector.every(Number.isFinite)).toBe(true);
      expect(Math.abs(Math.hypot(...vector) - 1)).toBeLessThan(1e-6);
    }
  });

  it('accepts 128 distinct preflight inputs with variance in every component', () => {
    const texts = Array.from({ length: 128 }, (_, index) => `preflight-${index}`);
    expect(() => validateSyntheticDistribution(texts)).not.toThrow();
  });

  it('rejects a provider that returns identical normalized vectors', async () => {
    const provider: EmbeddingProvider = {
      dimensions: 128,
      embed: (texts) => Promise.resolve(texts.map(() => [1, ...Array.from({ length: 127 }, () => 0)])),
      healthCheck: () => Promise.resolve(true),
    };
    const vectors = await provider.embed(Array.from({ length: 128 }, (_, index) => `preflight-${index}`));
    expect(() => validateVectorDistribution(vectors)).toThrow('vector_collision');
  });

  it.each([
    { vectors: [] }, { vectors: [[0]] },
    { vectors: [Array.from({ length: 128 }, () => NaN)] },
    { vectors: [Array.from({ length: 128 }, () => 0)] },
  ])(
    'rejects invalid vector corpus %j', ({ vectors }) => {
      expect(() => validateVectorDistribution(vectors)).toThrow();
    },
  );

  it.each([
    ['', '8e17a5169c8cdc7f3cf97c7955e698f5a2bb1d7d1df75b481fd8a683cbe61e4c'],
    ['preflight-0', '405a515e0bc6e144d56516d7b2a195d20949336c062236b1e3759077a996efd9'],
    ['日本語', 'fbec88e5e8ae64eba081ae75fad89d604d04145b876122669b07774ee4880577'],
  ])('matches independently derived reference for %j at twelve decimal places', async (text, reference) => {
    const vectors = await createSyntheticProvider().embed([text]);
    const vector = vectors[0];
    if (vector === undefined) throw new Error('vector required');
    const actual = createHash('sha256').update(vector.map((component) => component.toFixed(12)).join(',')).digest('hex');
    expect(actual).toBe(reference);
  });
});
