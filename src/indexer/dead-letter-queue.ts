import { randomUUID } from 'node:crypto';

import { computeFileHashStreaming } from './hash.js';
import type { DeadLetterEntry, IMetadataStore } from '../types/index.js';

export interface RecoverySweepResult {
  retried: number;
  removed: number;
  skipped: number;
}

export interface DeadLetterQueueOptions {
  metadataStore: IMetadataStore;
  maxEntries?: number;
  ttlMs?: number;
  now?: () => Date;
  embeddingHealthy?: () => Promise<boolean>;
  computeFileHash?: (filePath: string) => Promise<string>;
  reprocess?: (entry: DeadLetterEntry) => Promise<void>;
  logger?: Pick<Console, 'warn' | 'error'>;
}

export class DeadLetterQueue {
  private readonly maxEntries: number;

  private readonly ttlMs: number;

  private readonly now: () => Date;

  private readonly embeddingHealthy: () => Promise<boolean>;

  private readonly computeFileHash: (filePath: string) => Promise<string>;

  private readonly reprocess: (entry: DeadLetterEntry) => Promise<void>;

  private readonly logger: Pick<Console, 'warn' | 'error'>;

  private readonly entries = new Map<string, DeadLetterEntry>();

  private loaded = false;

  constructor(private readonly options: DeadLetterQueueOptions) {
    this.maxEntries = options.maxEntries ?? 1000;
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
    this.embeddingHealthy = options.embeddingHealthy ?? (async () => true);
    this.computeFileHash = options.computeFileHash ?? computeFileHashStreaming;
    this.reprocess = options.reprocess ?? (async () => undefined);
    this.logger = options.logger ?? console;
  }

  async load(): Promise<void> {
    const persisted = await this.options.metadataStore.getDeadLetterEntries();
    this.entries.clear();
    for (const entry of persisted) {
      this.entries.set(entry.id, entry);
    }
    await this.trimToCapacity();
    this.loaded = true;
  }

  async enqueue(input: Pick<DeadLetterEntry, 'filePath' | 'contentHash' | 'errorMessage' | 'attempts'>): Promise<DeadLetterEntry> {
    const timestamp = this.now().toISOString();

    const existingEntry = [...this.entries.values()].find((e) => e.filePath === input.filePath);

    const entry: DeadLetterEntry = {
      id: existingEntry?.id ?? randomUUID(),
      filePath: input.filePath,
      contentHash: input.contentHash,
      errorMessage: input.errorMessage,
      attempts: input.attempts,
      createdAt: existingEntry?.createdAt ?? timestamp,
      updatedAt: timestamp,
      lastRetryAt: existingEntry?.lastRetryAt ?? null,
    };

    await this.options.metadataStore.upsertDeadLetterEntries([entry]);
    this.entries.set(entry.id, entry);
    await this.trimToCapacity();
    return entry;
  }

  /**
   * Returns an in-memory snapshot of current entries mapped filePath → errorMessage.
   * NOTE: only reflects entries loaded into memory. Call `load()` (or trigger
   * `purgeExpired()` / `recoverySweep()`) before calling this if you need a
   * view that includes all persisted entries.
   */
  snapshot(): ReadonlyMap<string, string> {
    return new Map(
      [...this.entries.values()]
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((entry) => [entry.filePath, entry.errorMessage]),
    );
  }

  async purgeExpired(): Promise<number> {
    await this.ensureLoaded();
    const cutoff = this.now().getTime() - this.ttlMs;
    const expiredIds = [...this.entries.values()]
      .filter((entry) => new Date(entry.createdAt).getTime() < cutoff)
      .map((entry) => entry.id);

    if (expiredIds.length === 0) {
      return 0;
    }

    await this.options.metadataStore.removeDeadLetterEntries(expiredIds);
    for (const id of expiredIds) {
      this.entries.delete(id);
    }

    return expiredIds.length;
  }

  async recoverySweep(): Promise<RecoverySweepResult> {
    await this.ensureLoaded();
    if (!(await this.embeddingHealthy())) {
      return { retried: 0, removed: 0, skipped: this.entries.size };
    }

    let retried = 0;
    let removed = 0;
    let skipped = 0;

    for (const entry of [...this.entries.values()]) {
      try {
        const currentHash = await this.computeFileHash(entry.filePath);
        if (currentHash !== entry.contentHash) {
          this.logger.warn(`Dropping stale DLQ entry for ${entry.filePath}: hash mismatch`);
          await this.removeEntries([entry.id]);
          removed += 1;
          continue;
        }

        await this.reprocess(entry);
        await this.removeEntries([entry.id]);
        retried += 1;
        removed += 1;
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code === 'ENOENT') {
          await this.removeEntries([entry.id]);
          removed += 1;
          continue;
        }

        skipped += 1;
        this.logger.error(`Failed to recover DLQ entry for ${entry.filePath}`, error);
      }
    }

    return { retried, removed, skipped };
  }

  private async removeEntries(ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    await this.options.metadataStore.removeDeadLetterEntries(ids);
    for (const id of ids) {
      this.entries.delete(id);
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.load();
    }
  }

  private async trimToCapacity(): Promise<void> {
    const removedIds: string[] = [];

    while (this.entries.size > this.maxEntries) {
      const oldestId = this.entries.keys().next().value as string | undefined;
      if (oldestId === undefined) {
        break;
      }
      this.entries.delete(oldestId);
      removedIds.push(oldestId);
    }

    if (removedIds.length > 0) {
      await this.options.metadataStore.removeDeadLetterEntries(removedIds);
    }
  }
}
