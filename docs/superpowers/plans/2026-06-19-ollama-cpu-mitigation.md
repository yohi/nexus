# Ollama CPU Mitigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add configurable per-request Ollama thread limiting and lock down the existing process-lock, L1/L2 cache, and Merkle skip behavior with regression tests.

**Architecture:** Keep the current single-process Nexus MCP server architecture. Extend the existing embedding config shape with an Ollama-only `ollamaNumThread` value, pass it through `OllamaEmbeddingProvider`, and preserve existing `proper-lockfile` and cache mechanisms. Do not introduce a new coordinator layer, daemon mode, Redis, or unstable CPU-load assertions.

**Tech Stack:** TypeScript, Node.js >=24, Vitest, `proper-lockfile`, `p-limit`, SQLite via existing metadata store abstractions.

## Global Constraints

- Per-request Ollama thread limit defaults to `2`.
- `NEXUS_OLLAMA_NUM_THREAD` and `.nexus.json` `embedding.ollamaNumThread` accept only integers from `1` through `16`.
- Invalid, empty, decimal, negative, zero, non-numeric, and greater-than-`16` thread values fall back to `2`.
- Ollama request payload must include `options: { num_thread: this.config.ollamaNumThread }` only for the Ollama provider.
- Keep the existing `proper-lockfile` process-level lock; do not replace it with process-local `async-mutex`.
- Lock behavior remains bounded: stale timeout `60_000ms`, 10 retries, `100ms` minimum retry delay, `1000ms` maximum retry delay.
- L1 cache remains bounded by `embeddingCacheSize` and preserves LRU semantics through delete-and-set on cache hits.
- L2 cache hits hydrate L1 using the same bounded insertion path.
- No new external infrastructure or dependencies unless the minimal `Map` implementation cannot satisfy tests.
- Do not implement daemon mode in this plan.
- Do not add CPU-load assertions to CI.
- Run verification with `npm test`, `npm run build`, and `npm run lint` after implementation.
- Do not commit unless the user explicitly requests git commits in the execution session.

---

## File Structure

- Modify `src/types/index.ts:207-218`: add `ollamaNumThread: number` to `EmbeddingConfig` so config, factory, and provider receive a typed value.
- Modify `src/config/index.ts`: add default `ollamaNumThread: 2`, parse `NEXUS_OLLAMA_NUM_THREAD`, parse `.nexus.json` `embedding.ollamaNumThread`, and enforce range `1..16`.
- Modify `src/plugins/embeddings/ollama.ts`: include `ollamaNumThread` in the constructor config pick and send it as `options.num_thread` in `/api/embed` JSON.
- Modify `src/utils/global-lock.ts`: export lock policy constants so tests can assert the bounded process-lock behavior without duplicating magic numbers.
- Modify `tests/unit/config/index.test.ts`: add config parsing tests for default, valid env, valid file config, and invalid fallback cases.
- Modify `tests/unit/plugins/embeddings/ollama.test.ts`: add payload tests for default and configured `num_thread`.
- Modify `tests/unit/utils/global-lock.test.ts`: assert exported lock policy constants and existing conflict behavior.
- Modify `src/indexer/pipeline.ts`: extract L1 cache lookup and insertion into `getL1Cache()` and `setL1Cache()` so LRU semantics are centralized.
- Modify `tests/unit/indexer/pipeline-windowed.test.ts`: add a targeted L1 LRU refresh test; existing cache tests already cover L1/L2 hit and eviction basics.
- Reuse `tests/unit/indexer/rename-detection.test.ts`: existing test already verifies rename path avoids recomputing embeddings; no new Merkle task is required unless execution discovers a failing gap.

---

### Task 1: Add bounded Ollama thread config

**Files:**
- Modify: `src/types/index.ts:207-218`
- Modify: `src/config/index.ts:12-22`
- Modify: `src/config/index.ts:110-133`
- Modify: `src/config/index.ts:173-190`
- Test: `tests/unit/config/index.test.ts`

**Interfaces:**
- Consumes: existing `EmbeddingConfig`, `loadConfig(options: LoadConfigOptions): Promise<Config>`, `asPositiveInt(value: string | undefined): number | undefined`, `validatePositiveInt(value: unknown): number | undefined`.
- Produces: `EmbeddingConfig.ollamaNumThread: number`, config default `2`, env/file parsing for `NEXUS_OLLAMA_NUM_THREAD` and `embedding.ollamaNumThread` with accepted range `1..16`.

