# LanceDB 実統合 & Compaction Pipeline 統合 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nexus の `LanceVectorStore` をインメモリ Map 実装から `@lancedb/lancedb` による永続化・ベクトル検索実装に書き換え、Compaction Pipeline を `IndexPipeline` に統合する。

**Architecture:** `IVectorStore` インターフェースに `close()` を追加し、Contract Tests で `InMemoryVectorStore` と `LanceVectorStore` の振る舞い等価性を保証する。LanceDB 書き換え前に mergeInsert の振る舞いを Spike テストで実証的に確定し、その結果に基づいて upsertChunks の実装パスを決定する。Pipeline には post-reindex compaction と idle-time compaction タイマーを追加する。

**Tech Stack:** TypeScript, `@lancedb/lancedb` ^0.18.2, `async-mutex` ^0.5.0, Vitest

---

## File Structure

### 変更するファイル

| ファイル | 責務 |
|----------|------|
| `src/types/index.ts` | `IVectorStore` に `close(): Promise<void>` 追加 |
| `src/storage/vector-store.ts` | Map ベース → `@lancedb/lancedb` 実装に全面書き換え |
| `src/indexer/pipeline.ts` | compactAfterReindex, idle compaction タイマー, stop() 拡張 |
| `tests/unit/storage/in-memory-vector-store.ts` | `close()` の no-op 実装追加 |
| `tests/integration/pipeline.test.ts` | `LanceVectorStore` コンストラクタ引数修正 |

### 移動するファイル

| 移動元 | 移動先 |
|--------|--------|
| `tests/unit/storage/vector-store.test.ts` | `tests/integration/vector-store.test.ts` |

### 新規作成するファイル

| ファイル | 責務 |
|----------|------|
| `tests/shared/vector-store-contract.ts` | `IVectorStore` Contract Test スイート |
| `tests/unit/storage/in-memory-vector-store.test.ts` | InMemoryVectorStore の Contract Tests |
| `tests/unit/storage/filter-validation-and-escape.test.ts` | validateFilterValue / escapeFilterValue / escapeLikeValue セキュリティ単体テスト |
| `tests/unit/storage/vector-store-inflight.test.ts` | trackOp / close() のインフライト I/O テスト |
| `tests/spike/mergeinsert-behavior.test.ts` | mergeInsert 振る舞い Spike テスト |

---

## Task 1: `IVectorStore` に `close()` メソッドを追加

**Files:**
- Modify: `src/types/index.ts:112-129`

- [ ] **Step 1: `IVectorStore` インターフェースに `close()` を追加**

`src/types/index.ts` の `IVectorStore` インターフェースに `close(): Promise<void>` を追加する:

```typescript
export interface IVectorStore {
  initialize(): Promise<void>;
  upsertChunks(chunks: CodeChunk[], embeddings?: number[][]): Promise<void>;
  deleteByFilePath(filePath: string): Promise<number>;
  deleteByPathPrefix(pathPrefix: string): Promise<number>;
  renameFilePath(oldPath: string, newPath: string): Promise<number>;
  search(queryVector: number[], topK: number, filter?: VectorFilter): Promise<VectorSearchResult[]>;
  compactIfNeeded(config?: Partial<CompactionConfig>): Promise<CompactionResult>;
  compactAfterReindex(config?: Partial<CompactionConfig>): Promise<CompactionResult>;
  scheduleIdleCompaction(
    runCompaction: () => Promise<void>,
    delayMs?: number,
    mutex?: CompactionMutex,
    abortSignal?: AbortSignal,
    mutexTimeoutMs?: number,
  ): NodeJS.Timeout;
  getStats(): Promise<VectorStoreStats>;
  close(): Promise<void>;
}
```

- [ ] **Step 2: ビルド確認**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: `close()` が実装されていないため `LanceVectorStore` と `InMemoryVectorStore` でコンパイルエラーが発生する。これは期待通りの挙動であり、Task 2 で修正する。

---

## Task 2: `InMemoryVectorStore` に `close()` の no-op 実装を追加

**Files:**
- Modify: `tests/unit/storage/in-memory-vector-store.ts`
- Modify: `src/storage/vector-store.ts`

- [ ] **Step 1: `InMemoryVectorStore` に `close()` を追加**

`tests/unit/storage/in-memory-vector-store.ts` の `InMemoryVectorStore` クラスに以下を追加（`getStats()` メソッドの後に配置）:

```typescript
async close(): Promise<void> {
  // No-op: InMemoryVectorStore has no external resources to release.
}
```

- [ ] **Step 2: `src/storage/vector-store.ts` に暫定的な `close()` を追加**

`LanceVectorStore` にも暫定的な `close()` を追加して、コンパイルを通す:

```typescript
async close(): Promise<void> {
  // TODO: LanceDB 実装で trackOp + インフライト I/O 待機に置き換える
}
```

- [ ] **Step 3: ビルド確認**

Run: `npx tsc --noEmit`
Expected: コンパイルエラーなし

- [ ] **Step 4: 既存テスト実行**

Run: `npx vitest run tests/unit/storage/ tests/unit/indexer/pipeline.test.ts --reporter=verbose`
Expected: 既存テスト全パス（`close()` 追加は non-breaking）

- [ ] **Step 5: コミット**

```bash
git add src/types/index.ts tests/unit/storage/in-memory-vector-store.ts src/storage/vector-store.ts
git commit -m "feat(types): IVectorStore に close() メソッドを追加"
```

---

## Task 3: Contract Tests 共通スイート作成

**Files:**
- Create: `tests/shared/vector-store-contract.ts`

- [ ] **Step 1: Contract Test スイートのフェイリングテストを作成**

