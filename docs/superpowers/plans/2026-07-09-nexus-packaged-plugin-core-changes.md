# Nexus パッケージ版 コア変更（Bedrock プロバイダ + パッケージモード）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 単一コードベースに AWS Bedrock 埋め込みプロバイダを正規機能として追加し、`NEXUS_PACKAGE_MODE` フラグで埋め込み provider を `bedrock` にハードロック（fail-fast）できるようにする。

**Architecture:** 設計書 [2026-07-07-nexus-packaged-plugin-restrictions.md](../specs/2026-07-07-nexus-packaged-plugin-restrictions.md) の §6（設計詳細）に従う。新規 `BedrockEmbeddingProvider` は既存 `OpenAICompatEmbeddingProvider` と同じ依存注入スタイル（AWS クライアントを注入可能）で実装し、`BaseEmbeddingProvider` を継承する。config 層に `provider="bedrock"` の許可・`region`/`profile`/`packageMode` の配線を追加し、factory の provider switch に `case "bedrock"` と `assertPackageModeConstraints` ハードロックを追加する。原本（`packageMode=false`）の挙動は完全に不変。

**Tech Stack:** TypeScript (strict, Node >= 24), `@aws-sdk/client-bedrock-runtime` + `@aws-sdk/credential-providers`, `p-limit`, Vitest。

## Global Constraints

- 型安全厳守。`as any` / `@ts-ignore` / `@ts-expect-error` は禁止（AGENTS.md）。テストで private static へアクセスする場合のみ `as unknown as <明示インターフェース>` を使用（`as any` ではない）。
- local-first を維持。原本（`packageMode=false`）の挙動・既存テストは不変であること。
- 新規のエージェント設定ファイル/ディレクトリは作成しない（AGENTS.md）。本計画は `.claude-plugin/plugin.json` を**編集しない**（配布時変換＝別計画。Appendix B 参照）。
- Bedrock モデル/次元の deploy デフォルト: モデル `amazon.titan-embed-text-v2:0`、次元 `1024`。これらは `NEXUS_PACKAGE_MODE` のロック対象外（運用者が変更可能）。
- `NEXUS_PACKAGE_MODE` がロックするのは **provider のみ**（`bedrock` 以外は fail-fast）。model / dimensions / region はロックしない。メトリクス層（`MetricsCollector`・metrics HTTP サーバ・`packages/dashboard` TUI）には一切触れない。
- Bedrock リージョン未指定時のフォールバック: `us-east-1`（＋警告ログ）。
- 検証コマンド（AGENTS.md）: 変更に最も近い Vitest を先に実行 → モジュール横断時に拡大。TypeScript 変更完了主張前に `npm run lint`。ビルドは `npm run build`。

---

## Scope Note（重要）

本計画は設計書 §9 が指示する 2 計画のうち **(a) コア変更（Bedrock プロバイダ + パッケージモード）** のみを対象とする。以下は**本計画のスコープ外**:

- **(b) 配布パイプライン改訂（設計書 §8）**: `stage-plugin-dist.sh` による plugin.json の stage 時変換（`userConfig` 除去・固定 env 注入）。この変換スクリプトは本リポジトリに未存在で、別計画 [2026-07-07-nexus-plugin-bitbucket-source-mirror-deploy.md](2026-07-07-nexus-plugin-bitbucket-source-mirror-deploy.md) の改訂として実装される。→ Appendix B 参照。
- 本計画の成果物は**単体で動作・テスト可能**（原本から `NEXUS_EMBEDDING_PROVIDER=bedrock` を設定すれば Bedrock が使える正規機能として完結する）。

また、設計書の前提と実コードの間に**1 件の乖離**を検出した（aggregator 登録の既定挙動）。これは **Appendix A** に切り出し、意思決定待ちの任意タスクとして提示する（本体タスクには含めない）。

---

## File Structure

**新規作成:**
- `src/plugins/embeddings/bedrock.ts` — `BedrockEmbeddingProvider`（Titan v2 の 1テキスト/呼び出しを `maxConcurrency` で並列化。リトライ/次元検証/healthCheck を担う）
- `tests/unit/plugins/embeddings/bedrock.test.ts` — provider のユニットテスト（AWS クライアント注入・実 AWS 呼び出しなし）
- `tests/unit/server/factory.test.ts` — `assertPackageModeConstraints` と provider switch のテスト（factory の既存テストは無いため新規）

**変更:**
- `src/types/index.ts` — `EmbeddingConfig.provider` union に `"bedrock"`、`region?`/`profile?` を追加。`Config` に `packageMode: boolean` を追加
- `src/config/index.ts` — `isProvider` に `"bedrock"`、`NEXUS_EMBEDDING_REGION`/`_PROFILE` 配線、`packageMode`（`NEXUS_PACKAGE_MODE`）配線＋`asBoolean`/`validateBoolean` ヘルパ
- `src/server/factory.ts` — `assertPackageModeConstraints`（新規・export）、switch に `case "bedrock"`、Bedrock import
- `package.json` — `@aws-sdk/client-bedrock-runtime` / `@aws-sdk/credential-providers` を dependencies に追加
- `tests/unit/config/index.test.ts` — bedrock/region/profile/packageMode の config テストを追記

**依存関係（並列実行の指針）:**
- Task 1（Foundation）→ 全タスクの前提
- Task 2（Bedrock provider）と Task 3（Config 配線）は Task 1 のみに依存 → **並列実行可能**
- Task 4（Factory 配線）は Task 2 + Task 3 に依存
- Task 5（回帰・総合検証）は Task 1〜4 完了後

---

### Task 1: Foundation — AWS SDK 依存追加と型サーフェス拡張