- [ ] **Step 1: Write failing config tests**

Append these tests inside `describe('loadConfig', () => { ... })` in `tests/unit/config/index.test.ts`:

```ts
  it('defaults Ollama num_thread to 2', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-config-'));

    const config = await loadConfig({ projectRoot: tempDir, env: {} });

    expect(config.embedding.ollamaNumThread).toBe(2);
  });

  it('loads Ollama num_thread from environment variables and file config', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-config-'));
    await writeFile(
      path.join(tempDir, '.nexus.json'),
      JSON.stringify({ embedding: { ollamaNumThread: 1 } }),
      'utf8',
    );

    const fileConfig = await loadConfig({ projectRoot: tempDir, env: {} });
    expect(fileConfig.embedding.ollamaNumThread).toBe(1);

    const envConfig = await loadConfig({
      projectRoot: tempDir,
      env: { NEXUS_OLLAMA_NUM_THREAD: '16' },
    });
    expect(envConfig.embedding.ollamaNumThread).toBe(16);
  });

  it.each([
    ['0'],
    ['-1'],
    ['1.5'],
    [''],
    ['abc'],
    ['17'],
    ['128'],
  ])('falls back to Ollama num_thread default for invalid env value %s', async (value) => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-config-'));

    const config = await loadConfig({
      projectRoot: tempDir,
      env: { NEXUS_OLLAMA_NUM_THREAD: value },
    });

    expect(config.embedding.ollamaNumThread).toBe(2);
  });

  it.each([0, -1, 1.5, '2', 17, 128, null])(
    'falls back to Ollama num_thread default for invalid file value %s',
    async (value) => {
      tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-config-'));
      await writeFile(
        path.join(tempDir, '.nexus.json'),
        JSON.stringify({ embedding: { ollamaNumThread: value } }),
        'utf8',
      );

      const config = await loadConfig({ projectRoot: tempDir, env: {} });

      expect(config.embedding.ollamaNumThread).toBe(2);
    },
  );
```

- [ ] **Step 2: Run config tests and verify they fail**

Run: `npx vitest run tests/unit/config/index.test.ts`

Expected: FAIL with TypeScript/runtime assertions showing `ollamaNumThread` is missing or `undefined`.

- [ ] **Step 3: Add the config type field**

In `src/types/index.ts`, update `EmbeddingConfig` to include the field exactly like this:

```ts
export interface EmbeddingConfig {
  provider: 'ollama' | 'openai-compat' | 'test';
  model: string;
  dimensions: number;
  baseUrl?: string;
  apiKey?: string;
  maxConcurrency: number;
  batchSize: number;
  retryCount: number;
  retryBaseDelayMs: number;
  timeoutMs?: number;
  ollamaNumThread: number;
}
```

- [ ] **Step 4: Add bounded config parsing helpers**

In `src/config/index.ts`, add these constants near `DEFAULT_BATCH_SIZE`:

```ts
export const DEFAULT_OLLAMA_NUM_THREAD = 2;
export const MAX_OLLAMA_NUM_THREAD = 16;
```

Add the default inside `DEFAULT_EMBEDDING`:

```ts
const DEFAULT_EMBEDDING: EmbeddingConfig = {
  provider: 'ollama',
  model: 'nomic-embed-text',
  dimensions: 768,
  baseUrl: 'http://127.0.0.1:11434',
  maxConcurrency: 1,
  batchSize: 32,
  retryCount: 3,
  retryBaseDelayMs: 250,
  timeoutMs: 120_000,
  ollamaNumThread: DEFAULT_OLLAMA_NUM_THREAD,
};
```

Add these helpers below `validatePositiveInt`. Include the JSDoc exactly as shown so future maintainers can see that the helper accepts only the closed range `1..max`, not merely any positive integer:

```ts
/** Parses environment values that must be integers in the inclusive range 1..max. */
const asBoundedPositiveInt = (
  value: string | undefined,
  max: number,
): number | undefined => {
  const parsed = asPositiveInt(value);
  return parsed !== undefined && parsed <= max ? parsed : undefined;
};

/** Validates config-file values that must be integers in the inclusive range 1..max. */
const validateBoundedPositiveInt = (
  value: unknown,
  max: number,
): number | undefined => {
  const parsed = validatePositiveInt(value);
  return parsed !== undefined && parsed <= max ? parsed : undefined;
};
```

Add this property to the `embedding` object in `loadConfig`:

