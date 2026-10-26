import { createHash } from 'node:crypto';
import type { EmbeddingConfig, EmbeddingProvider } from '../../../src/types/index.js';

export const syntheticEmbeddingConfig = Object.freeze({
  provider: 'test', model: 'nexus-synthetic-sha256-v1', dimensions: 128,
  maxConcurrency: 1, batchSize: 64, retryCount: 0, retryBaseDelayMs: 0,
}) satisfies Readonly<EmbeddingConfig>;

type DistributionFailure = 'invalid_dimensions' | 'non_finite_vector' | 'invalid_norm' |
  'vector_collision' | 'empty_distribution' | 'zero_component_variance';

export class SyntheticDistributionError extends Error {
  constructor(readonly code: DistributionFailure) {
    super(code);
    this.name = 'SyntheticDistributionError';
  }
}

function vectorFor(text: string): number[] {
  const vector: number[] = [];
  for (let counter = 0; counter < 16; counter += 1) {
    const block = Buffer.alloc(4);
    block.writeUInt32BE(counter);
    const digest = createHash('sha256')
      .update('nexus-synthetic-sha256-v1', 'utf8').update(Buffer.from([0]))
      .update(block).update(text, 'utf8').digest();
    for (let offset = 0; offset < digest.length; offset += 4) {
      vector.push((digest.readUInt32BE(offset) + 0.5) / 0x1_0000_0000 * 2 - 1);
    }
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || norm === 0) throw new SyntheticDistributionError('invalid_norm');
  return vector.map((component) => component / norm);
}

export function createSyntheticProvider(): EmbeddingProvider {
  return {
    dimensions: 128,
    embed(texts, signal) {
      return Promise.resolve().then(() => {
        signal?.throwIfAborted();
        return texts.map((text) => {
          signal?.throwIfAborted();
          return vectorFor(text);
        });
      });
    },
    healthCheck() { return Promise.resolve(true); },
  };
}

export function validateVectorDistribution(vectors: Iterable<readonly number[]>): void {
  const digests = new Set<string>();
  const minima = Array.from({ length: 128 }, () => Infinity);
  const maxima = Array.from({ length: 128 }, () => -Infinity);
  for (const vector of vectors) {
    if (vector.length !== 128) throw new SyntheticDistributionError('invalid_dimensions');
    if (!vector.every(Number.isFinite)) throw new SyntheticDistributionError('non_finite_vector');
    if (Math.abs(Math.hypot(...vector) - 1) > 1e-6) throw new SyntheticDistributionError('invalid_norm');
    const digest = createHash('sha256').update(JSON.stringify(vector)).digest('hex');
    if (digests.has(digest)) throw new SyntheticDistributionError('vector_collision');
    digests.add(digest);
    vector.forEach((value, index) => {
      minima[index] = Math.min(minima[index] ?? Infinity, value);
      maxima[index] = Math.max(maxima[index] ?? -Infinity, value);
    });
  }
  if (digests.size < 2) throw new SyntheticDistributionError('empty_distribution');
  if (minima.some((value, index) => value === maxima[index])) {
    throw new SyntheticDistributionError('zero_component_variance');
  }
}

export function validateSyntheticDistribution(texts: readonly string[]): void {
  function* vectors() {
    for (const text of new Set(texts)) yield vectorFor(text);
  }
  validateVectorDistribution(vectors());
}
