import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { z } from 'zod';
import type { EmbeddingCacheEntry } from '../../../src/types/index.js';
import type { CacheSeedEndpoint } from './cache-seed-target.js';

export type SeedFailureCode = 'cache_identity_mismatch' | 'source_cache_membership' | 'source_vector_invalid' |
  'target_cache_membership' | 'target_readback_mismatch' | 'target_not_empty' | 'target_not_owned' |
  'cache_seed_aborted' | 'cache_seed_deadline' | 'cache_seed_failed' | 'cache_seed_cleanup_failed' | 'empty_cache_recipe';
export class CacheSeedError extends Error {
  constructor(readonly code: SeedFailureCode) { super(code); this.name = 'CacheSeedError'; }
}
export interface CacheTransferBatch { readonly keys: readonly string[]; readonly signal: AbortSignal; }
const vectorSchema = z.array(z.number().finite()).length(128);
const keyRowSchema = z.object({ hash: z.string() }).strict();

function vectorDigest(vector: readonly number[]): string {
  const bytes = Buffer.alloc(vector.length * 8);
  vector.forEach((component, index) => bytes.writeDoubleBE(component, index * 8));
  return createHash('sha256').update(bytes).digest('hex');
}

function exactMembership(values: ReadonlyMap<string, readonly number[]>, keys: readonly string[], code: SeedFailureCode): void {
  const expected = new Set(keys);
  if (values.size !== expected.size || [...values.keys()].some((key) => !expected.has(key))) throw new CacheSeedError(code);
}

export async function transferCacheBatch(source: CacheSeedEndpoint, target: CacheSeedEndpoint,
  batch: Readonly<CacheTransferBatch>): Promise<Map<string, string>> {
  batch.signal.throwIfAborted();
  const vectors = await source.metadataStore.getEmbeddings([...batch.keys]);
  const entries: EmbeddingCacheEntry[] = [];
  const digests = new Map<string, string>();
  try {
    exactMembership(vectors, batch.keys, 'source_cache_membership');
    for (const key of batch.keys) {
      let vector: number[];
      try { vector = vectorSchema.parse(vectors.get(key)); }
      catch { throw new CacheSeedError('source_vector_invalid'); }
      entries.push({ hash: key, vector });
      digests.set(key, vectorDigest(vector));
    }
    batch.signal.throwIfAborted();
    await target.metadataStore.setEmbeddings(entries);
    return digests;
  } finally {
    vectors.clear();
    entries.length = 0;
  }
}

export async function verifyCacheBatch(target: CacheSeedEndpoint, batch: Readonly<CacheTransferBatch>,
  expected: ReadonlyMap<string, string>): Promise<void> {
  batch.signal.throwIfAborted();
  const vectors = await target.metadataStore.getEmbeddings([...batch.keys]);
  try {
    exactMembership(vectors, batch.keys, 'target_readback_mismatch');
    for (const key of batch.keys) {
      let vector: number[];
      try { vector = vectorSchema.parse(vectors.get(key)); }
      catch { throw new CacheSeedError('target_readback_mismatch'); }
      if (vectorDigest(vector) !== expected.get(key)) throw new CacheSeedError('target_readback_mismatch');
    }
    batch.signal.throwIfAborted();
  } finally { vectors.clear(); }
}

export function inspectCacheKeys(endpoint: CacheSeedEndpoint, signal: AbortSignal,
  inspect: (key: string) => void): void {
  signal.throwIfAborted();
  const database = new Database(endpoint.databasePath, { readonly: true, fileMustExist: true });
  try {
    for (const raw of database.prepare('SELECT hash FROM embedding_cache ORDER BY hash').iterate()) {
      signal.throwIfAborted();
      inspect(keyRowSchema.parse(raw).hash);
    }
  } finally { database.close(); }
}