```typescript
// tests/shared/vector-store-contract.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { CodeChunk, IVectorStore } from '../../src/types/index.js';

const makeChunk = (overrides: Partial<CodeChunk> = {}): CodeChunk => ({
  id: overrides.id ?? 'chunk-1',
  filePath: overrides.filePath ?? 'src/index.ts',
  content: overrides.content ?? 'export const value = 1;',
  language: overrides.language ?? 'typescript',
  symbolName: overrides.symbolName,
  symbolKind: overrides.symbolKind ?? 'function',
  startLine: overrides.startLine ?? 1,
  endLine: overrides.endLine ?? 1,
  hash: overrides.hash ?? 'hash-1',
});

/**
 * IVectorStore の Contract Test スイート。
 * ファクトリ関数を受け取り、任意の IVectorStore 実装に対してテストを実行する。
 */
export function vectorStoreContractTests(
  factory: () => Promise<{ store: IVectorStore; cleanup: () => Promise<void> }>,
): void {
  let store: IVectorStore;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ store, cleanup } = await factory());
  });

  afterEach(async () => {
    await cleanup();
  });

  describe('Contract: IVectorStore', () => {
    it('initialize() — 二重呼び出しで冪等', async () => {
      await expect(store.initialize()).resolves.toBeUndefined();
      await expect(store.initialize()).resolves.toBeUndefined();
    });

    it('upsertChunks() → search() で取得可能', async () => {
      const embedding = Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0));
      await store.upsertChunks(
        [makeChunk({ id: 'a', filePath: 'src/a.ts' })],
        [embedding],
      );
      const results = await store.search(embedding, 10);
      expect(results).toHaveLength(1);
      expect(results[0]?.chunk.id).toBe('a');
    });

    it('deleteByFilePath() — 該当ファイルのチャンクが全削除', async () => {
      const embedding = Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0));
      await store.upsertChunks(
        [
          makeChunk({ id: 'a1', filePath: 'src/a.ts' }),
          makeChunk({ id: 'b1', filePath: 'src/b.ts' }),
        ],
        [embedding, embedding],
      );
      const deleted = await store.deleteByFilePath('src/a.ts');
      expect(deleted).toBe(1);
      const results = await store.search(embedding, 10);
      expect(results).toHaveLength(1);
      expect(results[0]?.chunk.filePath).toBe('src/b.ts');
    });

    it('deleteByPathPrefix() — プレフィックス配下の全チャンク削除', async () => {
      const embedding = Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0));
      await store.upsertChunks(
        [
          makeChunk({ id: 'a1', filePath: 'src/a.ts' }),
          makeChunk({ id: 'b1', filePath: 'src/nested/b.ts' }),
          makeChunk({ id: 'c1', filePath: 'tests/test.ts' }),
        ],
        [embedding, embedding, embedding],
      );
      const deleted = await store.deleteByPathPrefix('src');
      expect(deleted).toBe(2);
      const results = await store.search(embedding, 10);
      expect(results).toHaveLength(1);
      expect(results[0]?.chunk.filePath).toBe('tests/test.ts');
    });

    it('renameFilePath() — 新パスで検索可能、旧パスでは 0 件、更新行数が正確', async () => {
      const embedding = Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0));
      await store.upsertChunks(
        [
          makeChunk({ id: 'src/file.ts:1-10', filePath: 'src/file.ts' }),
          makeChunk({ id: 'src/file.ts:11-20', filePath: 'src/file.ts' }),
        ],
        [embedding, embedding],
      );

      const count = await store.renameFilePath('src/file.ts', 'src/moved.ts');
      expect(count).toBe(2);

      const results = await store.search(embedding, 10);
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.chunk.filePath === 'src/moved.ts')).toBe(true);
    });

    it('search() — topK 制限', async () => {
      const embedding = Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0));
      await store.upsertChunks(
        [
          makeChunk({ id: 'a', filePath: 'src/a.ts' }),
          makeChunk({ id: 'b', filePath: 'src/b.ts' }),
          makeChunk({ id: 'c', filePath: 'src/c.ts' }),
        ],
        [embedding, embedding, embedding],
      );
      const results = await store.search(embedding, 2);
      expect(results).toHaveLength(2);
    });

    it('search() — filter 適用', async () => {
      const embedding = Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0));
      await store.upsertChunks(
        [
          makeChunk({ id: 'a', filePath: 'src/a.ts', language: 'typescript' }),
          makeChunk({ id: 'b', filePath: 'src/b.py', language: 'python' }),
        ],
        [embedding, embedding],
      );
      const results = await store.search(embedding, 10, { language: 'typescript' });
      expect(results).toHaveLength(1);
      expect(results[0]?.chunk.language).toBe('typescript');
    });

    it('getStats() — レコード数が正確', async () => {
      const embedding = Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0));
      await store.upsertChunks(
        [
          makeChunk({ id: 'a', filePath: 'src/a.ts' }),
          makeChunk({ id: 'b', filePath: 'src/b.ts' }),
        ],
        [embedding, embedding],
      );
      const stats = await store.getStats();
      expect(stats.totalChunks).toBe(2);
    });

    it('close() — 二重呼び出しで冪等（例外をスローしない）', async () => {
      await expect(store.close()).resolves.toBeUndefined();
      await expect(store.close()).resolves.toBeUndefined();
    });
  });
}
```

- [ ] **Step 2: ビルド確認**

Run: `npx tsc --noEmit`
Expected: コンパイルエラーなし

---

## Task 4: InMemoryVectorStore の Contract Tests 適用

**Files:**
- Create: `tests/unit/storage/in-memory-vector-store.test.ts`

- [ ] **Step 1: InMemoryVectorStore 用の Contract Test ファイルを作成**

```typescript
// tests/unit/storage/in-memory-vector-store.test.ts
import { describe } from 'vitest';

import { vectorStoreContractTests } from '../../shared/vector-store-contract.js';
import { InMemoryVectorStore } from './in-memory-vector-store.js';

describe('InMemoryVectorStore', () => {
  vectorStoreContractTests(async () => ({
    store: new InMemoryVectorStore({ dimensions: 64 }),
    cleanup: async () => {},
  }));
});
```

- [ ] **Step 2: テスト実行**

Run: `npx vitest run tests/unit/storage/in-memory-vector-store.test.ts --reporter=verbose`
Expected: Contract Tests が全パス

- [ ] **Step 3: コミット**

```bash
git add tests/shared/vector-store-contract.ts tests/unit/storage/in-memory-vector-store.test.ts
git commit -m "test: IVectorStore Contract Tests を作成し InMemoryVectorStore に適用"
```

---

## Task 5: セキュリティ単体テスト（validateFilterValue / escapeFilterValue / escapeLikeValue）

**Files:**
- Create: `tests/unit/storage/filter-validation-and-escape.test.ts`
- Modify: `src/storage/vector-store.ts`