```ts
      ollamaNumThread:
        asBoundedPositiveInt(env.NEXUS_OLLAMA_NUM_THREAD, MAX_OLLAMA_NUM_THREAD) ??
        validateBoundedPositiveInt(fileConfig.embedding?.ollamaNumThread, MAX_OLLAMA_NUM_THREAD) ??
        defaults.embedding.ollamaNumThread,
```

- [ ] **Step 5: Run config tests and verify they pass**

Run: `npx vitest run tests/unit/config/index.test.ts`

Expected: PASS for all config tests.

- [ ] **Step 6: Run type check for touched config/types**

Run: `npx tsc --noEmit -p tsconfig.json`

Expected: Exit 0. If the project does not have a no-emit root config, use `npm run build` and expect TypeScript compilation to pass.

- [ ] **Step 7: Review checkpoint**

Do not commit unless the user explicitly requested commits in this execution session. Report: files changed, tests run, and whether `ollamaNumThread` is typed and bounded.

---

### Task 2: Send Ollama `options.num_thread` in embed payload

**Files:**
- Modify: `src/plugins/embeddings/ollama.ts:33-37`
- Modify: `src/plugins/embeddings/ollama.ts:122-126`
- Test: `tests/unit/plugins/embeddings/ollama.test.ts`

**Interfaces:**
- Consumes: `EmbeddingConfig.ollamaNumThread: number` from Task 1.
- Produces: `OllamaEmbeddingProvider` request body includes `options: { num_thread: this.config.ollamaNumThread }` for `/api/embed` calls.

- [ ] **Step 1: Write failing payload tests**

Add these tests inside `describe('OllamaEmbeddingProvider', () => { ... })` in `tests/unit/plugins/embeddings/ollama.test.ts`:

```ts
  it('sends configured Ollama num_thread in the embed request body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[1, 2, 3, 4]] }),
    });

    const provider = new OllamaEmbeddingProvider(
      {
        baseUrl: 'http://localhost:11434',
        model: 'nomic-embed-text',
        dimensions: 4,
        maxConcurrency: 1,
        batchSize: 1,
        retryCount: 0,
        retryBaseDelayMs: 1,
        ollamaNumThread: 1,
      },
      { fetch: fetchMock, sleep: async () => {} },
    );

    await provider.embed(['hello']);

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      options?: { num_thread?: number };
    };
    expect(body.options).toEqual({ num_thread: 1 });
  });

  it('sends default Ollama num_thread when provider receives the default config value', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ embeddings: [[1, 2, 3, 4]] }),
    });

    const provider = new OllamaEmbeddingProvider(
      {
        baseUrl: 'http://localhost:11434',
        model: 'nomic-embed-text',
        dimensions: 4,
        maxConcurrency: 1,
        batchSize: 1,
        retryCount: 0,
        retryBaseDelayMs: 1,
        ollamaNumThread: 2,
      },
      { fetch: fetchMock, sleep: async () => {} },
    );

    await provider.embed(['hello']);

    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as {
      options?: { num_thread?: number };
    };
    expect(body.options).toEqual({ num_thread: 2 });
  });
```

- [ ] **Step 2: Run Ollama provider tests and verify they fail**

Run: `npx vitest run tests/unit/plugins/embeddings/ollama.test.ts`

Expected: FAIL because `options` is missing from the request body or constructor config does not accept `ollamaNumThread` yet.

- [ ] **Step 3: Update provider config pick and payload**

In `src/plugins/embeddings/ollama.ts`, update the constructor config pick:

```ts
    private readonly config: Pick<
      EmbeddingConfig,
      | 'baseUrl'
      | 'model'
      | 'dimensions'
      | 'maxConcurrency'
      | 'batchSize'
      | 'retryCount'
      | 'retryBaseDelayMs'
      | 'timeoutMs'
      | 'ollamaNumThread'
    >,
```

Update the JSON body in `requestEmbeddings()`:

```ts
        body: JSON.stringify({
          model: this.config.model,
          input: batch,
          truncate: true,
          options: {
            num_thread: this.config.ollamaNumThread,
          },
        }),
```

- [ ] **Step 4: Update existing provider test fixtures**

Every `new OllamaEmbeddingProvider({ ... })` object in `tests/unit/plugins/embeddings/ollama.test.ts` must include `ollamaNumThread: 2` unless the test is intentionally checking `1`. Example:

