# P1 Fixes: Server Rollback Await & NOTICE File Regeneration

Date: 2026-04-09

## 1. Problem Statement

Two high-priority (P1) issues were identified:
1.  **Missing `await` on `pipeline.stop()` in initialization rollback**: In `src/server/index.ts`, when an error occurs during server initialization, `options.pipeline.stop()` is called without `await`. Since `stop()` is an async method that stops the Dead Letter Queue (DLQ) recovery loop, failing to await it can lead to unhandled rejections or the recovery loop continuing to run after initialization failure.
2.  **Empty `NOTICE` file**: The committed `NOTICE` file contains only a duplicated header banner and lacks actual third-party license information.

## 2. Proposed Changes

### 2.1. Server Initialization Rollback Fix

Modify `src/server/index.ts` to properly await the `pipeline.stop()` call within the `catch` block of the server initialization logic.

**Affected File:** `src/server/index.ts`

**Implementation Detail:**
Change the rollback logic in the `catch` block:
```typescript
  } catch (error) {
    await options.pipeline.stop().catch((stopError) => {
      console.error('Failed to stop pipeline during initialization rollback:', stopError);
    });
    await options.watcher.stop().catch((stopError) => {
      console.error('Failed to stop watcher during initialization rollback:', stopError);
    });
    throw error;
  }
```
This ensures both `pipeline.stop()` and `watcher.stop()` are awaited, and any errors during their execution are logged rather than causing unhandled rejections.

### 2.2. NOTICE File Regeneration

Regenerate the `NOTICE` file to include all production-dependency licenses using the project's established script.

**Affected File:** `NOTICE`

**Process:**
1.  Verify the `license:notice` script in `package.json`.
2.  Run `npm run license:notice` to populate the `NOTICE` file.
3.  Verify the content contains actual license texts (e.g., searching for "LanceDB", "Zod", etc.).

## 3. Verification Strategy

### 3.1. Automated Tests for Rollback Fix
-   **Unit Test:** Update or add a test in `tests/unit/server/index.test.ts` to simulate an initialization error.
-   **Validation:** Use `vi.spyOn` or equivalent to ensure `pipeline.stop()` is called and its returned Promise is awaited before the initialization error is re-thrown.

### 3.2. Manual Verification for NOTICE File
-   **Content Check:** Inspect the regenerated `NOTICE` file to ensure it's not just a banner.
-   **Keywords:** Check for presence of licenses from major dependencies like `@lancedb/lancedb` or `@modelcontextprotocol/sdk`.

## 4. Risks and Considerations
-   **`pipeline.stop()` behavior:** Ensure that calling `stop()` on a pipeline that hasn't fully started or is already stopping is idempotent and safe.
-   **License tool dependencies:** The `generate-license-file` package must be correctly configured to find all production dependencies.