> [!IMPORTANT]
> このタスクでは `LanceVectorStore` にセキュリティユーティリティ（`validateFilterValue`, `escapeFilterValue`, `escapeLikeValue`, `filePathFilter`, `filePathPrefixFilter`）を TDD で実装する。これらのメソッドは設計仕様書では `private` だが、テスト可能性のために `protected` にする。テスト用サブクラス `TestableLanceVectorStore` 経由でアクセスする。

- [ ] **Step 1: Red — validateFilterValue テストを作成**

```typescript
// tests/unit/storage/filter-validation-and-escape.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { LanceVectorStore } from '../../../src/storage/vector-store.js';

// テスト用サブクラス: protected メソッドへのアクセスブリッジ
class TestableLanceVectorStore extends LanceVectorStore {
  testValidateFilterValue(value: string, paramName: string): void {
    return this.validateFilterValue(value, paramName);
  }

  testEscapeFilterValue(value: string): string {
    return this.escapeFilterValue(value);
  }

  testEscapeLikeValue(value: string): string {
    return this.escapeLikeValue(value);
  }

  testFilePathFilter(filePath: string): string {
    return this.filePathFilter(filePath);
  }

  testFilePathPrefixFilter(prefix: string): string {
    return this.filePathPrefixFilter(prefix);
  }
}

describe('Filter Validation and Escape', () => {
  let store: TestableLanceVectorStore;

  beforeEach(() => {
    store = new TestableLanceVectorStore({ dimensions: 64 });
  });

  describe('validateFilterValue()', () => {
    it('正常パス（ASCII）— 例外をスローしない', () => {
      expect(() => store.testValidateFilterValue('src/utils/parser.ts', 'filePath')).not.toThrow();
    });

    it('正常パス（ドット付き）— 例外をスローしない', () => {
      expect(() => store.testValidateFilterValue('./src/index.ts', 'filePath')).not.toThrow();
    });

    it('正常パス（コロン付き ID）— 例外をスローしない', () => {
      expect(() => store.testValidateFilterValue('src/main.ts:1-10', 'filePath')).not.toThrow();
    });

    it('空文字列 — 例外をスローしない', () => {
      expect(() => store.testValidateFilterValue('', 'filePath')).not.toThrow();
    });

    it('Null バイト — Error をスロー', () => {
      expect(() => store.testValidateFilterValue('file\0path', 'filePath'))
        .toThrow('contains control characters');
    });

    it('改行文字 — Error をスロー', () => {
      expect(() => store.testValidateFilterValue('file\npath', 'filePath'))
        .toThrow('contains control characters');
    });

    it('CR/LF 混在 — Error をスロー', () => {
      expect(() => store.testValidateFilterValue('file\r\npath', 'filePath'))
        .toThrow('contains control characters');
    });

    it('タブ文字 — Error をスロー', () => {
      expect(() => store.testValidateFilterValue('file\tpath', 'filePath'))
        .toThrow('contains control characters');
    });

    it('DEL 文字 — Error をスロー', () => {
      expect(() => store.testValidateFilterValue('file\x7fpath', 'filePath'))
        .toThrow('contains control characters');
    });

    it('非 ASCII（日本語）— 例外をスローしない', () => {
      expect(() => store.testValidateFilterValue('ソース/main.ts', 'filePath')).not.toThrow();
    });

    it('非 ASCII（絵文字）— 例外をスローしない', () => {
      expect(() => store.testValidateFilterValue('src/🚀.ts', 'filePath')).not.toThrow();
    });

    it('制御文字混入 Unicode — Error をスロー', () => {
      expect(() => store.testValidateFilterValue('ソース/ma\x00in.ts', 'filePath'))
        .toThrow('contains control characters');
    });

    it('Private Use Area — Error をスロー', () => {
      expect(() => store.testValidateFilterValue('\uE000path', 'filePath'))
        .toThrow('contains characters outside the allowed set');
    });

    it('BOM（Byte Order Mark）— Error をスロー', () => {
      expect(() => store.testValidateFilterValue('\uFEFFsrc/main.ts', 'filePath'))
        .toThrow('contains characters outside the allowed set');
    });

    it('ゼロ幅スペース — Error をスロー', () => {
      expect(() => store.testValidateFilterValue('src/ma\u200Bin.ts', 'filePath'))
        .toThrow('contains characters outside the allowed set');
    });
  });

  describe('escapeFilterValue()', () => {
    it('基本エスケープ — シングルクォート', () => {
      expect(store.testEscapeFilterValue("O'Brien")).toBe("O''Brien");
    });

    it('バックスラッシュ', () => {
      expect(store.testEscapeFilterValue('path\\to\\file')).toBe('path\\\\to\\\\file');
    });

    it('複合攻撃 — SQL インジェクション', () => {
      const result = store.testEscapeFilterValue("'; DROP TABLE chunks --");
      expect(result).toBe("''; DROP TABLE chunks --");
    });

    it('SQL コメント — リテラルとして保持', () => {
      const result = store.testEscapeFilterValue('file /* comment */ path');
      expect(result).toBe('file /* comment */ path');
    });

    it('セミコロン — リテラルとして保持', () => {
      const result = store.testEscapeFilterValue('file; SELECT * FROM t');
      expect(result).toBe('file; SELECT * FROM t');
    });

    it('空文字列 — 安全に処理', () => {
      expect(store.testEscapeFilterValue('')).toBe('');
    });

    it('超長文字列 — 例外やバッファ溢れなし', () => {
      const longStr = 'a'.repeat(10_000);
      expect(() => store.testEscapeFilterValue(longStr)).not.toThrow();
      expect(store.testEscapeFilterValue(longStr)).toBe(longStr);
    });
  });

  describe('escapeLikeValue()', () => {
    it('アンダースコア含有パス', () => {
      expect(store.testEscapeLikeValue('src/my_file.ts')).toBe('src/my\\_file.ts');
    });

    it('パーセント含有パス', () => {
      expect(store.testEscapeLikeValue('src/100%.ts')).toBe('src/100\\%.ts');
    });

    it('複合ワイルドカード', () => {
      const result = store.testEscapeLikeValue('src/my_module/100%_done');
      expect(result).toContain('\\_');
      expect(result).toContain('\\%');
    });

    it('ワイルドカード無しのパス — 変換なし', () => {
      expect(store.testEscapeLikeValue('src/utils/parser.ts')).toBe('src/utils/parser.ts');
    });

    it('クォートとワイルドカード混在', () => {
      const result = store.testEscapeLikeValue("src/O'Brien_file.ts");
      expect(result).toContain("''");
      expect(result).toContain('\\_');
    });
  });

  describe('統合フロー（filePathFilter / filePathPrefixFilter）', () => {
    it('制御文字を含むパス — validateFilterValue で例外スロー', () => {
      expect(() => store.testFilePathFilter('file\0path')).toThrow('contains control characters');
    });

    it('正常入力の貫通 — 正しいフィルタ文字列が構築される', () => {
      const result = store.testFilePathFilter('src/utils/parser.ts');
      expect(result).toBe("filePath = 'src/utils/parser.ts'");
    });

    it('LIKE ワイルドカードの安全なプレフィックス検索', () => {
      const result = store.testFilePathPrefixFilter('src/my_module');
      expect(result).toContain('LIKE');
      expect(result).toContain('\\_');
      expect(result).toContain("ESCAPE '\\\\'");
    });

    it('ESCAPE 句の付与', () => {
      const result = store.testFilePathPrefixFilter('src/utils');
      expect(result).toContain("ESCAPE '\\\\'");
    });

    it('完全一致フィルタに ESCAPE なし', () => {
      const result = store.testFilePathFilter('src/utils/parser.ts');
      expect(result).not.toContain('ESCAPE');
    });
  });
});
```

