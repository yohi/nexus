import { randomUUID } from 'node:crypto';

import { computeFileHashStreaming } from './hash.js';
import type { DeadLetterEntry, IMetadataStore } from '../types/index.js';

export interface RecoverySweepResult {
  retried: number;
  purged: number;
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

  private recoveryRunning = false;

  private recoveryInterval: ReturnType<typeof setInterval> | undefined;

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
    await this.ensureLoaded();
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
    if (this.recoveryRunning) {
      return { retried: 0, purged: 0, skipped: 0 };
    }

    this.recoveryRunning = true;
    try {
      await this.ensureLoaded();
      if (!(await this.embeddingHealthy())) {
        return { retried: 0, purged: 0, skipped: this.entries.size };
      }

      let retried = 0;
      let purged = 0;
      let skipped = 0;

      for (const entry of [...this.entries.values()]) {
        try {
          const currentHash = await this.computeFileHash(entry.filePath);
          if (currentHash !== entry.contentHash) {
            this.logger.warn(`Dropping stale DLQ entry for ${entry.filePath}: hash mismatch`);
            await this.removeEntries([entry.id]);
            purged += 1;
            continue;
          }

          await this.reprocess(entry);
          await this.removeEntries([entry.id]);
          retried += 1;
        } catch (error) {
          const err = error as NodeJS.ErrnoException;
          if (err.code === 'ENOENT') {
            await this.removeEntries([entry.id]);
            purged += 1;
            continue;
          }

          skipped += 1;
          this.logger.error(`Failed to recover DLQ entry for ${entry.filePath}`, error);
        }
      }

      return { retried, purged, skipped };
    } finally {
      this.recoveryRunning = false;
    }
  }

  startRecoveryLoop(intervalMs = 60_000): () => void {
    if (this.recoveryInterval !== undefined) {
      this.logger.warn('DLQ recovery loop is already running. Ignoring duplicate start.');
      return () => undefined;
    }

    this.recoveryInterval = setInterval(() => {
      void this.recoverySweep().catch((error) => {
        this.logger.error('DLQ recovery sweep failed', error);
      });
    }, intervalMs);

    return () => {
      if (this.recoveryInterval !== undefined) {
        clearInterval(this.recoveryInterval);
        this.recoveryInterval = undefined;
      }
    };
  }

  async removeByFilePath(filePath: string): Promise<void> {
    await this.ensureLoaded();
    const idsToRemove = [...this.entries.values()]
      .filter((entry) => entry.filePath === filePath)
      .map((entry) => entry.id);
    await this.removeEntries(idsToRemove);
  }

  async removeByPathPrefix(prefix: string): Promise<void> {
    await this.ensureLoaded();
    const idsToRemove = [...this.entries.values()]
      .filter((entry) => {
        const matchesPrefix =
          entry.filePath === prefix ||
          entry.filePath.startsWith(prefix.endsWith('/') ? prefix : prefix + '/');
        return matchesPrefix;
      })
      .map((entry) => entry.id);
    await this.removeEntries(idsToRemove);
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
    if (this.entries.size <= this.maxEntries) {
      return;
    }

    const sortedEntries = [...this.entries.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const toRemove = sortedEntries.slice(0, this.entries.size - this.maxEntries);
    const removedIds = toRemove.map((e) => e.id);

    for (const id of removedIds) {
      this.entries.delete(id);
    }

    await this.options.metadataStore.removeDeadLetterEntries(removedIds);
  }
}