**Files:**
- Modify: `package.json:53-68`（dependencies ブロック）
- Modify: `src/types/index.ts:207-219`（`EmbeddingConfig`）
- Modify: `src/types/index.ts:284-293`（`Config`）

**Interfaces:**
- Produces: `EmbeddingConfig.provider` が `'ollama' | 'openai-compat' | 'bedrock' | 'test'` になる。`EmbeddingConfig.region?: string`、`EmbeddingConfig.profile?: string`。`Config.packageMode: boolean`。これらを Task 2/3/4 が参照する。

- [ ] **Step 1: AWS SDK 依存をインストール**

Run:
```bash
npm install @aws-sdk/client-bedrock-runtime@3.1081.0 @aws-sdk/credential-providers@3.1081.0
```
Expected: `package.json` の `dependencies` に 2 パッケージが追加され、`package-lock.json` が更新される。exit code 0。

- [ ] **Step 2: `package.json` の dependencies を確認**

`package.json:53-68` の `dependencies` に以下が含まれること（アルファベット順に配置されるのが望ましい）:
```json
    "@aws-sdk/client-bedrock-runtime": "^3.1081.0",
    "@aws-sdk/credential-providers": "^3.1081.0",
    "@lancedb/lancedb": "^0.18.2",
```
（既存の `@lancedb/lancedb` 等はそのまま。手動で並べ替える場合は上記の順序。）

- [ ] **Step 3: `EmbeddingConfig` に bedrock / region / profile を追加**

`src/types/index.ts:207-219` を以下へ変更（`provider` union に `'bedrock'` を追加し、`baseUrl?` の直後に `region?`/`profile?` を追加）:
```typescript
export interface EmbeddingConfig {
  provider: 'ollama' | 'openai-compat' | 'bedrock' | 'test';
  model: string;
  dimensions: number;
  baseUrl?: string;
  apiKey?: string;
  region?: string;
  profile?: string;
  maxConcurrency: number;
  batchSize: number;
  retryCount: number;
  retryBaseDelayMs: number;
  timeoutMs?: number;
  ollamaNumThread?: number;
}
```

- [ ] **Step 4: `Config` に packageMode を追加**

`src/types/index.ts:284-293` を以下へ変更（`aggregatorPort?` の直後に `packageMode` を追加）:
```typescript
export interface Config {
  projectRoot: string;
  projectName?: string;
  storage: StorageConfig;
  watcher: WatcherConfig;
  embedding: EmbeddingConfig;
  indexing: IndexingConfig;
  metricsPort?: number;
  aggregatorPort?: number;
  packageMode: boolean;
}
```

- [ ] **Step 5: 型チェックで既存の未配線箇所を洗い出す**

Run: `npx tsc -p tsconfig.build.json --noEmit`
Expected: `Config.packageMode` が必須になったため、`Config` を構築している箇所（`src/config/index.ts` の `loadConfig` 内 `merged`）で "Property 'packageMode' is missing" エラーが出る。これは Task 3 で解消する（このステップでは**エラーが出ることを確認**するだけ）。他に `Config` を直接構築するプロダクションコードが無いことを確認（テストは Task 3/4 で対応）。

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/types/index.ts
git commit -m "feat: add bedrock provider type surface and packageMode config field"
```

---

### Task 2: Bedrock 埋め込みプロバイダ

**Files:**
- Create: `src/plugins/embeddings/bedrock.ts`
- Test: `tests/unit/plugins/embeddings/bedrock.test.ts`

**Interfaces:**
- Consumes: `EmbeddingConfig`（Task 1 で `region?`/`profile?`/`'bedrock'` 追加済み）、`BaseEmbeddingProvider`（[base.ts](../../../src/plugins/embeddings/base.ts)）、`RetryExhaustedError` / `DimensionMismatchError`（[types/index.ts](../../../src/types/index.ts:307-323)）。
- Produces:
  - `export class BedrockEmbeddingProvider extends BaseEmbeddingProvider`
    - `constructor(config: BedrockProviderConfig, dependencies?: BedrockDependencies)`
    - `embed(texts: string[]): Promise<number[][]>`、`healthCheck(): Promise<boolean>`、`readonly dimensions: number`
  - `export class BedrockEmbedError extends Error`（`retriable: boolean`）
  - `export interface BedrockClientLike { send(command: InvokeModelCommand): Promise<{ body: Uint8Array }>; }`
  - `export interface BedrockDependencies { client: BedrockClientLike; sleep: (ms: number) => Promise<void>; }`
  - `BedrockProviderConfig = Pick<EmbeddingConfig, 'model' | 'dimensions' | 'maxConcurrency' | 'retryCount' | 'retryBaseDelayMs' | 'region' | 'profile'>`

  Task 4 が `new BedrockEmbeddingProvider(config.embedding)`（デフォルト依存）で使用する。

- [ ] **Step 1: 失敗するテストを書く**

Create `tests/unit/plugins/embeddings/bedrock.test.ts`:
```typescript
import { describe, expect, it, vi } from 'vitest';

import { BedrockEmbeddingProvider } from '../../../../src/plugins/embeddings/bedrock.js';
import { RetryExhaustedError, DimensionMismatchError } from '../../../../src/types/index.js';

const encodeBody = (obj: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(obj));

const mockConfig = {
  model: 'amazon.titan-embed-text-v2:0',
  dimensions: 2,
  maxConcurrency: 1,
  retryCount: 3,
  retryBaseDelayMs: 10,
  region: 'us-east-1',
};