- [ ] **Step 2: テスト実行 — Red 確認**

Run: `npx vitest run tests/unit/storage/filter-validation-and-escape.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: FAIL（`validateFilterValue` 等のメソッドが存在しないため）

- [ ] **Step 3: Green — セキュリティユーティリティを実装**

`src/storage/vector-store.ts` の `LanceVectorStore` クラスに以下の `protected` メソッドを追加する（`close()` メソッドの後に配置）:

```typescript
// --- フィルタ値検証・エスケープユーティリティ ---

private static readonly ALLOWED_FILTER_VALUE_PATTERN = /^[\p{L}\p{N}\p{P}\p{Z}\p{S}]*$/u;
private static readonly FORBIDDEN_CONTROL_CHARS = /[\x00-\x1f\x7f]/;

protected validateFilterValue(value: string, paramName: string): void {
  if (LanceVectorStore.FORBIDDEN_CONTROL_CHARS.test(value)) {
    throw new Error(
      `Invalid ${paramName}: contains control characters that could compromise filter integrity`
    );
  }
  if (!LanceVectorStore.ALLOWED_FILTER_VALUE_PATTERN.test(value)) {
    throw new Error(
      `Invalid ${paramName}: contains characters outside the allowed set (printable Unicode only)`
    );
  }
}

protected escapeFilterValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "''");
}

protected escapeLikeValue(value: string): string {
  const escaped = this.escapeFilterValue(value);
  return escaped.replace(/%/g, '\\%').replace(/_/g, '\\_');
}

protected filePathFilter(filePath: string): string {
  this.validateFilterValue(filePath, 'filePath');
  return `filePath = '${this.escapeFilterValue(filePath)}'`;
}

protected filePathPrefixFilter(prefix: string): string {
  this.validateFilterValue(prefix, 'prefix');
  return `filePath LIKE '${this.escapeLikeValue(prefix)}%' ESCAPE '\\\\'`;
}
```

> [!NOTE]
> 設計仕様書では `private` だが、テスト可能性のために `protected` にする。テスト用サブクラス `TestableLanceVectorStore` 経由でアクセスする。

- [ ] **Step 4: テスト実行 — Green 確認**

Run: `npx vitest run tests/unit/storage/filter-validation-and-escape.test.ts --reporter=verbose`
Expected: 全テストパス

- [ ] **Step 5: コミット**

```bash
git add src/storage/vector-store.ts tests/unit/storage/filter-validation-and-escape.test.ts
git commit -m "feat(storage): フィルタ値検証・エスケープユーティリティを TDD で実装"
```

---

## Task 6: mergeInsert Spike テスト

**Files:**
- Create: `tests/spike/mergeinsert-behavior.test.ts`

> [!CAUTION]
> **ブロック要件:** このタスクで Spike テストを実行し、結果を確定させるまで、Task 8（LanceVectorStore の LanceDB 実装書き換え）の `upsertChunks()` に関連する実装には着手しないこと。

- [ ] **Step 1: Spike テストファイルを作成**

```typescript
// tests/spike/mergeinsert-behavior.test.ts
// 前提: @lancedb/lancedb@0.18.2 (package.json の固定バージョン)
// このテストの結果は上記バージョンでの振る舞いに基づく。
// バージョンアップ時のリグレッション検出テストとして維持する。
import { describe, it, expect, afterEach } from 'vitest';
import * as lancedb from '@lancedb/lancedb';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('Spike: mergeInsert behavior verification', () => {
  let tmpDir: string;
  let db: lancedb.Connection;

  afterEach(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('should clarify whether mergeInsert removes unmatched old rows', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'nexus-spike-'));
    db = await lancedb.connect(tmpDir);

    // 1. テーブルに 2 行を挿入
    const initialData = [
      { id: 'file:1-10', filePath: 'src/file.ts', content: 'line1', vector: [1, 0, 0] },
      { id: 'file:11-20', filePath: 'src/file.ts', content: 'line2', vector: [0, 1, 0] },
    ];
    const table = await db.createTable('chunks', initialData);

    // 2. mergeInsert で id="file:1-10" を更新し、id="file:21-30" を挿入
    //    id="file:11-20" は新データに含まれない
    const newData = [
      { id: 'file:1-10', filePath: 'src/file.ts', content: 'updated-line1', vector: [1, 0, 0] },
      { id: 'file:21-30', filePath: 'src/file.ts', content: 'line3', vector: [0, 0, 1] },
    ];

    await table
      .mergeInsert('id')
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(newData);

    // 3. 全行を取得
    const allRows = await table.query().toArray();
    const allIds = allRows.map((row: Record<string, unknown>) => row['id']).sort();

    // 結果を記録
    const oldRowExists = allIds.includes('file:11-20');
    console.log('--- Spike Result ---');
    console.log('All IDs after mergeInsert:', allIds);
    console.log('Old row (file:11-20) exists:', oldRowExists);

    if (oldRowExists) {
      console.log('=> Path (B): mergeInsert does NOT remove unmatched old rows');
      console.log('=> upsertChunks must use delete-then-add pattern');
      // パス B: 旧行が残っている
      expect(allRows).toHaveLength(3);
      expect(allIds).toEqual(['file:1-10', 'file:11-20', 'file:21-30']);
    } else {
      console.log('=> Path (A): mergeInsert DOES remove unmatched old rows');
      console.log('=> upsertChunks can use mergeInsert as single operation');
      // パス A: 旧行が自動削除された
      expect(allRows).toHaveLength(2);
      expect(allIds).toEqual(['file:1-10', 'file:21-30']);
    }
  });
});
```

- [ ] **Step 2: Spike テスト実行**

Run: `npx vitest run tests/spike/mergeinsert-behavior.test.ts --reporter=verbose`
Expected: テストがパスし、パス (A) または (B) のどちらかが確定する

- [ ] **Step 3: 結果をテストファイルに記録**

テスト実行結果に基づき、テストファイルの冒頭コメントに以下の形式で結果を追記:

```typescript
// Spike 結果: パス (A) 確定 — mergeInsert は旧行を自動削除する
// または
// Spike 結果: パス (B) 確定 — mergeInsert は旧行を自動削除しない
```

- [ ] **Step 4: コミット**

```bash
git add tests/spike/mergeinsert-behavior.test.ts
git commit -m "test(spike): mergeInsert の振る舞い検証テストを実施"
```

---

## Task 7: In-flight I/O トラッキングテスト（基本）

**Files:**
- Create: `tests/unit/storage/vector-store-inflight.test.ts`

- [ ] **Step 1: Red — インフライト I/O テストを作成**

```typescript
// tests/unit/storage/vector-store-inflight.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { LanceVectorStore } from '../../../src/storage/vector-store.js';

