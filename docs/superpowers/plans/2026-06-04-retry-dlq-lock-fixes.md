# Retry/DLQ/Lock Resilience Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the load-amplification feedback loop caused by double-layered retry + unbounded DLQ recovery, add process-level multi-instance prevention, and document CPU concurrency tuning.

**Architecture:** Four fixes applied in dependency order: (1) Remove redundant outer retry in pipeline → (2) Add recovery-attempt cap + wire TTL purge in DLQ → (3) Add PID-file lock for single-instance guarantee → (4) Document CPU concurrency config. Issues 1+2 are tightly coupled (same load-amplification root cause). Issue 3 is independent. Issue 4 is documentation-only.

**Tech Stack:** TypeScript (ESM), vitest, better-sqlite3, Node.js >=24, p-limit

---

## File Structure

| Action | Path | Responsibility |
|--------|------|---------------|
| Modify | `src/indexer/pipeline.ts` | Remove `embedWithRetry`, call provider directly |
| Modify | `src/indexer/dead-letter-queue.ts` | Add `maxRecoveryAttempts`, increment on failure, abandon cap, wire `purgeExpired` |
| Modify | `src/types/index.ts` | Add `recoveryAttempts` to `DeadLetterEntry` |
| Modify | `src/storage/metadata-store.ts` | Idempotent schema migration for `recovery_attempts` column |
| Modify | `src/observability/types.ts` | Extend `onRecoverySweepComplete` with `abandoned` |
| Modify | `src/observability/metrics-collector.ts` | Handle new `abandoned` parameter |
| Create | `src/server/process-lock.ts` | PID-file lock acquire/release/stale-check |
| Modify | `src/bin/nexus.ts` | Acquire lock before runtime init, release on shutdown |
| Modify | `docs/configuration.md` | CPU concurrency recommendation |
| Modify | `tests/unit/indexer/pipeline.test.ts` | Adjust for removed outer retry |
| Modify | `tests/unit/indexer/dead-letter-queue.test.ts` | Test recovery cap + abandon |
| Create | `tests/unit/server/process-lock.test.ts` | Test lock acquire/stale/release |
| Modify | `tests/unit/observability/metrics-collector.test.ts` | Update hook call signature |
| Modify | `tests/integration/observability-hooks.test.ts` | Update hook expectations |
| Modify | `tests/integration/observability/metrics-e2e.test.ts` | Update hook wiring |

---

### Task 1: Remove outer retry from IndexPipeline (test)

**Files:**
- Modify: `tests/unit/indexer/pipeline.test.ts`
- Modify: `src/indexer/pipeline.ts:366-386`

- [ ] **Step 1: Verify existing test still passes (baseline)**

Run: `npx vitest run tests/unit/indexer/pipeline.test.ts -t "tracks skipped files"`
Expected: PASS — confirms current behavior before refactoring.

- [ ] **Step 2: Delete `embedWithRetry` method from pipeline.ts**

Replace lines 366-386 of `src/indexer/pipeline.ts`:

```typescript
  // DELETE the entire embedWithRetry method (lines 366-386)
```

And modify line 343 in `indexFile`:

```typescript
  private async indexFile(filePath: string, content: string, contentHash: string): Promise<number> {
    this.safeLogProgress(`Indexing: ${filePath}`, filePath);
    const chunks = await this.options.chunker.chunkFiles([
      {
        filePath,
        language: this.detectLanguage(filePath),
        content,
      },
    ]);

    const embeddings = await this.options.embeddingProvider.embed(chunks.map((chunk) => chunk.content));
    await this.options.vectorStore.upsertChunks(chunks, embeddings, [filePath]);
    await this.merkleTree.update(filePath, contentHash);
    this.skippedFiles.delete(filePath);

    this.safeLogProgress(`Finished indexing: ${filePath} (${chunks.length} chunks)`, filePath);

    return chunks.length;
  }
```

- [ ] **Step 3: Run test to verify it still passes**

Run: `npx vitest run tests/unit/indexer/pipeline.test.ts -t "tracks skipped files"`
Expected: PASS — `FailingEmbeddingProvider` throws `RetryExhaustedError` directly, the `processEvents` catch (L186) still catches it by `error.name === 'RetryExhaustedError'` and routes to DLQ with `attempts: 3`.

- [ ] **Step 4: Run full pipeline test suite**