describe('BedrockEmbeddingProvider', () => {
  it('embeds each text via a separate InvokeModel call', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ body: encodeBody({ embedding: [0.1, 0.2], inputTextTokenCount: 3 }) })
      .mockResolvedValueOnce({ body: encodeBody({ embedding: [0.3, 0.4], inputTextTokenCount: 3 }) });

    const provider = new BedrockEmbeddingProvider(mockConfig, { client: { send }, sleep: vi.fn() });
    const result = await provider.embed(['a', 'b']);

    expect(result).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(send).toHaveBeenCalledTimes(2);

    const command = send.mock.calls[0][0] as { input: { modelId: string; body: string } };
    expect(command.input.modelId).toBe('amazon.titan-embed-text-v2:0');
    expect(JSON.parse(command.input.body)).toEqual({ inputText: 'a', dimensions: 2, normalize: true });
  });

  it('throws immediately if dimensions are not a positive integer', async () => {
    const send = vi.fn();
    const provider = new BedrockEmbeddingProvider({ ...mockConfig, dimensions: 0 }, { client: { send }, sleep: vi.fn() });
    await expect(provider.embed(['a'])).rejects.toThrow('Embedding dimensions must be a positive integer');
    expect(send).not.toHaveBeenCalled();
  });

  it('retries on ThrottlingException and eventually succeeds', async () => {
    let attempts = 0;
    const send = vi.fn().mockImplementation(async () => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error('rate exceeded');
        err.name = 'ThrottlingException';
        throw err;
      }
      return { body: encodeBody({ embedding: [0.5, 0.6], inputTextTokenCount: 3 }) };
    });
    const sleep = vi.fn();
    const provider = new BedrockEmbeddingProvider(mockConfig, { client: { send }, sleep });

    const result = await provider.embed(['a']);
    expect(result).toEqual([[0.5, 0.6]]);
    expect(send).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('throws RetryExhaustedError when throttling persists', async () => {
    const send = vi.fn().mockImplementation(async () => {
      const err = new Error('rate exceeded');
      err.name = 'ThrottlingException';
      throw err;
    });
    const provider = new BedrockEmbeddingProvider(mockConfig, { client: { send }, sleep: vi.fn() });

    await expect(provider.embed(['a'])).rejects.toThrow(RetryExhaustedError);
    expect(send).toHaveBeenCalledTimes(mockConfig.retryCount + 1);
  });

  it('throws immediately on AccessDeniedException without retrying', async () => {
    const send = vi.fn().mockImplementation(async () => {
      const err = new Error('not authorized to invoke model');
      err.name = 'AccessDeniedException';
      throw err;
    });
    const provider = new BedrockEmbeddingProvider(mockConfig, { client: { send }, sleep: vi.fn() });

    await expect(provider.embed(['a'])).rejects.toThrow('not authorized to invoke model');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('throws DimensionMismatchError when the returned dimension differs', async () => {
    const send = vi.fn().mockResolvedValue({ body: encodeBody({ embedding: [0.1, 0.2, 0.3], inputTextTokenCount: 3 }) });
    const provider = new BedrockEmbeddingProvider(mockConfig, { client: { send }, sleep: vi.fn() });

    await expect(provider.embed(['a'])).rejects.toThrow(DimensionMismatchError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('returns true from healthCheck when embedding succeeds', async () => {
    const send = vi.fn().mockResolvedValue({ body: encodeBody({ embedding: [0.1, 0.2], inputTextTokenCount: 3 }) });
    const provider = new BedrockEmbeddingProvider(mockConfig, { client: { send }, sleep: vi.fn() });
    expect(await provider.healthCheck()).toBe(true);
  });

  it('returns false from healthCheck when the client throws', async () => {
    const send = vi.fn().mockRejectedValue(new Error('network down'));
    const provider = new BedrockEmbeddingProvider(mockConfig, { client: { send }, sleep: vi.fn() });
    expect(await provider.healthCheck()).toBe(false);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run tests/unit/plugins/embeddings/bedrock.test.ts`
Expected: FAIL（`Cannot find module '.../bedrock.js'` もしくは import 解決エラー）。

- [ ] **Step 3: `BedrockEmbeddingProvider` を実装**

Create `src/plugins/embeddings/bedrock.ts`:
```typescript
import pLimit from 'p-limit';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { fromIni } from '@aws-sdk/credential-providers';

import type { EmbeddingConfig } from '../../types/index.js';
import { RetryExhaustedError, DimensionMismatchError } from '../../types/index.js';
import { BaseEmbeddingProvider } from './base.js';

const DEFAULT_REGION = 'us-east-1';

/** Minimal surface of BedrockRuntimeClient we depend on (injectable for tests). */
export interface BedrockClientLike {
  send(command: InvokeModelCommand): Promise<{ body: Uint8Array }>;
}

export interface BedrockDependencies {
  client: BedrockClientLike;
  sleep: (ms: number) => Promise<void>;
}

interface TitanEmbedResponse {
  embedding: number[];
  inputTextTokenCount: number;
}

/** Bedrock invocation error with retriability classification. */
export class BedrockEmbedError extends Error {
  constructor(
    message: string,
    public readonly retriable: boolean = true,
  ) {
    super(message);
    this.name = 'BedrockEmbedError';
  }
}

// AWS SDK v3 modeled exception `.name` values that must NOT be retried.
const NON_RETRIABLE_EXCEPTIONS = new Set([
  'AccessDeniedException',
  'ValidationException',
  'ResourceNotFoundException',
  'ExpiredTokenException',
  'UnrecognizedClientException',
]);

export type BedrockProviderConfig = Pick<
  EmbeddingConfig,
  'model' | 'dimensions' | 'maxConcurrency' | 'retryCount' | 'retryBaseDelayMs' | 'region' | 'profile'
>;

const createDefaultDependencies = (config: BedrockProviderConfig): BedrockDependencies => {
  const region = config.region ?? DEFAULT_REGION;
  if (!config.region) {
    console.warn(
      `[Nexus] NEXUS_EMBEDDING_REGION is not set; falling back to "${DEFAULT_REGION}". ` +
        `Set the region to match your Bedrock deployment.`,
    );
  }

  const runtimeClient = new BedrockRuntimeClient({
    region,
    ...(config.profile ? { credentials: fromIni({ profile: config.profile }) } : {}),
  });

  const client: BedrockClientLike = {
    send: async (command) => {
      const output = await runtimeClient.send(command);
      if (!output.body) {
        throw new BedrockEmbedError('Bedrock returned an empty response body', false);
      }
      return { body: output.body };
    },
  };

  return {
    client,
    sleep: async (ms: number) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
  };
};

export class BedrockEmbeddingProvider extends BaseEmbeddingProvider {
  readonly dimensions: number;

  private readonly limit;

  constructor(
    private readonly config: BedrockProviderConfig,
    private readonly dependencies: BedrockDependencies = createDefaultDependencies(config),
  ) {
    super();
    this.dimensions = config.dimensions;
    this.limit = pLimit(config.maxConcurrency);
  }

  async embed(texts: string[]): Promise<number[][]> {
    // Titan v2 accepts exactly one inputText per InvokeModel call, so map each
    // text to its own request and bound concurrency with pLimit.
    const promises = texts.map((text) => this.limit(() => this.embedOneWithRetry(text)));
    return Promise.all(promises);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const vector = await this.embedOne('nexus health check');
      return Array.isArray(vector) && vector.length === this.dimensions;
    } catch {
      return false;
    }
  }

  private async embedOneWithRetry(text: string): Promise<number[]> {
    let attempt = 0;
    let lastError: Error | undefined;

    // attempt=0 is the first try, so we allow up to retryCount retries.
    while (attempt <= this.config.retryCount) {
      try {
        return await this.embedOne(text);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (error instanceof DimensionMismatchError) {
          throw error;
        }
        if (!this.isRetriable(error)) {
          throw error;
        }
        if (attempt >= this.config.retryCount) {
          break;
        }

        attempt += 1;
        await this.dependencies.sleep(this.config.retryBaseDelayMs * 2 ** (attempt - 1));
      }
    }

    throw new RetryExhaustedError('Failed to fetch embeddings from Bedrock', attempt + 1, {
      cause: lastError,
    });
  }

  private async embedOne(text: string): Promise<number[]> {
    if (!Number.isInteger(this.dimensions) || this.dimensions <= 0) {
      throw new BedrockEmbedError('Embedding dimensions must be a positive integer', false);
    }

    const command = new InvokeModelCommand({
      modelId: this.config.model,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        inputText: text,
        dimensions: this.dimensions,
        normalize: true,
      }),
    });

    const response = await this.dependencies.client.send(command);
    const payload = JSON.parse(new TextDecoder().decode(response.body)) as TitanEmbedResponse;

    if (!Array.isArray(payload.embedding)) {
      throw new BedrockEmbedError('Bedrock response is missing the embedding array', false);
    }
    if (!payload.embedding.every((value) => typeof value === 'number')) {
      throw new BedrockEmbedError('Bedrock embedding contains non-numeric values', false);
    }
    if (payload.embedding.length !== this.dimensions) {
      throw new DimensionMismatchError(
        `Unexpected embedding dimension: expected ${this.dimensions}, received ${payload.embedding.length}`,
      );
    }

    return payload.embedding;
  }

  private isRetriable(error: unknown): boolean {
    if (error instanceof BedrockEmbedError) {
      return error.retriable;
    }
    if (error instanceof Error) {
      if (NON_RETRIABLE_EXCEPTIONS.has(error.name)) {
        return false;
      }
      if (error.name === 'ThrottlingException') {
        return true;
      }
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (typeof status === 'number') {
        return status === 429 || status >= 500;
      }
    }
    // Unknown errors (e.g. transient network faults) are retried.
    return true;
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

Run: `npx vitest run tests/unit/plugins/embeddings/bedrock.test.ts`
Expected: PASS（8 tests passed）。

- [ ] **Step 5: 型チェック**

Run: `npx tsc -p tsconfig.build.json --noEmit`
Expected: Task 1 で予告した `src/config/index.ts` の `packageMode` missing エラー**のみ**が残る（bedrock.ts 由来の型エラーは 0）。bedrock.ts に関するエラーがあれば修正する。

- [ ] **Step 6: Commit**

```bash
git add src/plugins/embeddings/bedrock.ts tests/unit/plugins/embeddings/bedrock.test.ts
git commit -m "feat: add AWS Bedrock embedding provider"
```

---

### Task 3: Config 配線（bedrock 許可・region/profile・packageMode）

**Files:**
- Modify: `src/config/index.ts:115-142`（embedding merged ブロック）
- Modify: `src/config/index.ts:161-169`（merged の末尾に packageMode 追加）
- Modify: `src/config/index.ts:244-246`（`isProvider`）
- Modify: `src/config/index.ts`（`asBoolean`/`validateBoolean` ヘルパ新規。`validateNonNegativeInt` 付近 L229-230 の後ろに追加）
- Test: `tests/unit/config/index.test.ts`（追記）

**Interfaces:**
- Consumes: `EmbeddingConfig`/`Config`（Task 1）。
- Produces: `loadConfig` が `NEXUS_EMBEDDING_PROVIDER=bedrock` を許可し、`config.embedding.region` / `config.embedding.profile` / `config.packageMode` を返す。Task 4 が `config.packageMode` と provider を参照。

- [ ] **Step 1: 失敗するテストを書く**

`tests/unit/config/index.test.ts` の末尾（最後の `});` の直前、L410 付近）に以下の describe ブロックを追記:
```typescript
  it('allows the bedrock provider and wires region/profile', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-config-'));

    const config = await loadConfig({
      projectRoot: tempDir,
      env: {
        NEXUS_EMBEDDING_PROVIDER: 'bedrock',
        NEXUS_EMBEDDING_MODEL: 'amazon.titan-embed-text-v2:0',
        NEXUS_EMBEDDING_DIMENSIONS: '1024',
        NEXUS_EMBEDDING_REGION: 'ap-northeast-1',
        NEXUS_EMBEDDING_PROFILE: 'nexus-sso',
      },
    });

    expect(config.embedding.provider).toBe('bedrock');
    expect(config.embedding.model).toBe('amazon.titan-embed-text-v2:0');
    expect(config.embedding.dimensions).toBe(1024);
    expect(config.embedding.region).toBe('ap-northeast-1');
    expect(config.embedding.profile).toBe('nexus-sso');
  });

  it('defaults packageMode to false and leaves region/profile undefined', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-config-'));

    const config = await loadConfig({ projectRoot: tempDir, env: {} });

    expect(config.packageMode).toBe(false);
    expect(config.embedding.region).toBeUndefined();
    expect(config.embedding.profile).toBeUndefined();
  });

  it('parses NEXUS_PACKAGE_MODE=1 as true', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-config-'));

    const config = await loadConfig({ projectRoot: tempDir, env: { NEXUS_PACKAGE_MODE: '1' } });

    expect(config.packageMode).toBe(true);
  });

  it('reads packageMode from .nexus.json boolean and ignores invalid env', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-config-'));
    await writeFile(path.join(tempDir, '.nexus.json'), JSON.stringify({ packageMode: true }), 'utf8');

    const config = await loadConfig({ projectRoot: tempDir, env: { NEXUS_PACKAGE_MODE: 'maybe' } });

    // Invalid env value is ignored; falls back to the file value.
    expect(config.packageMode).toBe(true);
  });
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run tests/unit/config/index.test.ts`
Expected: FAIL（`config.embedding.provider` が `'bedrock'` にならず `'ollama'` にフォールバック、`config.packageMode` が `undefined`、型エラー）。

- [ ] **Step 3: `isProvider` に bedrock を追加**

`src/config/index.ts:244-246` を以下へ変更:
```typescript
const isProvider = (value: unknown): value is EmbeddingConfig['provider'] => {
  return value === 'ollama' || value === 'openai-compat' || value === 'bedrock' || value === 'test';
};
```

- [ ] **Step 4: `asBoolean` / `validateBoolean` ヘルパを追加**

`src/config/index.ts` の `validateNonNegativeInt`（L229-230）の直後に以下を追加:
```typescript

const asBoolean = (value: string | undefined): boolean | undefined => {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;
  return undefined;
};

const validateBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;
```

- [ ] **Step 5: embedding ブロックに region/profile を配線**

`src/config/index.ts:121`（`apiKey:` の行）の直後に以下 2 行を追加:
```typescript
      region: asString(env.NEXUS_EMBEDDING_REGION) ?? validateString(fileConfig.embedding?.region) ?? defaults.embedding.region,
      profile: asString(env.NEXUS_EMBEDDING_PROFILE) ?? validateString(fileConfig.embedding?.profile) ?? defaults.embedding.profile,
```
（`defaults.embedding.region` / `.profile` は未定義のため `undefined` になり、未設定時は `undefined` が入る。意図どおり。）

- [ ] **Step 6: merged に packageMode を配線**

`src/config/index.ts:165-168`（`aggregatorPort:` の 4 行）の直後、`merged` オブジェクトを閉じる `};`（L169）の直前に以下を追加:
```typescript
    packageMode:
      asBoolean(env.NEXUS_PACKAGE_MODE) ??
      validateBoolean(fileConfig.packageMode) ??
      false,
```

- [ ] **Step 7: テストが通ることを確認**

Run: `npx vitest run tests/unit/config/index.test.ts`
Expected: PASS（既存テスト＋新規 4 テストが全て通る）。

- [ ] **Step 8: 型チェック**

Run: `npx tsc -p tsconfig.build.json --noEmit`
Expected: `packageMode` missing エラーが解消。エラー 0 件（Task 4 未着手でも config/types は閉じている）。

- [ ] **Step 9: Commit**

```bash
git add src/config/index.ts tests/unit/config/index.test.ts
git commit -m "feat: wire bedrock provider, region/profile, and packageMode into config"
```

---

### Task 4: Factory 配線（provider ハードロック + case bedrock）

**Files:**
- Modify: `src/server/factory.ts:21-23`（embedding provider import 群）
- Modify: `src/server/factory.ts`（`assertPackageModeConstraints` を module スコープに新規追加。`NexusServerFactory` クラス宣言 L276 の直前）
- Modify: `src/server/factory.ts:537-560`（`setupPluginRegistry` 冒頭にガード呼び出し、switch に `case "bedrock"`）
- Test: `tests/unit/server/factory.test.ts`（新規）

**Interfaces:**
- Consumes: `BedrockEmbeddingProvider`（Task 2）、`config.packageMode` / `config.embedding.provider`（Task 3）、`Config`（Task 1）。
- Produces: `export function assertPackageModeConstraints(config: Config): void`（`packageMode && provider!=='bedrock'` で throw）。`setupPluginRegistry` が `provider==='bedrock'` で `BedrockEmbeddingProvider` を登録。

- [ ] **Step 1: 失敗するテストを書く**

Create `tests/unit/server/factory.test.ts`:
```typescript
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../../../src/config/index.js';
import { NexusServerFactory, assertPackageModeConstraints } from '../../../src/server/factory.js';
import type { Config } from '../../../src/types/index.js';
import type { PluginRegistry } from '../../../src/plugins/registry.js';

interface FactoryInternals {
  setupPluginRegistry(config: Config): PluginRegistry;
}

const internals = NexusServerFactory as unknown as FactoryInternals;

describe('assertPackageModeConstraints', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('does nothing when packageMode is false regardless of provider', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-factory-'));
    const config = await loadConfig({ projectRoot: tempDir, env: { NEXUS_EMBEDDING_PROVIDER: 'ollama' } });
    expect(() => assertPackageModeConstraints(config)).not.toThrow();
  });

  it('passes when packageMode is true and provider is bedrock', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-factory-'));
    const config = await loadConfig({
      projectRoot: tempDir,
      env: { NEXUS_PACKAGE_MODE: '1', NEXUS_EMBEDDING_PROVIDER: 'bedrock', NEXUS_EMBEDDING_DIMENSIONS: '1024' },
    });
    expect(() => assertPackageModeConstraints(config)).not.toThrow();
  });

  it('throws when packageMode is true and provider is not bedrock', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-factory-'));
    const config = await loadConfig({
      projectRoot: tempDir,
      env: { NEXUS_PACKAGE_MODE: '1', NEXUS_EMBEDDING_PROVIDER: 'ollama' },
    });
    expect(() => assertPackageModeConstraints(config)).toThrow(/requires embedding\.provider="bedrock"/);
  });
});

describe('NexusServerFactory.setupPluginRegistry', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('registers the bedrock provider when provider is bedrock', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-factory-'));
    const config = await loadConfig({
      projectRoot: tempDir,
      env: {
        NEXUS_EMBEDDING_PROVIDER: 'bedrock',
        NEXUS_EMBEDDING_DIMENSIONS: '1024',
        NEXUS_EMBEDDING_REGION: 'us-east-1',
      },
    });

    const registry = internals.setupPluginRegistry(config);
    expect(registry.getActiveEmbeddingProviderName()).toBe('bedrock');
  });

  it('fails fast in packageMode when provider is not bedrock', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'nexus-factory-'));
    const config = await loadConfig({
      projectRoot: tempDir,
      env: { NEXUS_PACKAGE_MODE: '1', NEXUS_EMBEDDING_PROVIDER: 'openai-compat' },
    });

    expect(() => internals.setupPluginRegistry(config)).toThrow(/requires embedding\.provider="bedrock"/);
  });
});
```

> 注（確認済み）: `PluginRegistry` は [src/plugins/registry.ts:107](../../../src/plugins/registry.ts) に存在し、`getActiveEmbeddingProviderName(): string | undefined` は同ファイル L132 で公開されている。import パス `../../../src/plugins/registry.js` はそのまま使用可。

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run tests/unit/server/factory.test.ts`
Expected: FAIL（`assertPackageModeConstraints` が `factory.ts` から export されていない）。

- [ ] **Step 3: Bedrock provider を import**

`src/server/factory.ts:23`（`import { OpenAICompatEmbeddingProvider } ...` の行）の直後に追加:
```typescript
import { BedrockEmbeddingProvider } from "../plugins/embeddings/bedrock.js";
```

- [ ] **Step 4: `assertPackageModeConstraints` を追加**

`src/server/factory.ts` の `export class NexusServerFactory {`（L276）の直前に、module スコープの関数を追加:
```typescript
/**
 * Enforces NEXUS_PACKAGE_MODE constraints. In package mode the embedding
 * provider is hard-locked to "bedrock"; any other provider fails fast.
 * model / dimensions / region remain deploy-variable and are NOT validated here.
 */
export function assertPackageModeConstraints(config: Config): void {
  if (!config.packageMode) {
    return;
  }
  if (config.embedding.provider !== "bedrock") {
    throw new Error(
      `NEXUS_PACKAGE_MODE requires embedding.provider="bedrock", ` +
        `but received "${config.embedding.provider}". ` +
        `The packaged plugin only supports AWS Bedrock embeddings.`,
    );
  }
}

```

- [ ] **Step 5: `setupPluginRegistry` にガードと case bedrock を追加**

`src/server/factory.ts:537-538` の `setupPluginRegistry` 冒頭を以下へ変更（`assertPackageModeConstraints(config);` を最初の行に挿入）:
```typescript
  private static setupPluginRegistry(config: Config): PluginRegistry {
    assertPackageModeConstraints(config);
    const registry = new PluginRegistry();
```

続けて switch（L553-555、`case "openai-compat":` ブロック）の直後に `case "bedrock"` を追加。変更後の該当箇所:
```typescript
      case "openai-compat":
        provider = new OpenAICompatEmbeddingProvider(config.embedding);
        break;
      case "bedrock":
        provider = new BedrockEmbeddingProvider(config.embedding);
        break;
      case "test":
        throw new Error(
          "Test embedding provider is not supported in production.",
        );
```

- [ ] **Step 6: テストが通ることを確認**

Run: `npx vitest run tests/unit/server/factory.test.ts`
Expected: PASS（5 tests passed）。

- [ ] **Step 7: 型チェック**

Run: `npx tsc -p tsconfig.build.json --noEmit`
Expected: エラー 0 件。

- [ ] **Step 8: Commit**

```bash
git add src/server/factory.ts tests/unit/server/factory.test.ts
git commit -m "feat: hard-lock provider to bedrock in package mode and wire factory switch"
```

---

### Task 5: 回帰・総合検証

**Files:**
- 変更なし（検証のみ）

**Interfaces:**
- Consumes: Task 1〜4 の全成果物。

- [ ] **Step 1: 全ユニットテスト**

Run: `npm test`
Expected: 全テスト PASS。既存の `ollama` / `openai-compat` / config テストが不変で通ること。新規の bedrock / factory テストが通ること。事前に失敗しているテストがあれば、それが本変更と無関係であることを確認し、コマンドと失敗要約を報告する（マスクしない）。

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: エラー 0 件。

- [ ] **Step 3: ビルド**

Run: `npm run build`
Expected: exit code 0。`dist/bin/nexus.js` と `dist/dashboard/cli.js` が生成される（dashboard 同梱・無改修を確認）。

- [ ] **Step 4: 原本モードのスモーク（provider スイッチが壊れていないこと）**

Run:
```bash
node -e "import('./dist/config/index.js').then(async (m) => { const c = await m.loadConfig({ projectRoot: process.cwd(), env: {} }); console.log('provider=', c.embedding.provider, 'packageMode=', c.packageMode); })"
```
Expected: `provider= ollama packageMode= false`（原本デフォルト不変）。

- [ ] **Step 5: パッケージモードの fail-fast スモーク（provider 不一致で即エラー）**

Run:
```bash
node -e "import('./dist/server/factory.js').then(async (f) => { const cfg = { projectRoot: process.cwd(), storage:{rootDir:'.nexus',metadataDbPath:'.nexus/m.db',vectorDbPath:'.nexus/v',batchSize:1000}, watcher:{debounceMs:100,maxQueueSize:1,fullScanThreshold:1,ignorePaths:[]}, embedding:{provider:'ollama',model:'x',dimensions:768,maxConcurrency:1,batchSize:1,retryCount:0,retryBaseDelayMs:1}, indexing:{maxFileBytes:1,maxChunkChars:1,chunkConcurrency:1,embedBatchWindowSize:1}, packageMode:true }; try { f.assertPackageModeConstraints(cfg); console.log('NO THROW (unexpected)'); process.exit(1); } catch (e) { console.log('OK fail-fast:', e.message); } })"
```
Expected: `OK fail-fast: NEXUS_PACKAGE_MODE requires embedding.provider="bedrock", ...`

- [ ] **Step 6: 最終コミット（検証で変更が出た場合のみ）**

検証で追加修正が発生した場合のみ:
```bash
git add -A
git commit -m "test: verify bedrock provider and package mode end-to-end"
```
変更が無ければコミット不要。

---

## Appendix A: 設計前提と実コードの乖離（意思決定待ち・任意タスク）

### 検出した乖離

設計書 §3.3 / §5.4 / §6.2 / §7 は「aggregator（Grafana/Prometheus）登録は `aggregatorPort` 未設定で既定オフ。よってメトリクスは**コード変更なし**」と前提している。しかし実コードを追うと、この前提は**成立していない**:

- [src/server/index.ts:354-370](../../../src/server/index.ts#L354-L370): `metricsCollectorRegistry` は factory から常に渡される（[factory.ts:480](../../../src/server/factory.ts)）ため `metricsServer` は常に起動し、`preferredPort = metricsPort ?? 0`（ポート 0 = 自動採番）で `resolvedPort` は**常に定義される**。
- [src/server/index.ts:87-107](../../../src/server/index.ts#L87-L107) `createRegistrationClient` は `resolvedPort === undefined` の時のみ `null` を返す。しかし上記のとおり `resolvedPort`（＝metrics ポート）は常に定義されるため、**登録クライアントは常に起動**し、`aggregatorPort ?? 9470` に対し 30 秒間隔で POST を試みる（[registration-client.ts:37-59](../../../src/observability/registration-client.ts)）。

つまり登録は「`aggregatorPort` 未設定で既定オフ」ではなく、**常に `127.0.0.1:9470` へ登録を試行**する（aggregator 不在時は debug ログのみで非致命）。パッケージ版が明示的に除外したい「外部連携」が、実際にはバックグラウンドで動作し続ける。

### 影響評価

- **機能面**: 非致命。登録失敗は debug ログのみで、検索・インデックスには影響しない。
- **設計意図面**: §3.3「Grafana/Prometheus 外部連携の除外」に反する残存挙動。設計 §6.2 L124 は「必要なら明示スキップのガードを足す程度」と、この対応の余地を残している。

### 判断が必要な点（ユーザー確認事項）

設計 §7 は 3.3 を「コード変更なし」としているが、上記の実挙動を踏まえると、パッケージ版で外部連携を真に除外するには**明示ガードの追加が必要**。以下 2 案のいずれかをユーザーが選択する:

- **案 A（現状維持・推奨度中）**: ガードを追加しない。localhost への無害な登録試行を許容し、設計 §7 の「コード変更なし」に忠実。
- **案 B（意図を実現・推奨度高）**: `packageMode` 時に登録をスキップするガードを追加（下記 Task A1）。ただし設計 §5.5/§6.2 の「メトリクス層に触れない」に対し、登録クライアント（`src/observability/`）への最小限の介入が発生する点を承知の上で実施。

> **注**: 本乖離は「メトリクス**収集**層」ではなく「aggregator **登録**（外部連携）」に限定される。案 B でも `MetricsCollector`・metrics HTTP サーバ・TUI は不変で、§5.4「ローカル metrics/TUI は維持」とは両立する。

### Task A1（任意・案 B 選択時のみ実施）: packageMode で aggregator 登録をスキップ

**Files:**
- Modify: `src/server/index.ts`（`NexusServerOptions` に `packageMode?: boolean` を追加。`createRegistrationClient` 呼び出し L365-370 を `packageMode` でガード）
- Modify: `src/server/factory.ts`（`buildNexusRuntime` 呼び出しに `packageMode: config.packageMode` を追加。L468-485 付近のオプション群）
- Test: `tests/unit/server/factory.test.ts` もしくは server 統合テストに「packageMode 時に registrationClient が生成されない」ケースを追加

**Interfaces:**
- Consumes: `Config.packageMode`（Task 1）。

- [ ] **Step 1: 失敗するテストを書く**（`packageMode=true` で `runtime.registrationClient` が `null`/`undefined` になることを検証。既存の `buildNexusRuntime`/`createNexusServer` の初期化フローに沿ったテストを追加。`NexusRuntime.registrationClient` は [factory.ts の NexusRuntime 型](../../../src/server/factory.ts) に既出）
- [ ] **Step 2: テストが失敗することを確認** — Run: `npx vitest run tests/unit/server/factory.test.ts`
- [ ] **Step 3: `NexusServerOptions` に `packageMode?: boolean` を追加**（`src/server/index.ts:48-54` の options 型末尾、`aggregatorPort?: number;` の直後）
- [ ] **Step 4: 登録呼び出しをガード** — `src/server/index.ts:365-370` を以下へ:
```typescript
          registrationClient = options.packageMode
            ? null
            : createRegistrationClient(
                options.aggregatorPort ?? 9470,
                resolvedPort,
                options.projectRoot,
                options.projectName,
              );
```
- [ ] **Step 5: factory から packageMode を伝搬** — `src/server/factory.ts` の `buildNexusRuntime({ ... })` 呼び出し（L468-485）に `packageMode: config.packageMode,` を追加
- [ ] **Step 6: テストが通ることを確認** — Run: `npx vitest run tests/unit/server/factory.test.ts`
- [ ] **Step 7: 型チェック + lint** — Run: `npx tsc -p tsconfig.build.json --noEmit && npm run lint`
- [ ] **Step 8: Commit** — `git commit -m "feat: skip aggregator registration in package mode"`

---

## Appendix B: スコープ外の後続計画（配布パイプライン §8）

設計書 §8 の配布パイプライン改訂は**別計画**として作成する（本計画完了後）。理由: 変換対象の `stage-plugin-dist.sh` は本リポジトリに未存在で、別計画 [2026-07-07-nexus-plugin-bitbucket-source-mirror-deploy.md](2026-07-07-nexus-plugin-bitbucket-source-mirror-deploy.md) の territory に属する（CI/CD ステージング＝Node アプリとは別サブシステム）。

後続計画で扱う項目（設計 §8）:
1. `stage-plugin-dist.sh` で plugin.json を stage 時変換（`userConfig` 除去、`mcpServers.nexus.env` を固定リテラル `NEXUS_PACKAGE_MODE=1` / `NEXUS_EMBEDDING_PROVIDER=bedrock` / `NEXUS_EMBEDDING_MODEL` / `NEXUS_EMBEDDING_DIMENSIONS=1024` / `NEXUS_EMBEDDING_REGION` / 任意 `NEXUS_EMBEDDING_PROFILE` へ置換、`base_url`/`api_key` env 削除）。`packages/dashboard` は同梱維持・ビルド無改修。
2. GitHub Actions 変数（`region` / 任意 `profile` / `model`・`dimensions`）の受け渡し。
3. Prerequisites（利用者マシンの AWS 資格情報）文書化。
4. `claude plugin validate --strict` 通過確認。

> **重要**: 本計画（コア変更）は `.claude-plugin/plugin.json` を編集しない。原本は引き続き `userConfig`（ollama 選択 UI）を保持する。パッケージ版の固定 env 注入は配布時変換でのみ行う。

---

## Self-Review

**1. Spec coverage（設計書 §6 との対応）:**
- §6.1 Bedrock provider → Task 2 ✅
- §6.1「契約・配線の変更」: types union+region/profile → Task 1、config isProvider+region/profile → Task 3、factory switch → Task 4、package.json → Task 1 ✅
- §6.2 packageMode（Config フィールド + factory ハードロック + metrics 不変 + 外部連携既定オフ）→ Task 1（Config）/ Task 3（config 配線）/ Task 4（ハードロック）✅。「外部連携既定オフ」は前提が実コードと乖離 → Appendix A で明示・任意タスク化 ⚠️
- §6.3 config/env サーフェス → Task 3 ✅（region 既定 `us-east-1` フォールバックは provider 側 `createDefaultDependencies` で実装、§6.4 L147 と整合）
- §6.4 エラー処理（リトライ/非リトライ分類・healthCheck・region フォールバック警告）→ Task 2 ✅
- §6.5 テスト（provider ユニット・factory・config・回帰）→ Task 2/3/4/5 ✅。staging テストは Appendix B（スコープ外）
- §3.3/§5.4 メトリクス（ローカル維持・外部連携除外）→ ローカル metrics/TUI 不変（触れない）✅、外部連携除外は Appendix A ⚠️

**2. Placeholder scan:** 全ステップに実コード/実コマンド/期待出力を記載。TBD・「適切に処理」等のプレースホルダ無し ✅。唯一 Task 4 Step 1 の `PluginRegistry` import パスのみ実装時に `grep` 確認する指示付き（`src/plugins/registry.ts` を想定）。

**3. Type consistency:** `BedrockEmbeddingProvider` / `BedrockProviderConfig` / `assertPackageModeConstraints` / `asBoolean` / `validateBoolean` の名称は Task 2/3/4 で一貫。`EmbeddingConfig.provider` union、`Config.packageMode`、`region?`/`profile?` は Task 1 で定義し Task 2/3/4 が同名で参照。`getActiveEmbeddingProviderName()`（[server/index.ts の PluginRegistry 型](../../../src/server/index.ts)）は公開メソッドとして確認済み。

**未解決の意思決定（実行前に確認推奨）:** Appendix A の案 A / 案 B。既定では本体タスク（Task 1〜5）のみ実行し、Task A1 はユーザーが案 B を選択した場合のみ実施する。