describe('LanceVectorStore close() behavior', () => {
  let store: LanceVectorStore;

  beforeEach(() => {
    store = new LanceVectorStore({ dimensions: 64 });
  });

  it('close() — インフライト操作なしの場合は即座にリソースが解放される', async () => {
    await expect(store.close()).resolves.toBeUndefined();
  });

  it('close() — 二重呼び出しで冪等（2回目は即座に return）', async () => {
    await store.close();
    await expect(store.close()).resolves.toBeUndefined();
  });
});
```

> [!NOTE]
> `trackOp` の完全なテスト（インフライト操作中の close() 待機、タイムアウト、closing 状態での操作拒否等）は Task 8 の LanceDB 実装完了後にこのファイルに追加する。

- [ ] **Step 2: テスト実行 — 確認**

Run: `npx vitest run tests/unit/storage/vector-store-inflight.test.ts --reporter=verbose`
Expected: 全テストパス

- [ ] **Step 3: コミット**

```bash
git add tests/unit/storage/vector-store-inflight.test.ts
git commit -m "test(storage): close() の基本動作テストを追加"
```

---

## Task 8: LanceVectorStore の LanceDB 実装書き換え

**Files:**
- Modify: `src/storage/vector-store.ts` (全面書き換え)

> [!CAUTION]
> **前提条件:**
>
> - Task 6 の Spike テスト結果が確定していること
> - Task 5 のセキュリティユーティリティが実装済みであること
> - Task 4 の Contract Tests がパスしていること

- [ ] **Step 1: `LanceVectorStoreOptions` に `dbPath` を追加**

`src/storage/vector-store.ts` の `LanceVectorStoreOptions` インターフェースを更新:

```typescript
interface LanceVectorStoreOptions {
  dbPath: string;       // e.g. "<projectRoot>/.nexus/lancedb"
  dimensions: number;   // embedding 次元数
}
```

- [ ] **Step 2: LanceDB 依存の import とプロパティ追加**

ファイル冒頭に追加:

```typescript
import * as lancedb from '@lancedb/lancedb';
import type { Table } from '@lancedb/lancedb';
import { mkdir } from 'node:fs/promises';
```

クラスのプロパティを更新（Map ベースのプロパティを全て削除し、以下に置き換え）:

```typescript
private readonly dbPath: string;
private readonly dimensions: number;
private db: lancedb.Connection | undefined;
private table: Table | undefined;

