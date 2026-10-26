import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMetadataStore } from '../../../src/storage/metadata-store.js';
import type { EmbeddingConfig } from '../../../src/types/index.js';
import { syntheticEmbeddingConfig } from './synthetic-provider.js';

export interface CacheSeedEndpoint {
  readonly metadataStore: SqliteMetadataStore;
  readonly embeddingConfig: Readonly<EmbeddingConfig>;
  readonly databasePath: string;
}
export interface CacheSeedTarget extends CacheSeedEndpoint {
  readonly projectRoot: string;
  readonly dispose: () => Promise<void>;
}
type OwnedTarget = { readonly root: string; readonly databasePath: string; disposal?: Promise<void> };
const targets = new WeakMap<SqliteMetadataStore, OwnedTarget>();

export function ownsCacheSeedTarget(endpoint: CacheSeedEndpoint): boolean {
  return targets.get(endpoint.metadataStore)?.databasePath === endpoint.databasePath;
}

export function disposeCacheSeedTarget(endpoint: CacheSeedEndpoint): Promise<void> {
  const owned = targets.get(endpoint.metadataStore);
  if (owned === undefined || owned.databasePath !== endpoint.databasePath) return Promise.resolve();
  owned.disposal ??= (async () => {
    try { await endpoint.metadataStore.close(); }
    finally { await rm(owned.root, { recursive: true, force: true }); targets.delete(endpoint.metadataStore); }
  })();
  return owned.disposal;
}

export async function createCacheSeedTarget(
  embeddingConfig: Readonly<EmbeddingConfig> = syntheticEmbeddingConfig,
): Promise<Readonly<CacheSeedTarget>> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'nexus-performance-cache-')));
  let metadataStore: SqliteMetadataStore | undefined;
  try {
    const projectRoot = join(root, 'source');
    const storageRoot = join(root, 'source.nexus-perf-state');
    await mkdir(projectRoot);
    await mkdir(storageRoot);
    const databasePath = join(storageRoot, 'metadata.db');
    const store = new SqliteMetadataStore({ databasePath });
    metadataStore = store;
    await store.initialize();
    targets.set(store, { root, databasePath });
    const endpoint: CacheSeedTarget = { metadataStore: store, embeddingConfig: Object.freeze({ ...embeddingConfig }),
      databasePath, projectRoot, dispose: () => disposeCacheSeedTarget(endpoint) };
    return Object.freeze(endpoint);
  } catch (error) {
    try { await metadataStore?.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
    throw error;
  }
}