Run: `npx vitest run tests/unit/indexer/pipeline.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/indexer/pipeline.ts tests/unit/indexer/pipeline.test.ts
git commit -m "fix(pipeline): remove redundant outer retry loop

The embedding providers already implement retry with exponential backoff.
The outer embedWithRetry in IndexPipeline caused up to 4×3=12 total
attempts per file, with worst-case ~12min blocking before DLQ routing.

Now the provider's RetryExhaustedError propagates directly to the
processEvents handler which routes failed files to the DLQ immediately."
```

---

### Task 2: Remove unused `embedWithRetry` import in pipeline.ts

**Files:**
- Modify: `src/indexer/pipeline.ts`

- [ ] **Step 1: Check for stale references**

The `RetryExhaustedError` import (line 21) is still needed for the `processEvents` catch block (L186). No other code in pipeline.ts references `embedWithRetry`. Verify no unused imports remain.

Run: `npx vitest run tests/unit/indexer/pipeline.test.ts`
Expected: PASS.

- [ ] **Step 2: Run TypeScript type check**

Run: `npx tsc -p tsconfig.build.json --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit (if any cleanup was needed)**

```bash
git add src/indexer/pipeline.ts
git commit -m "refactor(pipeline): remove dead code from embedWithRetry removal"
```

---

### Task 3: Add `recoveryAttempts` to DeadLetterEntry type

**Files:**
- Modify: `src/types/index.ts:255-264`

- [ ] **Step 1: Add recoveryAttempts field to DeadLetterEntry interface**

Modify `src/types/index.ts` lines 255-264:

```typescript
export interface DeadLetterEntry {
  id: string;
  filePath: string;
  contentHash: string;
  errorMessage: string;
  attempts: number;
  recoveryAttempts: number;
  createdAt: string;
  updatedAt: string;
  lastRetryAt: string | null;
}
```

- [ ] **Step 2: Run type check to find all breakage points**

Run: `npx tsc -p tsconfig.build.json --noEmit 2>&1 | head -50`
Expected: Type errors in metadata-store.ts (SELECT doesn't include `recoveryAttempts`), dead-letter-queue.ts (enqueue doesn't set it), and tests that construct DeadLetterEntry objects.

- [ ] **Step 3: Commit (type-level change only, intentionally breaking)**

```bash
git add src/types/index.ts
git commit -m "feat(types): add recoveryAttempts to DeadLetterEntry

Breaking change at type level — subsequent commits will fix all
consumers (metadata store, DLQ, tests)."
```

---

### Task 4: Idempotent schema migration for `recovery_attempts` column

**Files:**
- Modify: `src/storage/metadata-store.ts:38-75` (initialize method)
- Modify: `src/storage/metadata-store.ts:354-414` (upsert + get queries)

- [ ] **Step 1: Add migration logic to initialize()**

After the existing `CREATE TABLE IF NOT EXISTS dead_letter_queue` block (line 74), add:

```typescript
    // Idempotent migration: add recovery_attempts column if missing
    const columns = this.db.pragma('table_info(dead_letter_queue)') as Array<{ name: string }>;
    const hasRecoveryAttempts = columns.some((col) => col.name === 'recovery_attempts');
    if (!hasRecoveryAttempts) {
      this.db.exec('ALTER TABLE dead_letter_queue ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0');
    }
```

- [ ] **Step 2: Update upsert SQL to include recovery_attempts**

Modify `upsertDeadLetterEntries` (line 355):

```typescript
  async upsertDeadLetterEntries(entries: DeadLetterEntry[]): Promise<void> {
    const statement = this.db.prepare(`
      INSERT INTO dead_letter_queue (
        id, file_path, content_hash, error_message, attempts, recovery_attempts, created_at, updated_at, last_retry_at
      ) VALUES (
        @id, @filePath, @contentHash, @errorMessage, @attempts, @recoveryAttempts, @createdAt, @updatedAt, @lastRetryAt
      )
      ON CONFLICT(id) DO UPDATE SET
        file_path = excluded.file_path,
        content_hash = excluded.content_hash,
        error_message = excluded.error_message,
        attempts = excluded.attempts,
        recovery_attempts = excluded.recovery_attempts,
        updated_at = excluded.updated_at,
        last_retry_at = excluded.last_retry_at
    `);

    await executeBatchedWithYield({
      items: entries,
      batchSize: this.batchSize,
      executeBatch: async (batch) => {
        await this.asyncBoundary();
        const transaction = this.db.transaction((rows: DeadLetterEntry[]) => {
          for (const entry of rows) {
            statement.run(entry);
          }
        });

        transaction(batch);
      },
      yieldAfterBatch: this.asyncBoundary,
    });
  }
