# P1 Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix missing `await` in server rollback and regenerate the `NOTICE` file with correct license information.

**Architecture:** Use `await` for async rollback calls in `src/server/index.ts` with proper error logging. Use the project's `license:notice` script to fix the `NOTICE` file.

**Tech Stack:** TypeScript, Vitest, npm scripts (generate-license-file).

---

### Task 1: Fix Missing await in Server Rollback

**Files:**
- Modify: `src/server/index.ts`
- Test: `tests/unit/server/index.test.ts`

- [ ] **Step 1: Write a failing test for initialization rollback**

Add a test case to `tests/unit/server/index.test.ts` that mocks a failure during `initializeNexusRuntime` and verifies if `pipeline.stop` is awaited.

```typescript
  describe('initializeNexusRuntime rollback', () => {
    it('awaits pipeline.stop and watcher.stop when initialization fails', async () => {
      const stopDeferred = {
        promise: null as any as Promise<void>,
        resolve: null as any as () => void,
        called: false,
      };
      stopDeferred.promise = new Promise((resolve) => {
        stopDeferred.resolve = () => {
          stopDeferred.called = true;
          resolve();
        };
      });

      const mockPipeline = {
        start: vi.fn(),
        stop: vi.fn().mockImplementation(() => stopDeferred.promise),
      };
      const mockWatcher = {
        start: vi.fn().mockRejectedValue(new Error('init failure')),
        stop: vi.fn().mockResolvedValue(undefined),
      };

      const mockOptions = {
        metadataStore: { initialize: vi.fn().mockResolvedValue(undefined) },
        vectorStore: { initialize: vi.fn().mockResolvedValue(undefined) },
        pipeline: mockPipeline,
        watcher: mockWatcher,
        projectRoot: '/tmp',
        sanitizer: {} as any,
        semanticSearch: {} as any,
        grepEngine: {} as any,
        orchestrator: {} as any,
        pluginRegistry: {} as any,
        runReindex: vi.fn(),
        loadFileContent: vi.fn(),
      } as any;

      const initPromise = initializeNexusRuntime(mockOptions);

      // Give it a tick to hit the catch block
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(mockPipeline.stop).toHaveBeenCalled();
      // If NOT awaited, the initPromise would have already rejected (or proceeded past the call)
      // but we haven't resolved stopDeferred yet.
      
      let rejected = false;
      initPromise.catch(() => { rejected = true; });

      await new Promise(resolve => setTimeout(resolve, 0));
      expect(rejected, 'Should not have rejected yet if pipeline.stop is awaited').toBe(false);

      stopDeferred.resolve();
      await initPromise.catch(() => {});
      expect(stopDeferred.called).toBe(true);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest tests/unit/server/index.test.ts`
Expected: FAIL (The test will likely timeout or fail the `rejected` assertion because `pipeline.stop()` isn't awaited in the current code, meaning the promise rejects immediately after the call).

- [ ] **Step 3: Implement fix in src/server/index.ts**

Modify the `catch` block in `initializeNexusRuntime`.

```typescript
<<<<
  } catch (error) {
    options.pipeline.stop();
    await options.watcher.stop().catch((stopError) => {
      console.error('Failed to stop watcher during initialization rollback:', stopError);
    });
    throw error;
  }
====
  } catch (error) {
    await options.pipeline.stop().catch((stopError) => {
      console.error('Failed to stop pipeline during initialization rollback:', stopError);
    });
    await options.watcher.stop().catch((stopError) => {
      console.error('Failed to stop watcher during initialization rollback:', stopError);
    });
    throw error;
  }
>>>>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest tests/unit/server/index.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/server/index.ts tests/unit/server/index.test.ts
git commit -m "fix: await pipeline.stop during initialization rollback"
```

---

### Task 2: Regenerate NOTICE File

**Files:**
- Modify: `NOTICE`

- [x] **Step 1: Delete existing NOTICE file**

Run: `rm NOTICE`

- [x] **Step 2: Run license:notice script**

Run: `npm run license:notice`

- [x] **Step 3: Verify content of NOTICE**

Run: `grep -E "@lancedb/lancedb|zod|chokidar" NOTICE`
Expected: Matches found, confirming license info is present.

- [x] **Step 4: Commit**

```bash
git add NOTICE
git commit -m "build: regenerate NOTICE file with full dependency licenses"
```
