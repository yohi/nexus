# DLQ Double Start Warning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a warning log when `DeadLetterQueue.startRecoveryLoop()` is called while it is already running.

**Architecture:** Update `startRecoveryLoop()` in `DeadLetterQueue` to check for an existing `recoveryInterval` and log a warning if it exists.

**Tech Stack:** TypeScript, Vitest

---

## Task 1: Add Failing Test

**Files:**
- Modify: `tests/unit/indexer/dead-letter-queue.test.ts`

- [ ] **Step 1: Write the failing test**

Add the following test case at the end of the `describe('DeadLetterQueue', ...)` block:

```typescript
  it('warns when starting recovery loop while already running', () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const queue = new DeadLetterQueue({
      metadataStore: new InMemoryMetadataStore(),
      logger,
    });

    const stop1 = queue.startRecoveryLoop();
    queue.startRecoveryLoop();

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('already running'));
    stop1();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test tests/unit/indexer/dead-letter-queue.test.ts`
Expected: FAIL (logger.warn not called)

- [ ] **Step 3: Commit failing test**

```bash
git add tests/unit/indexer/dead-letter-queue.test.ts
git commit -m "test: add failing test for DLQ double start warning"
```

---

## Task 2: Implement Warning Logic

**Files:**
- Modify: `src/indexer/dead-letter-queue.ts`

- [ ] **Step 1: Write minimal implementation**

In `src/indexer/dead-letter-queue.ts`, modify `startRecoveryLoop` to log a warning if `this.recoveryInterval` is already set.

```typescript
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
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npm test tests/unit/indexer/dead-letter-queue.test.ts`
Expected: PASS

- [ ] **Step 3: Commit implementation**

```bash
git add src/indexer/dead-letter-queue.ts
git commit -m "feat: add warning when DLQ recovery loop is started twice"
```