```

- [ ] **Step 3: Update SELECT query in getDeadLetterEntries**

Modify `getDeadLetterEntries` (line 398):

```typescript
  async getDeadLetterEntries(): Promise<DeadLetterEntry[]> {
    await this.asyncBoundary();
    return this.db
      .prepare(
        `SELECT id,
                file_path AS filePath,
                content_hash AS contentHash,
                error_message AS errorMessage,
                attempts,
                recovery_attempts AS recoveryAttempts,
                created_at AS createdAt,
                updated_at AS updatedAt,
                last_retry_at AS lastRetryAt
         FROM dead_letter_queue
         ORDER BY created_at ASC`,
      )
      .all() as DeadLetterEntry[];
  }
```

- [ ] **Step 4: Run type check**

Run: `npx tsc -p tsconfig.build.json --noEmit 2>&1 | head -30`
Expected: Remaining errors in dead-letter-queue.ts and test files (fixed in next tasks).

- [ ] **Step 5: Commit**

```bash
git add src/storage/metadata-store.ts
git commit -m "feat(storage): add recovery_attempts column with idempotent migration

Uses PRAGMA table_info to check column existence before ALTER TABLE,
ensuring compatibility with existing databases without a migration framework."
```

---

### Task 5: Update DeadLetterQueue to support recovery attempt cap

**Files:**
- Modify: `src/indexer/dead-letter-queue.ts`

- [ ] **Step 1: Add maxRecoveryAttempts option and abandoned tracking**

Add to `DeadLetterQueueOptions` interface (after line 17):

```typescript
  maxRecoveryAttempts?: number;
```

Add to constructor (after line 54):

```typescript
    this.maxRecoveryAttempts = options.maxRecoveryAttempts ?? 5;
```

Add private field (after line 29):

```typescript
  private readonly maxRecoveryAttempts: number;
```

- [ ] **Step 2: Update enqueue to set recoveryAttempts default**

Modify the `entry` construction in `enqueue` (line 80):

```typescript
    const entry: DeadLetterEntry = {
      id: existingEntry?.id ?? randomUUID(),
      filePath: input.filePath,
      contentHash: input.contentHash,
      errorMessage: input.errorMessage,
      attempts: input.attempts,
      recoveryAttempts: existingEntry?.recoveryAttempts ?? 0,
      createdAt: existingEntry?.createdAt ?? timestamp,
      updatedAt: timestamp,
      lastRetryAt: existingEntry?.lastRetryAt ?? null,
    };
```

- [ ] **Step 3: Rewrite recoverySweep failure branch with cap logic**

Replace the catch block inside the `for` loop in `recoverySweep` (around L158-168):

```typescript
          } catch (error) {
            const err = error as NodeJS.ErrnoException;
            if (err.code === 'ENOENT') {
              await this.removeEntries([entry.id]);
              purged += 1;
              continue;
            }

            // Increment recovery attempts and check cap
            entry.recoveryAttempts += 1;
            entry.lastRetryAt = this.now().toISOString();
            entry.updatedAt = entry.lastRetryAt;

            if (entry.recoveryAttempts >= this.maxRecoveryAttempts) {
              this.logger.warn(
                `Abandoning DLQ entry for ${entry.filePath} after ${entry.recoveryAttempts} recovery attempts. Requires manual reindex.`,
              );
              await this.removeEntries([entry.id]);
              abandoned += 1;
            } else {
              await this.options.metadataStore.upsertDeadLetterEntries([entry]);
              skipped += 1;
              this.logger.error(`Failed to recover DLQ entry for ${entry.filePath} (attempt ${entry.recoveryAttempts}/${this.maxRecoveryAttempts})`, error);
            }
          }
```

Add `abandoned` counter initialization (near L135-137):

```typescript
      let retried = 0;
      let purged = 0;
      let skipped = 0;
      let abandoned = 0;
```

Update return statement (L171):

```typescript
        return { retried, purged, skipped, abandoned };