// In-flight I/O tracking
private inflightOps = 0;
private closingResolve: (() => void) | undefined = undefined;
private closing = false;
private static readonly CLOSE_TIMEOUT_MS = 5_000;
private static readonly CLEANUP_GRACE_PERIOD_MS = 300_000; // 5分
```

- [ ] **Step 3: コンストラクタ更新**

```typescript
constructor(options: LanceVectorStoreOptions) {
  if (!Number.isInteger(options.dimensions) || options.dimensions <= 0) {
    throw new Error('dimensions must be a positive integer');
  }
  this.dbPath = options.dbPath;
  this.dimensions = options.dimensions;
}
```

- [ ] **Step 4: initialize() の LanceDB 実装**

```typescript
async initialize(): Promise<void> {
  if (this.db) {
    return; // 冪等性
  }
  await mkdir(this.dbPath, { recursive: true });
  this.db = await lancedb.connect(this.dbPath);
  const tableNames = await this.db.tableNames();
  if (tableNames.includes('chunks')) {
    this.table = await this.db.openTable('chunks');
  }
}
```

- [ ] **Step 5: trackOp の実装**

```typescript
private async trackOp<T>(op: () => Promise<T>): Promise<T> {
  if (this.closing) {
    throw new Error('VectorStore is closing, no new operations accepted');
  }
  this.inflightOps++;
  try {
    return await op();
  } finally {
    this.inflightOps--;
    if (this.closing && this.inflightOps === 0 && this.closingResolve) {
      this.closingResolve();
    }
  }
}
```

- [ ] **Step 6: close() の完全実装**

```typescript
async close(): Promise<void> {
  if (this.closing) {
    return;
  }
  this.closing = true;

  if (this.inflightOps > 0) {
    const inflightDone = new Promise<void>((resolve) => {
      this.closingResolve = resolve;
    });
    const timeout = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), LanceVectorStore.CLOSE_TIMEOUT_MS);
    });
    const result = await Promise.race([inflightDone.then(() => 'done' as const), timeout]);
    if (result === 'timeout') {
      console.error(
        `[LanceVectorStore] close() timed out after ${LanceVectorStore.CLOSE_TIMEOUT_MS}ms ` +
        `with ${this.inflightOps} in-flight operation(s). Forcing resource release.`
      );
    }
  }

  this.table = undefined;
  this.db = undefined;
  this.closing = false;
  this.closingResolve = undefined;
}
```

- [ ] **Step 7: upsertChunks 実装（Spike 結果に応じて分岐）**

**パス (B) — 旧行残存 の場合:**

```typescript
async upsertChunks(chunks: CodeChunk[], embeddings?: number[][]): Promise<void> {
  if (embeddings && embeddings.length !== chunks.length) {
    throw new Error(
      `embeddings length mismatch (expected ${chunks.length}, got ${embeddings.length})`
    );
  }
  const rows = chunks.map((chunk, i) => ({
    id: chunk.id,
    filePath: chunk.filePath,
    content: chunk.content,
    language: chunk.language,
    symbolName: chunk.symbolName ?? '',
    symbolKind: chunk.symbolKind,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    hash: chunk.hash,
    vector: embeddings ? embeddings[i]! : [],
  }));

  await this.trackOp(async () => {
    if (!this.table) {
      this.table = await this.db!.createTable('chunks', rows);
      return;
    }
    // パス B: delete-then-add
    const filePaths = [...new Set(chunks.map((c) => c.filePath))];
    for (const fp of filePaths) {
      await this.table.delete(this.filePathFilter(fp));
    }
    await this.table.add(rows);
  });
}
```

**パス (A) — 旧行自動削除 の場合:**

```typescript
async upsertChunks(chunks: CodeChunk[], embeddings?: number[][]): Promise<void> {
  if (embeddings && embeddings.length !== chunks.length) {
    throw new Error(
      `embeddings length mismatch (expected ${chunks.length}, got ${embeddings.length})`
    );
  }
  const rows = chunks.map((chunk, i) => ({
    id: chunk.id,
    filePath: chunk.filePath,
    content: chunk.content,
    language: chunk.language,
    symbolName: chunk.symbolName ?? '',
    symbolKind: chunk.symbolKind,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    hash: chunk.hash,
    vector: embeddings ? embeddings[i]! : [],
  }));

  await this.trackOp(async () => {
    if (!this.table) {
      this.table = await this.db!.createTable('chunks', rows);
      return;
    }
    // パス A: mergeInsert 単体
    await this.table
      .mergeInsert('id')
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(rows);
  });
}
```

- [ ] **Step 8: deleteByFilePath 実装**

```typescript
async deleteByFilePath(filePath: string): Promise<number> {
  return this.trackOp(async () => {
    if (!this.table) return 0;
    const before = await this.table.countRows(this.filePathFilter(filePath));
    await this.table.delete(this.filePathFilter(filePath));
    return before;
  });
}
```

- [ ] **Step 9: deleteByPathPrefix 実装**

```typescript
async deleteByPathPrefix(pathPrefix: string): Promise<number> {
  return this.trackOp(async () => {
    if (!this.table) return 0;
    const filter = this.filePathPrefixFilter(pathPrefix);
    const before = await this.table.countRows(filter);
    await this.table.delete(filter);
    return before;
  });
}
```

- [ ] **Step 10: renameFilePath 実装**

```typescript
async renameFilePath(oldPath: string, newPath: string): Promise<number> {
  return this.trackOp(async () => {
    if (!this.table) return 0;
    const before = await this.table.countRows(this.filePathFilter(oldPath));
    await this.table.update({
      where: this.filePathFilter(oldPath),
      values: { filePath: newPath },
    });
    return before;
  });
}
```

> [!NOTE]
> `table.update()` は `Promise<void>` を返すため、`deleteByFilePath` / `deleteByPathPrefix` と同様に `countRows` で事前に件数を取得するパターンを採用。

- [ ] **Step 11: search 実装**

```typescript
async search(
  queryVector: number[],
  topK: number,
  filter?: VectorFilter,
): Promise<VectorSearchResult[]> {
  if (queryVector.length !== this.dimensions) {
    throw new Error(`queryVector length must be ${this.dimensions}`);
  }
  if (!queryVector.every(Number.isFinite)) {
    throw new TypeError('queryVector contains non-finite values');
  }
  if (!Number.isInteger(topK) || topK <= 0) {
    throw new RangeError('topK must be a positive integer');
  }

  return this.trackOp(async () => {
    if (!this.table) return [];
    let query = this.table.vectorSearch(queryVector).limit(topK);
    if (filter) {
      const whereClauses: string[] = [];
      if (filter.filePathPrefix !== undefined) {
        whereClauses.push(this.filePathPrefixFilter(filter.filePathPrefix));
      }
      if (filter.language !== undefined) {
        this.validateFilterValue(filter.language, 'language');
        whereClauses.push(`language = '${this.escapeFilterValue(filter.language)}'`);
      }
      if (filter.symbolKind !== undefined) {
        this.validateFilterValue(filter.symbolKind, 'symbolKind');
        whereClauses.push(`symbolKind = '${this.escapeFilterValue(filter.symbolKind)}'`);
      }
      if (whereClauses.length > 0) {
        query = query.where(whereClauses.join(' AND '));
      }
    }
    const rows = await query.toArray();
    return rows.map((row: Record<string, unknown>) => ({
      chunk: {
        id: row['id'] as string,
        filePath: row['filePath'] as string,
        content: row['content'] as string,
        language: row['language'] as string,
        symbolName: (row['symbolName'] as string) || undefined,
        symbolKind: row['symbolKind'] as CodeChunk['symbolKind'],
        startLine: row['startLine'] as number,
        endLine: row['endLine'] as number,
        hash: (row['hash'] as string) ?? '',
      },
      score: row['_distance'] != null ? 1 - (row['_distance'] as number) : 0,
    }));
  });
}
```

- [ ] **Step 12: getStats / compactIfNeeded / compactAfterReindex / scheduleIdleCompaction 実装**

LanceDB の `table.optimize()` と `table.countRows()` を使って実装。設計仕様書の「Compaction Pipeline 統合」セクションに従う。`compactIfNeeded` では `CLEANUP_GRACE_PERIOD_MS`（5分）を使用。

- [ ] **Step 13: ビルド確認**

Run: `npx tsc --noEmit`
Expected: コンパイルエラーなし

- [ ] **Step 14: コミット**

```bash
git add src/storage/vector-store.ts
git commit -m "feat(storage): LanceVectorStore を @lancedb/lancedb 実装に全面書き換え"
```

---

## Task 9: テストファイルの再配置と Contract Tests 適用

**Files:**
- Move: `tests/unit/storage/vector-store.test.ts` → `tests/integration/vector-store.test.ts`

- [ ] **Step 1: テストファイルを移動**

```bash
mv tests/unit/storage/vector-store.test.ts tests/integration/vector-store.test.ts
```

- [ ] **Step 2: `tests/integration/vector-store.test.ts` を書き換え**

```typescript
// tests/integration/vector-store.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { vectorStoreContractTests } from '../shared/vector-store-contract.js';
import { LanceVectorStore } from '../../src/storage/vector-store.js';
import type { CodeChunk } from '../../src/types/index.js';

