# 2026-04-09 P1 Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 依存関係ライセンス情報の正確な反映、非同期停止処理の不備修正、およびドキュメントのインポート形式の改善を行う。

**Architecture:** 
1. NOTICEファイルの再生成と重複排除。
2. IndexPipeline.stopインターフェースに合わせたテストモックのPromise化。
3. DeadLetterQueueのリカバリーループ停止処理におけるawait欠落の修正。
4. READMEのサンプルコードをパッケージ利用に適した形式に修正。

**Tech Stack:** TypeScript, Vitest, npm, generate-license-file

---

### Task 1: NOTICE ファイルの再生成と重複排除

**Files:**
- Modify: `NOTICE`

- [x] **Step 1: NOTICE ファイルを再生成する**

Run: `npx generate-license-file --input package-lock.json --output NOTICE --overwrite`

- [x] **Step 2: 重複したヘッダーとフッターを削除し、内容を確認する**

`generate-license-file` が生成したファイルには、各ライセンスセクションの後に重複したツール情報が含まれる場合があるため、以下の形式に整形する。
1. 先頭に1つだけツール情報を残す。
2. 末尾の重複したツール情報を削除する。
3. 10個以上のパッケージ（express, zod, chokidar等）が含まれていることを確認する。

- [x] **Step 3: Commit**

```bash
git add NOTICE
git commit -m "docs: regenerate NOTICE with full dependency licenses and remove duplicates"
```

---

### Task 2: IndexPipeline テストモックの非同期化修正

**Files:**
- Modify: `tests/unit/server/tools/reindex.test.ts`

- [ ] **Step 1: 既存のテストがパスすることを確認する**

Run: `npx vitest tests/unit/server/tools/reindex.test.ts`

- [ ] **Step 2: stop メソッドのモックを Promise を返すように修正する**

```typescript
// tests/unit/server/tools/reindex.test.ts
const pipeline = {
  // ...
  start: () => undefined,
  stop: async () => {}, // 修正: async に変更
};
```

- [ ] **Step 3: 修正後のテストを実行してパスすることを確認する**

Run: `npx vitest tests/unit/server/tools/reindex.test.ts`

- [ ] **Step 4: Commit**

```bash
git add tests/unit/server/tools/reindex.test.ts
git commit -m "test: update IndexPipeline mock stop method to return Promise<void>"
```

---

### Task 3: DeadLetterQueue テストの非同期停止処理の修正

**Files:**
- Modify: `tests/unit/indexer/dead-letter-queue.test.ts`

- [ ] **Step 1: 既存のテストがパスすることを確認する（警告が出る可能性がある）**

Run: `npx vitest tests/unit/indexer/dead-letter-queue.test.ts`

- [ ] **Step 2: stopFirst() および stop1() の呼び出しに await を追加する**

```typescript
// tests/unit/indexer/dead-letter-queue.test.ts

// 'returns the same stopper if already running' テスト内
it('returns the same stopper if already running', async () => { // async を確認
  // ...
  expect(stopSecond).toBe(stopFirst);
  await stopFirst(); // 修正: await を追加
});

// 'warns when starting recovery loop while already running' テスト内
it('warns when starting recovery loop while already running', async () => { // 修正: async に変更
  // ...
  const stop1 = queue.startRecoveryLoop();
  queue.startRecoveryLoop();

  expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('already running'));
  await stop1(); // 修正: await を追加
});
```

- [ ] **Step 3: 修正後のテストを実行してパスすることを確認する**

Run: `npx vitest tests/unit/indexer/dead-letter-queue.test.ts`

- [ ] **Step 4: Commit**

```bash
git add tests/unit/indexer/dead-letter-queue.test.ts
git commit -m "test: properly await stopper in DeadLetterQueue tests"
```

---

### Task 4: README のサンプルコード修正

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 相対パスインポートをパッケージ名またはプレースホルダーに変更する**

```markdown
// README.md のコードブロック内

import { createNexusServer } from 'nexus'; // 修正: './src/server/index.js' から変更
import { createStreamableHttpHandler } from 'nexus/transport'; // 修正: './src/server/transport.js' から変更
```

- [ ] **Step 2: パッケージ名についての注釈を追加する**

コードブロックの直前に、`nexus` はプロジェクト名に応じて置き換える必要がある旨の注記を追加する。

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: update README sample code to use package-style imports"
```

---

### Task 5: 最終確認とクリーンアップ

- [ ] **Step 1: 全てのユニットテストを実行する**

Run: `npm test`

- [ ] **Step 2: 全ての修正が正しく反映されているか diff を確認する**

Run: `git diff HEAD`