```ts
const provider = new OllamaEmbeddingProvider(
  {
    baseUrl: 'http://localhost:11434',
    model: 'nomic-embed-text',
    dimensions: 4,
    maxConcurrency: 2,
    batchSize: 2,
    retryCount: 3,
    retryBaseDelayMs: 1,
    ollamaNumThread: 2,
  },
  { fetch: fetchMock, sleep: async () => {} },
);
```

- [ ] **Step 5: Run Ollama provider tests and verify they pass**

Run: `npx vitest run tests/unit/plugins/embeddings/ollama.test.ts`

Expected: PASS for all Ollama provider tests.

- [ ] **Step 6: Run build to catch constructor call sites outside this test file**

Run: `npm run build`

Expected: Exit 0. If TypeScript reports another `OllamaEmbeddingProvider` config object missing `ollamaNumThread`, add `ollamaNumThread: config.embedding.ollamaNumThread` at that construction site rather than hard-coding `2`.

- [ ] **Step 7: Review checkpoint**

Do not commit unless the user explicitly requested commits in this execution session. Report: request payload shape, tests run, and any additional call sites updated.

---

### Task 3: Lock down process-level global lock policy

**Files:**
- Modify: `src/utils/global-lock.ts:6-7`
- Test: `tests/unit/utils/global-lock.test.ts`

**Interfaces:**
- Consumes: existing `acquireGlobalLock(name: string): Promise<GlobalLockHandle>`.
- Produces: exported constants `GLOBAL_LOCK_STALE_MS`, `GLOBAL_LOCK_RETRIES`, `GLOBAL_LOCK_RETRY_MIN_TIMEOUT_MS`, and `GLOBAL_LOCK_RETRY_MAX_TIMEOUT_MS` for tests and documentation alignment.

- [ ] **Step 1: Write failing lock policy test**

Update the import in `tests/unit/utils/global-lock.test.ts`:

```ts
import {
  acquireGlobalLock,
  GLOBAL_LOCK_RETRIES,
  GLOBAL_LOCK_RETRY_MAX_TIMEOUT_MS,
  GLOBAL_LOCK_RETRY_MIN_TIMEOUT_MS,
  GLOBAL_LOCK_STALE_MS,
} from '../../../src/utils/global-lock.js';
```

Add this test inside `describe('global-lock', () => { ... })`:

```ts
  it('uses bounded proper-lockfile stale and retry policy', () => {
    expect(GLOBAL_LOCK_STALE_MS).toBe(60_000);
    expect(GLOBAL_LOCK_RETRIES).toBe(10);
    expect(GLOBAL_LOCK_RETRY_MIN_TIMEOUT_MS).toBe(100);
    expect(GLOBAL_LOCK_RETRY_MAX_TIMEOUT_MS).toBe(1000);
  });
```

- [ ] **Step 2: Run lock tests and verify they fail**

Run: `npx vitest run tests/unit/utils/global-lock.test.ts`

Expected: FAIL because the lock policy constants are not exported yet.

- [ ] **Step 3: Export constants without changing behavior**

In `src/utils/global-lock.ts`, replace the current lock constants with exported constants:

```ts
export const GLOBAL_LOCK_STALE_MS = 60_000;
export const GLOBAL_LOCK_RETRIES = 10;
export const GLOBAL_LOCK_RETRY_MIN_TIMEOUT_MS = 100;
export const GLOBAL_LOCK_RETRY_MAX_TIMEOUT_MS = 1000;
```

Update the `lockfile.lock()` call to use the exported retry delay constants:

```ts
    const release = await lockfile.lock(lockfilePath, {
      retries: {
        retries: GLOBAL_LOCK_RETRIES,
        minTimeout: GLOBAL_LOCK_RETRY_MIN_TIMEOUT_MS,
        maxTimeout: GLOBAL_LOCK_RETRY_MAX_TIMEOUT_MS,
      },
      stale: GLOBAL_LOCK_STALE_MS,
    });
```

- [ ] **Step 4: Run lock tests and verify they pass**

Run: `npx vitest run tests/unit/utils/global-lock.test.ts`

Expected: PASS for lock acquisition, conflict, independent names, and policy constants.

- [ ] **Step 5: Confirm no in-process-only lock replacement happened**

Run: `npx vitest run tests/unit/utils/global-lock.test.ts tests/unit/plugins/embeddings/ollama.test.ts`

Expected: PASS. `src/utils/global-lock.ts` must still import `proper-lockfile` and use `lockfile.lock(...)` on the OS temp lock path.