describe('LanceVectorStore (LanceDB integration)', () => {
  vectorStoreContractTests(async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'nexus-lance-'));
    const store = new LanceVectorStore({ dbPath: tmpDir, dimensions: 64 });
    await store.initialize();
    return {
      store,
      cleanup: async () => {
        await store.close();
        await rm(tmpDir, { recursive: true });
      },
    };
  });

  describe('LanceDB-specific', () => {
    let tmpDir: string;

    afterEach(async () => {
      if (tmpDir) {
        await rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('永続化 — initialize 後にデータが再読み込み可能', async () => {
      tmpDir = await mkdtemp(join(tmpdir(), 'nexus-lance-'));
      const embedding = Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0));

      const store1 = new LanceVectorStore({ dbPath: tmpDir, dimensions: 64 });
      await store1.initialize();
      await store1.upsertChunks(
        [{
          id: 'persist-test',
          filePath: 'src/test.ts',
          content: 'test',
          language: 'typescript',
          symbolKind: 'function',
          startLine: 1,
          endLine: 1,
          hash: 'hash',
        } as CodeChunk],
        [embedding],
      );
      await store1.close();

      const store2 = new LanceVectorStore({ dbPath: tmpDir, dimensions: 64 });
      await store2.initialize();
      const results = await store2.search(embedding, 10);
      expect(results).toHaveLength(1);
      expect(results[0]?.chunk.id).toBe('persist-test');
      await store2.close();
    });
  });
});
```

- [ ] **Step 3: テスト実行**

Run: `npx vitest run tests/integration/vector-store.test.ts --reporter=verbose`
Expected: Contract Tests + LanceDB 固有テスト全パス

- [ ] **Step 4: コミット**

```bash
git add tests/integration/vector-store.test.ts
git rm tests/unit/storage/vector-store.test.ts 2>/dev/null || true
git commit -m "test: vector-store テストを integration に移動し Contract Tests を適用"
```

---

## Task 10: Spike テストの恒久化

**Files:**
- Move: `tests/spike/mergeinsert-behavior.test.ts` → `tests/integration/mergeinsert-behavior.test.ts`

- [ ] **Step 1: Spike テストを integration に移動**

```bash
mv tests/spike/mergeinsert-behavior.test.ts tests/integration/mergeinsert-behavior.test.ts
rmdir tests/spike 2>/dev/null || true
```

- [ ] **Step 2: テスト実行確認**

Run: `npx vitest run tests/integration/mergeinsert-behavior.test.ts --reporter=verbose`
Expected: パス

- [ ] **Step 3: コミット**

```bash
git add tests/integration/mergeinsert-behavior.test.ts
git commit -m "test: mergeInsert Spike テストを integration に恒久化"
```

---

## Task 11: Pipeline への Compaction 統合

**Files:**
- Modify: `src/indexer/pipeline.ts`
- Modify: `tests/unit/indexer/pipeline.test.ts`

- [ ] **Step 1: Red — Pipeline テストを追加**

`tests/unit/indexer/pipeline.test.ts` の先頭にインポートを追加:

```typescript
import { vi } from 'vitest';
```

ファイル末尾（`describe('IndexPipeline', ...)` ブロック内の最後のテストの後）に以下を追加:

```typescript
it('reindex() 完了後に compactAfterReindex() が呼ばれる', async () => {
  const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
  const compactSpy = vi.spyOn(vectorStore, 'compactAfterReindex');
  const pipeline = new IndexPipeline({
    metadataStore,
    vectorStore,
    chunker,
    embeddingProvider: new TestEmbeddingProvider(),
    pluginRegistry: registry,
  });

  await pipeline.reindex(async () => [], async () => '');

  expect(compactSpy).toHaveBeenCalledOnce();
});

it('compactAfterReindex() 失敗時も reindex は成功扱い', async () => {
  const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
  vi.spyOn(vectorStore, 'compactAfterReindex').mockRejectedValue(new Error('compact failed'));
  const pipeline = new IndexPipeline({
    metadataStore,
    vectorStore,
    chunker,
    embeddingProvider: new TestEmbeddingProvider(),
    pluginRegistry: registry,
  });

  const result = await pipeline.reindex(async () => [], async () => '');
  expect(result).not.toHaveProperty('status');
});

it('stop() 呼び出し時に vectorStore.close() が呼ばれる', async () => {
  const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
  const closeSpy = vi.spyOn(vectorStore, 'close').mockResolvedValue(undefined);
  const pipeline = new IndexPipeline({
    metadataStore,
    vectorStore,
    chunker,
    embeddingProvider: new TestEmbeddingProvider(),
    pluginRegistry: registry,
  });

  await pipeline.stop();
  expect(closeSpy).toHaveBeenCalledOnce();
});
```

- [ ] **Step 2: テスト実行 — Red 確認**

Run: `npx vitest run tests/unit/indexer/pipeline.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: 新しいテストが FAIL（`compactAfterReindex` が呼ばれていない、`close()` が呼ばれていない）