```

- [ ] **Step 4: Wire purgeExpired into recoverySweep (before retry loop)**

Add after the `ensureLoaded()` call and before the health check (around L139-140):

```typescript
        await this.ensureLoaded();
        purged += await this.purgeExpired();

        if (!(await this.embeddingHealthy())) {
```

- [ ] **Step 5: Update RecoverySweepResult interface**

Modify `RecoverySweepResult` (line 7):

```typescript
export interface RecoverySweepResult {
  retried: number;
  purged: number;
  skipped: number;
  abandoned: number;
}
```

Update the early-return in `recoverySweep` (L130):

```typescript
      return this.currentSweep ?? { retried: 0, purged: 0, skipped: 0, abandoned: 0 };
```

And update the health-check skip return (L142):

```typescript
          skipped = this.entries.size;
          return { retried: 0, purged: 0, skipped, abandoned: 0 };
```

- [ ] **Step 6: Run type check**

Run: `npx tsc -p tsconfig.build.json --noEmit 2>&1 | head -30`
Expected: Errors in observability types/metrics + tests (fixed next).

- [ ] **Step 7: Commit**

```bash
git add src/indexer/dead-letter-queue.ts
git commit -m "feat(dlq): add recovery attempt cap and wire purgeExpired

- Entries that fail recovery maxRecoveryAttempts (default 5) times are
  abandoned and removed from the queue with a warning log.
- purgeExpired() is now called at the start of each recovery sweep,
  activating the 24h TTL that was previously dead code.
- RecoverySweepResult now includes an 'abandoned' counter."
```

---

### Task 6: Update observability hooks for `abandoned` counter

**Files:**
- Modify: `src/observability/types.ts:12`
- Modify: `src/observability/metrics-collector.ts:113`
- Modify: `src/indexer/dead-letter-queue.ts` (notify call)

- [ ] **Step 1: Extend MetricsHooks interface**

Modify `src/observability/types.ts` line 12:

```typescript
  onRecoverySweepComplete(retried: number, purged: number, skipped: number, abandoned: number, source?: string): void;
```

- [ ] **Step 2: Update MetricsCollector implementation**

Modify `src/observability/metrics-collector.ts` line 113:

```typescript
  onRecoverySweepComplete(retried: number, purged: number, skipped: number, abandoned: number, source = 'default'): void {
```

Add counter increment for abandoned (after existing counter lines):

```typescript
    this.counters.dlqAbandoned.inc({ source }, abandoned);
```

Note: The `dlqAbandoned` counter needs to be registered. Check existing counter registration pattern and add:

```typescript
    dlqAbandoned: new promClient.Counter({
      name: 'nexus_dlq_abandoned_total',
      help: 'Total DLQ entries abandoned after max recovery attempts',
      labelNames: ['source'],
    }),
```

- [ ] **Step 3: Update the DLQ notify call in recoverySweep**

Modify the `safeNotifyMetrics` call in `dead-letter-queue.ts` (L173-176):

```typescript
        this.safeNotifyMetrics((h) => {
          h.onDlqSnapshot(this.entries.size, this.options.name);
          h.onRecoverySweepComplete(retried, purged, skipped, abandoned, this.options.name);
        });
```

- [ ] **Step 4: Run type check**

Run: `npx tsc -p tsconfig.build.json --noEmit 2>&1 | head -30`
Expected: Test files may still have errors (fixed in Task 7).

- [ ] **Step 5: Commit**

```bash
git add src/observability/types.ts src/observability/metrics-collector.ts src/indexer/dead-letter-queue.ts
git commit -m "feat(observability): track abandoned DLQ entries in metrics

Extends onRecoverySweepComplete hook with abandoned count and adds
nexus_dlq_abandoned_total Prometheus counter."
```

---

### Task 7: Fix all tests for Issue 1+2 changes

**Files:**
- Modify: `tests/unit/indexer/dead-letter-queue.test.ts`
- Modify: `tests/unit/indexer/dlq-recovery-loop.test.ts`
- Modify: `tests/unit/observability/metrics-collector.test.ts`
- Modify: `tests/integration/observability-hooks.test.ts`
- Modify: `tests/integration/observability/metrics-e2e.test.ts`
- Modify: `tests/shared/test-helpers.ts` (if InMemoryMetadataStore needs update)

- [ ] **Step 1: Update InMemoryMetadataStore to include recoveryAttempts**

Check `tests/unit/storage/in-memory-metadata-store.ts` — its `getDeadLetterEntries` and `upsertDeadLetterEntries` likely work with the `DeadLetterEntry` interface directly (in-memory Map), so adding `recoveryAttempts` to the type should flow through automatically. Verify.

- [ ] **Step 2: Update makeEntry helper in dead-letter-queue.test.ts**

Modify the `makeEntry` helper (line 7):

```typescript
const makeEntry = (overrides: Partial<DeadLetterEntry> = {}): DeadLetterEntry => ({
  id: overrides.id ?? 'dlq-1',
  filePath: overrides.filePath ?? '/repo/src/auth.ts',
  contentHash: overrides.contentHash ?? 'hash-1',
  errorMessage: overrides.errorMessage ?? 'embed failed',
  attempts: overrides.attempts ?? 3,
  recoveryAttempts: overrides.recoveryAttempts ?? 0,
  createdAt: overrides.createdAt ?? '2026-04-07T00:00:00.000Z',
  updatedAt: overrides.updatedAt ?? '2026-04-07T00:00:00.000Z',
  lastRetryAt: overrides.lastRetryAt ?? null,
});
```

- [ ] **Step 3: Add test for recovery attempt cap (abandon after max)**

Add to `dead-letter-queue.test.ts`:

```typescript
  it('abandons entries that exceed maxRecoveryAttempts', async () => {
    const metadataStore = new InMemoryMetadataStore();
    await metadataStore.initialize();
    await metadataStore.upsertDeadLetterEntries([
      makeEntry({ recoveryAttempts: 4 }),
    ]);

    const reprocess = vi.fn(async () => { throw new Error('still failing'); });
    const logger = { warn: vi.fn(), error: vi.fn() };
    const queue = new DeadLetterQueue({
      metadataStore,
      embeddingHealthy: async () => true,
      computeFileHash: async () => 'hash-1',
      reprocess,
      maxRecoveryAttempts: 5,
      logger,
    });

    const result = await queue.recoverySweep();

    expect(result).toEqual({ retried: 0, purged: 0, skipped: 0, abandoned: 1 });
    await expect(metadataStore.getDeadLetterEntries()).resolves.toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Abandoning'));
  });
```

- [ ] **Step 4: Add test for recovery attempt increment (below cap)**

Add to `dead-letter-queue.test.ts`:

```typescript
  it('increments recoveryAttempts on failed recovery and persists', async () => {
    const metadataStore = new InMemoryMetadataStore();
    await metadataStore.initialize();
    await metadataStore.upsertDeadLetterEntries([
      makeEntry({ recoveryAttempts: 2 }),
    ]);

    const reprocess = vi.fn(async () => { throw new Error('transient failure'); });
    const logger = { warn: vi.fn(), error: vi.fn() };
    const queue = new DeadLetterQueue({
      metadataStore,
      embeddingHealthy: async () => true,
      computeFileHash: async () => 'hash-1',
      reprocess,
      maxRecoveryAttempts: 5,
      logger,
    });

    const result = await queue.recoverySweep();

    expect(result).toEqual({ retried: 0, purged: 0, skipped: 1, abandoned: 0 });
    const entries = await metadataStore.getDeadLetterEntries();
    expect(entries[0]?.recoveryAttempts).toBe(3);
    expect(entries[0]?.lastRetryAt).not.toBeNull();
  });
```

- [ ] **Step 5: Add test for purgeExpired wiring in recoverySweep**

Add to `dead-letter-queue.test.ts`:

```typescript
  it('purges expired entries at the start of recoverySweep', async () => {
    const metadataStore = new InMemoryMetadataStore();
    await metadataStore.initialize();
    await metadataStore.upsertDeadLetterEntries([
      makeEntry({ id: 'expired', createdAt: '2026-04-05T00:00:00.000Z', updatedAt: '2026-04-05T00:00:00.000Z' }),
      makeEntry({ id: 'fresh', filePath: '/repo/src/fresh.ts', createdAt: '2026-04-07T00:00:00.000Z', updatedAt: '2026-04-07T00:00:00.000Z' }),
    ]);

    const reprocess = vi.fn(async () => undefined);
    const queue = new DeadLetterQueue({
      metadataStore,
      embeddingHealthy: async () => true,
      computeFileHash: async () => 'hash-1',
      reprocess,
      now: () => new Date('2026-04-07T12:00:00.000Z'),
      ttlMs: 24 * 60 * 60 * 1000,
    });

    const result = await queue.recoverySweep();

    // expired entry is purged, fresh entry is retried
    expect(result.purged).toBe(1);
    expect(result.retried).toBe(1);
  });
```

- [ ] **Step 6: Update existing recoverySweep result expectations**

Update all tests that assert `recoverySweep` results to include `abandoned: 0`:

- `dead-letter-queue.test.ts` line 92: `{ retried: 0, purged: 0, skipped: 1, abandoned: 0 }`
- `dead-letter-queue.test.ts` line 112: `{ retried: 0, purged: 1, skipped: 0, abandoned: 0 }`
- `dead-letter-queue.test.ts` line 132: `{ retried: 1, purged: 0, skipped: 0, abandoned: 0 }`

- [ ] **Step 7: Update metrics-collector.test.ts hook call**

Modify `tests/unit/observability/metrics-collector.test.ts` line 153:

```typescript
    collector.onRecoverySweepComplete(5, 2, 1, 0);
```

- [ ] **Step 8: Update integration observability-hooks.test.ts**

Modify `tests/integration/observability-hooks.test.ts` line 53:

```typescript
      expect(onRecoverySweepComplete).toHaveBeenCalledWith(0, 0, 0, 0, 'test-dlq');
```

- [ ] **Step 9: Update metrics-e2e.test.ts hook wiring**

Modify `tests/integration/observability/metrics-e2e.test.ts` line 78-79:

```typescript
        onRecoverySweepComplete: (retried, purged, skipped, abandoned, source) =>
          collector.onRecoverySweepComplete(retried, purged, skipped, abandoned, source),
```

- [ ] **Step 10: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS.

- [ ] **Step 11: Commit**

```bash
git add tests/
git commit -m "test: update all tests for recoveryAttempts and abandoned counter

- Add tests for recovery cap (abandon after maxRecoveryAttempts)
- Add test for recovery attempt persistence
- Add test for purgeExpired wiring in recoverySweep
- Update all existing assertions for new RecoverySweepResult shape"
```

---

### Task 8: Create process-lock module

**Files:**
- Create: `src/server/process-lock.ts`
- Create: `tests/unit/server/process-lock.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/server/process-lock.test.ts`:

```typescript
import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, rm, readFile } from 'node:fs/promises';
import path from 'node:path';

import { acquireProcessLock, releaseProcessLock } from '../../../src/server/process-lock.js';

const TEST_DIR = path.join(process.cwd(), 'tests/.tmp-lock-test');

describe('ProcessLock', () => {
  afterEach(async () => {
    await releaseProcessLock(TEST_DIR);
    await rm(TEST_DIR, { recursive: true, force: true });
  });

  it('acquires a lock and writes the PID file', async () => {
    await mkdir(TEST_DIR, { recursive: true });

    const result = await acquireProcessLock(TEST_DIR);

    expect(result.acquired).toBe(true);
    const pidContent = await readFile(path.join(TEST_DIR, 'nexus.pid'), 'utf8');
    expect(Number.parseInt(pidContent.trim(), 10)).toBe(process.pid);
  });

  it('detects a live process and refuses to acquire', async () => {
    await mkdir(TEST_DIR, { recursive: true });

    const first = await acquireProcessLock(TEST_DIR);
    expect(first.acquired).toBe(true);

    const second = await acquireProcessLock(TEST_DIR);
    expect(second.acquired).toBe(false);
    expect(second.existingPid).toBe(process.pid);
  });

  it('recovers from a stale lock (dead PID)', async () => {
    await mkdir(TEST_DIR, { recursive: true });
    // Write a PID file for a process that definitely doesn't exist
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(TEST_DIR, 'nexus.pid'), '99999999');

    const result = await acquireProcessLock(TEST_DIR);

    expect(result.acquired).toBe(true);
  });

  it('releaseProcessLock removes the PID file', async () => {
    await mkdir(TEST_DIR, { recursive: true });
    await acquireProcessLock(TEST_DIR);

    await releaseProcessLock(TEST_DIR);

    const { stat } = await import('node:fs/promises');
    await expect(stat(path.join(TEST_DIR, 'nexus.pid'))).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/server/process-lock.test.ts`
Expected: FAIL — module `../../../src/server/process-lock.js` does not exist.

- [ ] **Step 3: Implement process-lock module**

Create `src/server/process-lock.ts`:

```typescript
import { open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

export interface LockResult {
  acquired: boolean;
  existingPid?: number;
}

const LOCK_FILENAME = 'nexus.pid';

/**
 * Attempts to acquire a single-instance lock for the given storage directory.
 * Uses a PID file with liveness verification to handle stale locks.
 */
export async function acquireProcessLock(storageDir: string): Promise<LockResult> {
  const lockPath = path.join(storageDir, LOCK_FILENAME);

  // Check for existing lock
  try {
    const content = await readFile(lockPath, 'utf8');
    const existingPid = Number.parseInt(content.trim(), 10);

    if (Number.isNaN(existingPid)) {
      // Corrupt lock file — remove and retry
      await safeUnlink(lockPath);
    } else if (isProcessAlive(existingPid)) {
      return { acquired: false, existingPid };
    } else {
      // Stale lock (process no longer exists) — remove and proceed
      await safeUnlink(lockPath);
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      throw error;
    }
    // No lock file exists — proceed to acquire
  }

  // Acquire lock atomically
  try {
    const fd = await open(lockPath, 'wx');
    await fd.writeFile(String(process.pid));
    await fd.close();
    return { acquired: true };
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'EEXIST') {
      // Race condition: another process acquired between our check and create
      return { acquired: false };
    }
    throw error;
  }
}

/**
 * Releases the process lock by removing the PID file.
 * Safe to call even if no lock is held.
 */
export async function releaseProcessLock(storageDir: string): Promise<void> {
  await safeUnlink(path.join(storageDir, LOCK_FILENAME));
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      throw error;
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/server/process-lock.test.ts`
Expected: All 4 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/process-lock.ts tests/unit/server/process-lock.test.ts
git commit -m "feat(server): add PID-file process lock for single-instance guarantee

Prevents multiple nexus processes from running against the same storage
directory. Handles stale locks via process.kill(pid, 0) liveness check.
Atomic lock creation via fs.open('wx') prevents race conditions."
```

---

### Task 9: Wire process lock into nexus.ts entry point

**Files:**
- Modify: `src/bin/nexus.ts`

- [ ] **Step 1: Import and acquire lock before runtime init**

Modify `src/bin/nexus.ts`:

```typescript
#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "../config/index.js";
import { NexusServerFactory } from "../server/factory.js";
import { acquireProcessLock, releaseProcessLock } from "../server/process-lock.js";
import type { NexusRuntime } from "../server/index.js";

async function main() {
  const { values } = parseArgs({
    options: {
      "project-root": { type: "string" },
    },
    strict: false,
  });

  const rawProjectRoot = (
    (values["project-root"] as string) ??
    process.env.NEXUS_PROJECT_ROOT ??
    ""
  ).trim();
  const root = rawProjectRoot ? path.resolve(rawProjectRoot) : process.cwd();

  const config = await loadConfig({ projectRoot: root });

  // Acquire single-instance lock (keyed on storage directory)
  const lockResult = await acquireProcessLock(config.storage.rootDir);
  if (!lockResult.acquired) {
    console.error(
      `⚠️  Another Nexus process (PID ${lockResult.existingPid ?? 'unknown'}) is already running for this project.` +
      `\n   Storage: ${config.storage.rootDir}` +
      `\n   To force start, remove: ${path.join(config.storage.rootDir, 'nexus.pid')}`,
    );
    process.exit(1);
  }

  const runtime = await NexusServerFactory.createRuntime(config);

  const transport = new StdioServerTransport();
  await runtime.server.connect(transport);

  console.error(`🔗 Nexus MCP server running on stdio (root: ${root})`);

  setupSignalHandlers(runtime, config.storage.rootDir);

  runtime.initialize().catch((error) => {
    console.error("Nexus background initialization failed:", error);
    process.exit(1);
  });
}

function setupSignalHandlers(runtime: NexusRuntime, storageDir: string): void {
  let isShuttingDown = false;

  const handleShutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    runtime
      .close()
      .then(() => releaseProcessLock(storageDir))
      .then(() => {
        process.exit(0);
      })
      .catch((error) => {
        console.error("Error during shutdown:", error);
        process.exit(1);
      });
  };

  // Best-effort cleanup on unexpected exit
  process.on('exit', () => {
    try {
      // Sync unlink as last resort (process.on('exit') is sync-only)
      const { unlinkSync } = require('node:fs');
      const lockPath = path.join(storageDir, 'nexus.pid');
      unlinkSync(lockPath);
    } catch {
      // Ignore — stale lock will be detected on next startup
    }
  });

  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}

if (process.argv[2] === "dashboard") {
  process.argv.splice(2, 1);

  try {
    await import("@yohi/nexus-dashboard/cli");
  } catch (error) {
    console.error("Failed to start dashboard:", error);
    process.exit(1);
  }
} else {
  main().catch((error) => {
    console.error("Fatal error starting Nexus:", error);
    process.exit(1);
  });
}
```

Note: The `process.on('exit')` handler uses `require` (sync) as a safety net. In ESM modules, `fs.unlinkSync` can be imported at the top level as a named import instead. Adjust to:

```typescript
import { unlinkSync } from 'node:fs';
```

And in the handler:

```typescript
  process.on('exit', () => {
    try {
      unlinkSync(path.join(storageDir, 'nexus.pid'));
    } catch {
      // Stale lock will be detected on next startup
    }
  });
```

- [ ] **Step 2: Run type check**

Run: `npx tsc -p tsconfig.build.json --noEmit`
Expected: No errors.

- [ ] **Step 3: Run full test suite (verify no regressions)**

Run: `npx vitest run`
Expected: All PASS.

- [ ] **Step 4: Commit**

```bash
git add src/bin/nexus.ts
git commit -m "feat(server): wire process lock into nexus startup/shutdown

Acquires lock on config.storage.rootDir before creating runtime.
On conflict, prints warning with conflicting PID and exits non-zero.
Lock released on SIGINT/SIGTERM and best-effort on process exit.
Dashboard subcommand is exempt (does not hold a lock)."
```

---

### Task 10: Build verification + manual smoke test

**Files:**
- None (verification only)

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: Exit code 0, `dist/bin/nexus.js` exists.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 3: Lint check**

Run: `npm run lint`
Expected: No new errors.

- [ ] **Step 4: Smoke test process lock**

```bash
# Start first instance (will create PID file and wait on stdio)
node dist/bin/nexus.js --project-root /tmp/nexus-lock-test &
PID1=$!
sleep 1

# Verify PID file exists
cat /tmp/nexus-lock-test/.nexus/nexus.pid

# Attempt second instance (should fail with warning)
node dist/bin/nexus.js --project-root /tmp/nexus-lock-test 2>&1 | grep -q "Another Nexus process"
echo "Lock test: $?"  # Should output 0

# Cleanup
kill $PID1 2>/dev/null
rm -rf /tmp/nexus-lock-test
```

Expected: Second instance prints warning and exits 1.

- [ ] **Step 5: Commit (no code changes — verification only)**

No commit needed. Proceed to Task 11.

---

### Task 11: Document CPU concurrency recommendation

**Files:**
- Modify: `docs/configuration.md`

- [ ] **Step 1: Add CPU guidance to configuration docs**

Add a note after the `embedding.maxConcurrency` row in the configuration table or in a new "Performance Tuning" section:

````markdown
### Performance Tuning: CPU-Only Environments

If Ollama is running **without GPU acceleration** (CPU-only), the default `maxConcurrency: 2` may cause thread contention and frequent timeouts. In this case:

```bash
export NEXUS_EMBEDDING_MAX_CONCURRENCY=1
```

Or in `.nexus.json`:

```json
{
  "embedding": {
    "maxConcurrency": 1
  }
}
```

**Symptoms of CPU contention:**
- Frequent `RetryExhaustedError` in logs
- DLQ entries accumulating rapidly
- Ollama responding slowly to all requests

**Rule of thumb:** Use `maxConcurrency: 1` for CPU-only Ollama, `2-4` for GPU-accelerated environments depending on VRAM.
````

- [ ] **Step 2: Commit**

```bash
git add docs/configuration.md
git commit -m "docs(config): add CPU concurrency tuning guidance

Recommends maxConcurrency=1 for CPU-only Ollama environments to
avoid thread contention and timeout-induced retry storms."
```

---

## Self-Review Checklist

**1. Spec coverage:**
- ✅ Issue 1 (double retry): Task 1-2 removes outer retry
- ✅ Issue 2 (DLQ infinite loop): Tasks 3-7 add cap + purge + metrics
- ✅ Issue 4 (process lock): Tasks 8-9 implement PID lock
- ✅ Issue 3 (CPU concurrency): Task 11 documents recommendation
- ✅ Verification: Task 10 runs build + full test + smoke test

**2. Placeholder scan:** No TBDs, no "similar to Task N", all code shown.

**3. Type consistency:**
- `DeadLetterEntry.recoveryAttempts` used consistently across type def (Task 3), metadata store (Task 4), DLQ logic (Task 5), tests (Task 7)
- `RecoverySweepResult.abandoned` used consistently across interface (Task 5), DLQ implementation (Task 5), observability hooks (Task 6), all test updates (Task 7)
- `acquireProcessLock` / `releaseProcessLock` function names consistent between module (Task 8), tests (Task 8), and nexus.ts wiring (Task 9)
- `maxRecoveryAttempts` option name consistent between DLQ options (Task 5) and test usage (Task 7)