- [ ] **Step 6: Review checkpoint**

Do not commit unless the user explicitly requested commits in this execution session. Report: constants exported, behavior unchanged, tests run.

---

### Task 4: Characterize and centralize L1 LRU cache behavior

**Files:**
- Modify: `src/indexer/pipeline.ts:114-130`
- Modify: `src/indexer/pipeline.ts:307-321`
- Modify: `tests/unit/indexer/pipeline-windowed.test.ts`

**Interfaces:**
- Consumes: existing `IndexPipeline` constructor option `embeddingCacheSize?: number`, existing L1 cache implementation in `src/indexer/pipeline.ts`, existing test helpers `createPipeline()`, `addEvent(...)`, `tsFunctions(...)`, and `CountingEmbeddingProvider` in `tests/unit/indexer/pipeline-windowed.test.ts`.
- Produces: `private getL1Cache(hash: string): number[] | undefined`, existing `private setL1Cache(hash: string, vector: number[]): void` with centralized LRU semantics, and characterization/regression coverage proving a cache hit refreshes recency before the next eviction.

- [ ] **Step 1: Write the LRU refresh characterization test**

Add this test inside `describe('IndexPipeline – chunk embedding cache', () => { ... })` in `tests/unit/indexer/pipeline-windowed.test.ts`:

```ts
  it('refreshes L1 recency on cache hit before evicting the oldest entry', async () => {
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    const embedding = new CountingEmbeddingProvider();
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: embedding,
      pluginRegistry: registry,
      embedBatchWindowSize: 16,
      embeddingCacheSize: 2,
    });

    const contentA = tsFunctions(1, 'lru_refresh_a');
    const contentB = tsFunctions(1, 'lru_refresh_b');
    const contentC = tsFunctions(1, 'lru_refresh_c');

    await pipeline.processEvents([addEvent('src/lru_refresh_a.ts', 'h1')], async () => contentA);
    await pipeline.processEvents([addEvent('src/lru_refresh_b.ts', 'h2')], async () => contentB);
    expect(embedding.calls).toBe(2);

    await metadataStore.clearEmbeddings();

    await pipeline.processEvents(
      [{ type: 'modified', filePath: 'src/lru_refresh_a.ts', contentHash: 'h3', detectedAt: new Date().toISOString() }],
      async () => contentA,
    );
    expect(embedding.calls).toBe(2);

    await pipeline.processEvents([addEvent('src/lru_refresh_c.ts', 'h4')], async () => contentC);
    expect(embedding.calls).toBe(3);

    await pipeline.processEvents(
      [{ type: 'modified', filePath: 'src/lru_refresh_b.ts', contentHash: 'h5', detectedAt: new Date().toISOString() }],
      async () => contentB,
    );
    expect(embedding.calls).toBe(4);

    await pipeline.processEvents(
      [{ type: 'modified', filePath: 'src/lru_refresh_a.ts', contentHash: 'h6', detectedAt: new Date().toISOString() }],
      async () => contentA,
    );
    expect(embedding.calls).toBe(4);
  });
```

- [ ] **Step 2: Run the cache tests and characterize current behavior**

Run: `npx vitest run tests/unit/indexer/pipeline-windowed.test.ts`

Expected: PASS is acceptable because existing inline delete-and-set logic may already satisfy LRU semantics. This step is a characterization/regression check, not a red-first TDD failure gate. Continue to Step 3 even if this passes; the refactor is still required to centralize cache semantics and keep `processEventWindow()` readable.

- [ ] **Step 3: Extract L1 cache accessors while preserving behavior**

Update `src/indexer/pipeline.ts` so all L1 hits and inserts use these exact helper semantics:

```ts
  private getL1Cache(hash: string): number[] | undefined {
    if (this.embeddingCacheSize <= 0) {
      return undefined;
    }
    const cached = this.embeddingCache.get(hash);
    if (cached === undefined) {
      return undefined;
    }
    this.embeddingCache.delete(hash);
    this.embeddingCache.set(hash, cached);
    return cached;
  }

  private setL1Cache(hash: string, vector: number[]): void {
    if (this.embeddingCacheSize <= 0) {
      return;
    }
    if (this.embeddingCache.has(hash)) {
      this.embeddingCache.delete(hash);
      this.embeddingCache.set(hash, vector);
      return;
    }
    if (this.embeddingCache.size >= this.embeddingCacheSize) {
      const oldestKey = this.embeddingCache.keys().next().value as string | undefined;
      if (oldestKey !== undefined) {
        this.embeddingCache.delete(oldestKey);
      }
    }
    this.embeddingCache.set(hash, vector);
  }
```