- [ ] **Step 3: Green — Pipeline に compactAfterReindex と close() を追加**

`src/indexer/pipeline.ts` の `reindex()` メソッド内、`return` 直前（reconciliation の計算後、`return` の直前）に以下を追加:

```typescript
// リインデックス完了後、Mutex 排他ブロック内でコンパクション実行
// best-effort: 失敗してもリインデックス結果には影響しない
try {
  await this.options.vectorStore.compactAfterReindex();
} catch (compactionError) {
  console.error('Post-reindex compaction failed (non-fatal):', compactionError);
}
```

`stop()` メソッドの末尾に以下を追加:

```typescript
// ベクトルストアの接続をクローズ
await this.options.vectorStore.close();
```

- [ ] **Step 4: テスト実行 — Green 確認**

Run: `npx vitest run tests/unit/indexer/pipeline.test.ts --reporter=verbose`
Expected: 全テストパス

- [ ] **Step 5: コミット**

```bash
git add src/indexer/pipeline.ts tests/unit/indexer/pipeline.test.ts
git commit -m "feat(pipeline): reindex 後の compactAfterReindex と stop() での close() を追加"
```

---

## Task 12: Idle Compaction タイマーとライフサイクル管理

**Files:**
- Modify: `src/indexer/pipeline.ts`
- Modify: `tests/unit/indexer/pipeline.test.ts`

- [ ] **Step 1: Red — タイマー関連テストを追加**

`tests/unit/indexer/pipeline.test.ts` に以下を追加:

```typescript
it('start() で idle compaction タイマーが登録され unref() が適用される', async () => {
  const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
  const timerRef = { unref: vi.fn() };
  vi.spyOn(vectorStore, 'scheduleIdleCompaction').mockReturnValue(
    timerRef as unknown as NodeJS.Timeout,
  );
  const pipeline = new IndexPipeline({
    metadataStore,
    vectorStore,
    chunker,
    embeddingProvider: new TestEmbeddingProvider(),
    pluginRegistry: registry,
  });

  pipeline.start();

  expect(vectorStore.scheduleIdleCompaction).toHaveBeenCalledOnce();
  expect(timerRef.unref).toHaveBeenCalledOnce();

  await pipeline.stop();
});

it('stop() でタイマーがクリアされ abortController.signal が abort 状態になる', async () => {
  const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
  const timerRef = { unref: vi.fn() };
  vi.spyOn(vectorStore, 'scheduleIdleCompaction').mockReturnValue(
    timerRef as unknown as NodeJS.Timeout,
  );
  vi.spyOn(vectorStore, 'close').mockResolvedValue(undefined);
  const pipeline = new IndexPipeline({
    metadataStore,
    vectorStore,
    chunker,
    embeddingProvider: new TestEmbeddingProvider(),
    pluginRegistry: registry,
  });

  pipeline.start();
  await pipeline.stop();

  // scheduleIdleCompaction に渡された abortSignal を検証
  const callArgs = vi.mocked(vectorStore.scheduleIdleCompaction).mock.calls[0];
  const abortSignal = callArgs?.[3] as AbortSignal | undefined;
  expect(abortSignal?.aborted).toBe(true);
});

it('stop() の二重呼び出しでエラーが発生しない', async () => {
  const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
  vi.spyOn(vectorStore, 'close').mockResolvedValue(undefined);
  const pipeline = new IndexPipeline({
    metadataStore,
    vectorStore,
    chunker,
    embeddingProvider: new TestEmbeddingProvider(),
    pluginRegistry: registry,
  });

  pipeline.start();
  await expect(pipeline.stop()).resolves.toBeUndefined();
  await expect(pipeline.stop()).resolves.toBeUndefined();
});
```

- [ ] **Step 2: テスト実行 — Red 確認**

Run: `npx vitest run tests/unit/indexer/pipeline.test.ts --reporter=verbose 2>&1 | tail -20`
Expected: 新しいテストが FAIL

- [ ] **Step 3: Green — Pipeline に idle compaction タイマーを追加**

`src/indexer/pipeline.ts` に以下の変更を加える:

1. `IndexPipeline` クラスに `abortController` と `idleCompactionTimer` プロパティを追加:

```typescript
private abortController = new AbortController();
private idleCompactionTimer: NodeJS.Timeout | undefined;
```

2. `start()` メソッドを更新:

```typescript
start(): void {
  if (this.dlqStopper === undefined) {
    this.dlqStopper = this.deadLetterQueue.startRecoveryLoop();
  }
  this.idleCompactionTimer = this.options.vectorStore.scheduleIdleCompaction(
    () => this.options.vectorStore.compactIfNeeded(),
    300_000, // 5分
    { waitForUnlock: () => this.mutex.waitForUnlock() },
    this.abortController.signal,
  );
  this.idleCompactionTimer.unref();
}
```

3. `stop()` メソッドを更新:

```typescript
async stop(): Promise<void> {
  this.abortController.abort();

  if (this.idleCompactionTimer !== undefined) {
    clearTimeout(this.idleCompactionTimer);
    this.idleCompactionTimer = undefined;
  }

  if (this.dlqStopper !== undefined) {
    await this.dlqStopper();
    this.dlqStopper = undefined;
  }

  await this.options.vectorStore.close();
}
```

- [ ] **Step 4: テスト実行 — Green 確認**

Run: `npx vitest run tests/unit/indexer/pipeline.test.ts --reporter=verbose`
Expected: 全テストパス

- [ ] **Step 5: 全テスト実行**

Run: `npx vitest run --reporter=verbose`
Expected: 全テストパス

- [ ] **Step 6: コミット**

```bash
git add src/indexer/pipeline.ts tests/unit/indexer/pipeline.test.ts
git commit -m "feat(pipeline): idle compaction タイマーとライフサイクル管理を追加"
```

---

## 最終チェック

- [ ] **全体ビルド確認:** `npx tsc --noEmit`
- [ ] **全テスト実行:** `npx vitest run --reporter=verbose`
- [ ] **Lint 確認:** `npm run lint`
- [ ] **`tests/spike/` ディレクトリが空であることを確認:** `ls tests/spike/ 2>/dev/null && echo "ERROR: spike dir still has files" || echo "OK"`
