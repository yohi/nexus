import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createEmbeddingCacheIdentity } from '../../../src/indexer/embedding-cache-identity.js';
import type { EmbeddingConfig } from '../../../src/types/index.js';
import type { FixtureManifest } from './contracts.js';
import { disposeCacheSeedTarget, ownsCacheSeedTarget } from './cache-seed-target.js';
import type { CacheSeedEndpoint } from './cache-seed-target.js';
import { CacheSeedError, inspectCacheKeys, transferCacheBatch, verifyCacheBatch } from './cache-transfer.js';
import type { SeedFailureCode } from './cache-transfer.js';

export { createCacheSeedTarget } from './cache-seed-target.js';
export type { CacheSeedEndpoint, CacheSeedTarget } from './cache-seed-target.js';
const counts = { expectedKeyCount: z.number().int().nonnegative(), verifiedKeyCount: z.number().int().nonnegative(),
  batchLimit: z.literal(512), maxRequestedBatchSize: z.number().int().min(0).max(512),
  durationMs: z.number().finite().nonnegative() };
export const validCacheSeedResultSchema = z.object({ ...counts, status: z.literal('valid'),
  keySetDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().readonly();
export const cacheSeedResultSchema = z.discriminatedUnion('status', [
  validCacheSeedResultSchema.unwrap(),
  z.object({ ...counts, status: z.literal('invalid'), phase: z.literal('setup'), code: z.string().regex(/^[a-z_]{1,64}$/) }).strict(),
]).readonly();
export type CacheSeedResult = z.infer<typeof cacheSeedResultSchema>;

export function expectedCacheKeys(manifest: FixtureManifest, config: Readonly<EmbeddingConfig>): readonly string[] {
  const identity = createEmbeddingCacheIdentity(config);
  return [...new Set(manifest.files.flatMap((file) => [...file.legacyRows, ...file.structuredRows]
    .map((row) => identity.keyFor(row.contentHash))))].sort();
}

function requireCompatibility(source: CacheSeedEndpoint, target: CacheSeedEndpoint): void {
  const probe = 'retrieval-performance-cache-compatibility-v1';
  if (source.embeddingConfig.dimensions !== 128 || target.embeddingConfig.dimensions !== 128 ||
    createEmbeddingCacheIdentity(source.embeddingConfig).keyFor(probe) !==
      createEmbeddingCacheIdentity(target.embeddingConfig).keyFor(probe)) throw new CacheSeedError('cache_identity_mismatch');
}

function failureCode(error: unknown, signal: AbortSignal): SeedFailureCode {
  if (signal.aborted) return signal.reason instanceof Error && signal.reason.name === 'TimeoutError'
    ? 'cache_seed_deadline' : 'cache_seed_aborted';
  return error instanceof CacheSeedError ? error.code : 'cache_seed_failed';
}

export async function seedCompatibleCache(source: CacheSeedEndpoint, target: CacheSeedEndpoint,
  manifest: FixtureManifest, signal: AbortSignal): Promise<CacheSeedResult> {
  const started = performance.now();
  let expectedKeyCount = 0;
  let verifiedKeyCount = 0;
  let maxRequestedBatchSize = 0;
  const resultCounts = () => ({ expectedKeyCount, verifiedKeyCount, batchLimit: 512 as const,
    maxRequestedBatchSize, durationMs: performance.now() - started });
  if (!ownsCacheSeedTarget(target)) return cacheSeedResultSchema.parse({ status: 'invalid', phase: 'setup',
    code: 'target_not_owned', ...resultCounts() });
  try {
    signal.throwIfAborted();
    requireCompatibility(source, target);
    if (source.metadataStore === target.metadataStore || source.databasePath === target.databasePath) throw new CacheSeedError('cache_identity_mismatch');
    inspectCacheKeys(target, signal, () => { throw new CacheSeedError('target_not_empty'); });
    const keys = expectedCacheKeys(manifest, source.embeddingConfig);
    expectedKeyCount = keys.length;
    if (keys.length === 0) throw new CacheSeedError('empty_cache_recipe');
    const verified = new Set<string>();
    for (let offset = 0; offset < keys.length; offset += 512) {
      signal.throwIfAborted();
      requireCompatibility(source, target);
      const batch = { keys: keys.slice(offset, offset + 512), signal };
      maxRequestedBatchSize = Math.max(maxRequestedBatchSize, batch.keys.length);
      const digests = await transferCacheBatch(source, target, batch);
      try { await verifyCacheBatch(target, batch, digests); }
      finally { digests.clear(); }
      for (const key of batch.keys) verified.add(key);
      verifiedKeyCount = verified.size;
    }
    const expected = new Set(keys);
    let actualKeys = 0;
    inspectCacheKeys(target, signal, (key) => {
      if (!expected.has(key) || !verified.has(key)) throw new CacheSeedError('target_cache_membership');
      actualKeys += 1;
    });
    if (actualKeys !== expected.size || verified.size !== expected.size) throw new CacheSeedError('target_cache_membership');
    signal.throwIfAborted();
    const keySetDigest = createHash('sha256').update(JSON.stringify(keys)).digest('hex');
    return cacheSeedResultSchema.parse({ status: 'valid', keySetDigest, ...resultCounts() });
  } catch (error) {
    let code = failureCode(error, signal);
    const closed = await Promise.allSettled([source.metadataStore.close(), target.metadataStore.close()]);
    try { await disposeCacheSeedTarget(target); }
    catch { code = 'cache_seed_cleanup_failed'; }
    if (closed.some((item) => item.status === 'rejected')) code = 'cache_seed_cleanup_failed';
    return cacheSeedResultSchema.parse({ status: 'invalid', phase: 'setup', code, ...resultCounts() });
  }
}