Then replace the inline L1 lookup in `processEventWindow()` with:

```ts
      const cached = this.getL1Cache(chunk.hash);
      if (cached !== undefined) {
        return cached;
      }
```

- [ ] **Step 4: Run cache tests again after refactor**

Run: `npx vitest run tests/unit/indexer/pipeline-windowed.test.ts`

Expected: PASS for all windowed pipeline and cache tests.

- [ ] **Step 5: Run rename skip regression test**

Run: `npx vitest run tests/unit/indexer/rename-detection.test.ts`

Expected: PASS. This confirms matching delete/add content hashes still move vector paths without calling `embeddingProvider.embed()`.

- [ ] **Step 6: Review checkpoint**

Do not commit unless the user explicitly requested commits in this execution session. Report: production pipeline code changed by extracting `getL1Cache()` and preserving `setL1Cache()` semantics, and whether the pre-refactor test already passed.

---

### Task 5: Final verification and documentation consistency

**Files:**
- Verify: `docs/superpowers/specs/2026-06-19-ollama-cpu-mitigation-design.md`
- Verify: `docs/superpowers/plans/2026-06-19-ollama-cpu-mitigation.md`
- Verify: all files changed by Tasks 1-4.

**Interfaces:**
- Consumes: completed Tasks 1-4.
- Produces: verified implementation with no type, lint, build, or test regressions.

- [ ] **Step 1: Run focused regression tests**

Run:

```bash
npx vitest run tests/unit/config/index.test.ts tests/unit/plugins/embeddings/ollama.test.ts tests/unit/utils/global-lock.test.ts tests/unit/indexer/pipeline-windowed.test.ts tests/unit/indexer/rename-detection.test.ts
```

Expected: PASS for all listed test files.

- [ ] **Step 2: Run full test suite**

Run: `npm test`

Expected: Exit 0 with Vitest reporting all tests passed.

- [ ] **Step 3: Run build**

Run: `npm run build`

Expected: Exit 0. `tsc -p tsconfig.build.json` and dashboard build both complete successfully.

- [ ] **Step 4: Run lint**

Run: `npm run lint`

Expected: Exit 0 with no ESLint errors.

- [ ] **Step 5: Inspect final diff**

Run only if git commands are explicitly allowed in the execution session. Otherwise, use file reads or editor diff tooling.

If allowed, run: `git diff -- src/types/index.ts src/config/index.ts src/plugins/embeddings/ollama.ts src/utils/global-lock.ts tests/unit/config/index.test.ts tests/unit/plugins/embeddings/ollama.test.ts tests/unit/utils/global-lock.test.ts tests/unit/indexer/pipeline-windowed.test.ts docs/superpowers/specs/2026-06-19-ollama-cpu-mitigation-design.md docs/superpowers/plans/2026-06-19-ollama-cpu-mitigation.md`

Expected: Diff only contains the planned config, payload, lock-policy export, cache-test, and documentation changes.

- [ ] **Step 6: Final report**

Report these exact items:

```text
Implemented:
- Configurable Ollama num_thread with default 2 and accepted range 1..16.
- Ollama /api/embed payload now sends options.num_thread.
- Global lock policy constants are exported and tested.
- L1 cache LRU refresh/eviction behavior is tested.
- Rename skip behavior remains covered.

Verification:
- Focused Vitest files: PASS
- npm test: PASS
- npm run build: PASS
- npm run lint: PASS
```

If any verification command fails, do not claim completion. Report the failing command, the first relevant error, and the next required fix.

---

## Self-Review

- Spec coverage: Task 1 covers bounded `NEXUS_OLLAMA_NUM_THREAD` and documents the `1..16` helper intent with JSDoc; Task 2 covers Ollama payload; Task 3 covers `proper-lockfile` bounded process-lock policy; Task 4 covers L1/L2 cache, centralized L1 accessors, and LRU recency; existing `rename-detection.test.ts` plus Task 4 Step 5 covers Merkle rename skip behavior; Task 5 covers final verification commands.
- Placeholder scan: no incomplete-marker wording or unspecified edge handling remains in this plan.
- Type consistency: `ollamaNumThread` is consistently used as `EmbeddingConfig.ollamaNumThread`, provider config pick field, and JSON payload `options.num_thread`.
