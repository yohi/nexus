# Nexus パッケージ版（Bedrock ＋ パッケージモード ＋ 配布変換）実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** パッケージ版プラグイン（`yohi-nexus`）向けに、AWS Bedrock 埋め込みプロバイダと単一フラグ `NEXUS_PACKAGE_MODE`（埋め込みハードロック）をコアに追加し、ソースミラー配布時に plugin.json を stage 時変換する。

**Architecture:** 設定駆動の単一コードベース。Bedrock は正規プロバイダとしてコアに追加（原本からも利用可）。`NEXUS_PACKAGE_MODE` は埋め込みを `provider=bedrock` / `model=amazon.titan-embed-text-v2:0` / `dimensions=1024` に固定するハードロックを担い、メトリクス/TUI には触れない。配布は既存のソースミラー方式に「stage 時 plugin.json 変換」を足すだけ（`packages/dashboard` は同梱維持・ビルド無改修）。

**Tech Stack:** TypeScript(strict) + `@aws-sdk/client-bedrock-runtime` / `@aws-sdk/credential-providers`、Vitest、Node.js 24、Bash、GitHub Actions。

**設計根拠:** [../specs/2026-07-07-nexus-packaged-plugin-restrictions.md](../specs/2026-07-07-nexus-packaged-plugin-restrictions.md)

## Global Constraints

- Node.js `>= 24.0.0`（`package.json` の `engines.node`）。
- TypeScript strict。`as any` / `@ts-ignore` / `@ts-expect-error` は禁止（テストコードも含む）。
- 埋め込み固定値（パッケージ版）: `provider=bedrock` / `model=amazon.titan-embed-text-v2:0` / `dimensions=1024`。
- AWS 認証は SDK デフォルト認証チェーンに委譲（`credentials` 未指定）。任意で `credentials: fromIni({ profile })`。region 未指定時のコード側フォールバックは `us-east-1`。
- Titan v2 はバッチ非対応（1 リクエスト＝`inputText` 1 件）。`embed(texts[])` は `maxConcurrency` で並列化する。
- ローカル metrics 層・TUI（`nexus dashboard` / `packages/dashboard`）は不変（触らない）。Grafana/Prometheus 外部連携は設定・文書化しない。
- 設定優先順位は既存の `env ?? .nexus.json ?? default`。パッケージ版固定値は plugin.json の `mcpServers.nexus.env` で注入する（`.nexus.json` はプラグイン install 先から読まれないため使わない）。
- git は明示指示時のみ。`master` へ commit/push しない。コミットメッセージは日本語 Conventional Commits。

---

## File Structure

| ファイル | 責務 | 変更 |
| --- | --- | --- |
| `src/types/index.ts` | `EmbeddingConfig.provider` に `"bedrock"`、`region?`/`profile?`、`Config.packageMode` | Modify |
| `src/config/index.ts` | `isProvider` 拡張、env 配線、`assertPackageModeConstraints` | Modify |
| `src/plugins/embeddings/bedrock.ts` | Bedrock 埋め込みプロバイダ | Create |
| `src/server/factory.ts` | switch に `case "bedrock"`、packageMode ハードロック呼び出し | Modify |
| `package.json` | `@aws-sdk/client-bedrock-runtime` / `@aws-sdk/credential-providers` 追加 | Modify |
| `tests/unit/plugins/embeddings/bedrock.test.ts` | Bedrock プロバイダの単体テスト | Create |
| `tests/unit/config/index.test.ts` | env 配線・`assertPackageModeConstraints` のテスト | Modify |
| `scripts/stage-plugin-dist.sh` | ソースミラー staging ＋ stage 時 plugin.json 変換 | Create |
| `docs/superpowers/plans/2026-07-07-nexus-plugin-bitbucket-source-mirror-deploy.md` | 前提・制約をパッケージ版に合わせて改訂 | Modify |

---

## Phase 1: コア変更（Bedrock ＋ パッケージモード）

### Task 1: 型と設定の配線

**Files:**
- Modify: `src/types/index.ts`
- Modify: `src/config/index.ts`
- Test: `tests/unit/config/index.test.ts`

**Interfaces:**
- Produces: `EmbeddingConfig.provider` union に `"bedrock"`；`EmbeddingConfig.region?: string`／`EmbeddingConfig.profile?: string`；`Config.packageMode: boolean`。env `NEXUS_EMBEDDING_REGION` / `NEXUS_EMBEDDING_PROFILE` / `NEXUS_PACKAGE_MODE`。`export function assertPackageModeConstraints(config: Pick<Config, 'packageMode' | 'embedding'>): void`。

- [ ] **Step 1: 失敗するテストを書く**

`tests/unit/config/index.test.ts` に追記する。

```typescript
import { loadConfig, assertPackageModeConstraints } from '../../../src/config/index.js';

describe('bedrock / packageMode config', () => {
  it('resolves bedrock provider, region, profile, packageMode from env', async () => {
    const config = await loadConfig({
      projectRoot: '/tmp/nexus-cfg-test',
      env: {
        NEXUS_EMBEDDING_PROVIDER: 'bedrock',
        NEXUS_EMBEDDING_MODEL: 'amazon.titan-embed-text-v2:0',
        NEXUS_EMBEDDING_DIMENSIONS: '1024',
        NEXUS_EMBEDDING_REGION: 'ap-northeast-1',
        NEXUS_EMBEDDING_PROFILE: 'work-sso',
        NEXUS_PACKAGE_MODE: '1',
      },
    });
    expect(config.embedding.provider).toBe('bedrock');
    expect(config.embedding.region).toBe('ap-northeast-1');
    expect(config.embedding.profile).toBe('work-sso');
    expect(config.packageMode).toBe(true);
  });

  it('defaults packageMode=false and region us-east-1', async () => {
    const config = await loadConfig({ projectRoot: '/tmp/nexus-cfg-test', env: {} });
    expect(config.packageMode).toBe(false);
    expect(config.embedding.region).toBe('us-east-1');
  });

  it('assertPackageModeConstraints throws when packageMode && provider!=bedrock', () => {
    expect(() =>
      assertPackageModeConstraints({ packageMode: true, embedding: { provider: 'ollama' } }),
    ).toThrow(/bedrock/);
  });

  it('assertPackageModeConstraints throws when packageMode model/dimensions deviate', () => {
    expect(() =>
      assertPackageModeConstraints({
        packageMode: true,
        embedding: { provider: 'bedrock', model: 'wrong-model', dimensions: 1024 },
      }),
    ).toThrow(/model/);
    expect(() =>
      assertPackageModeConstraints({
        packageMode: true,
        embedding: { provider: 'bedrock', model: 'amazon.titan-embed-text-v2:0', dimensions: 512 },
      }),
    ).toThrow(/dimensions/);
  });

  it('assertPackageModeConstraints passes for fixed bedrock config or non-package mode', () => {
    expect(() =>
      assertPackageModeConstraints({
        packageMode: true,
        embedding: { provider: 'bedrock', model: 'amazon.titan-embed-text-v2:0', dimensions: 1024 },
      }),
    ).not.toThrow();
    expect(() => assertPackageModeConstraints({ packageMode: false, embedding: { provider: 'ollama' } })).not.toThrow();
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

Run: `npx vitest run tests/unit/config/index.test.ts`
Expected: FAIL（`assertPackageModeConstraints` 未定義／`region`・`packageMode` が undefined）。

- [ ] **Step 3: 型を追加する**

`src/types/index.ts` の `EmbeddingConfig` を変更する（`provider` union に `"bedrock"` を追加、`region?`/`profile?` を追加）。

```typescript
export interface EmbeddingConfig {
  provider: "ollama" | "openai-compat" | "bedrock" | "test";
  model: string;
  dimensions: number;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
  region?: string | undefined;
  profile?: string | undefined;
  maxConcurrency: number;
  batchSize: number;
  retryCount: number;
  retryBaseDelayMs: number;
  timeoutMs?: number | undefined;
  ollamaNumThread?: number | undefined;
}
```

`Config` インターフェースに `packageMode` を追加する。

```typescript
export interface Config {
  projectRoot: string;
  projectName?: string | undefined;
  storage: StorageConfig;
  watcher: WatcherConfig;
  embedding: EmbeddingConfig;
  indexing: IndexingConfig;
  packageMode: boolean;
  metricsPort?: number | undefined;
  aggregatorPort?: number | undefined;
}
```

- [ ] **Step 4: config の配線を実装する**

`src/config/index.ts` を変更する。

- `DEFAULT_EMBEDDING` に `region: 'us-east-1'` を追加（フォールバック既定）。
- `isProvider` に `bedrock` を許可する。

```typescript
const isProvider = (value: unknown): value is EmbeddingConfig['provider'] => {
  return value === 'ollama' || value === 'openai-compat' || value === 'bedrock' || value === 'test';
};
```

- `loadConfig` の `merged.embedding` に `region` / `profile` を追加する（`apiKey` の直後）。

```typescript
      region: asString(env.NEXUS_EMBEDDING_REGION) ?? validateString(fileConfig.embedding?.region) ?? defaults.embedding.region,
      profile: asString(env.NEXUS_EMBEDDING_PROFILE) ?? validateString(fileConfig.embedding?.profile),
```

- `merged` の末尾（`aggregatorPort` の後）に `packageMode` を追加する。

```typescript
    packageMode: asBoolean(env.NEXUS_PACKAGE_MODE) ?? validateBoolean(fileConfig.packageMode) ?? false,
```

- boolean ヘルパと制約関数を追加する（ファイル末尾のヘルパ群の近く）。

```typescript
const asBoolean = (value: string | undefined): boolean | undefined => {
  if (value === undefined) return undefined;
  const v = value.trim().toLowerCase();
  if (v === '1' || v === 'true') return true;
  if (v === '0' || v === 'false' || v === '') return false;
  return undefined;
};

const validateBoolean = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

/** パッケージモードでは埋め込みの provider/model/dimensions を固定値にロックする（逸脱時は fail-fast）。 */
export const assertPackageModeConstraints = (
  config: Pick<Config, 'packageMode' | 'embedding'>,
): void => {
  if (!config.packageMode) return;
  const { provider, model, dimensions } = config.embedding;
  if (provider !== 'bedrock') {
    throw new Error(
      `packageMode requires embedding provider 'bedrock', but got '${provider}'.`,
    );
  }
  if (model !== 'amazon.titan-embed-text-v2:0') {
    throw new Error(
      `packageMode locks embedding model to 'amazon.titan-embed-text-v2:0', but got '${model}'.`,
    );
  }
  if (dimensions !== 1024) {
    throw new Error(
      `packageMode locks embedding dimensions to 1024, but got ${dimensions}.`,
    );
  }
};
```

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest run tests/unit/config/index.test.ts && npm run lint`
Expected: PASS、lint エラーなし。

- [ ] **Step 6: コミット**

```bash
git add src/types/index.ts src/config/index.ts tests/unit/config/index.test.ts
git commit -m "feat: 埋め込みにbedrockプロバイダ設定とpackageModeを追加"
```

---

### Task 2: Bedrock 埋め込みプロバイダ

**Files:**
- Modify: `package.json`
- Create: `src/plugins/embeddings/bedrock.ts`
- Test: `tests/unit/plugins/embeddings/bedrock.test.ts`

**Interfaces:**
- Consumes: `EmbeddingConfig`（Task 1）、`BaseEmbeddingProvider`、`RetryExhaustedError` / `DimensionMismatchError` / `NonRetryableEmbeddingError`（`src/types/index.js`）。
- Produces: `export class BedrockEmbeddingProvider extends BaseEmbeddingProvider`。コンストラクタは `(config: Pick<EmbeddingConfig, 'model' | 'dimensions' | 'maxConcurrency' | 'retryCount' | 'retryBaseDelayMs' | 'region' | 'profile'>, dependencies?: Partial<BedrockDependencies>)`。`BedrockDependencies = { send: (command: InvokeModelCommand) => Promise<{ body: Uint8Array }>; sleep: (ms: number) => Promise<void> }`。

- [ ] **Step 1: 依存を追加する**

Run: `npm install @aws-sdk/client-bedrock-runtime @aws-sdk/credential-providers`
Expected: `package.json` の dependencies に 2 パッケージが追加され、`package-lock.json` が更新される。

- [ ] **Step 2: 失敗するテストを書く**

`tests/unit/plugins/embeddings/bedrock.test.ts` を新規作成する。

```typescript
import { describe, expect, it, vi } from 'vitest';

import { BedrockEmbeddingProvider } from '../../../../src/plugins/embeddings/bedrock.js';
import { RetryExhaustedError, DimensionMismatchError } from '../../../../src/types/index.js';

const baseConfig = {
  model: 'amazon.titan-embed-text-v2:0',
  dimensions: 2,
  maxConcurrency: 2,
  retryCount: 3,
  retryBaseDelayMs: 10,
  region: 'us-east-1',
};

const encode = (obj: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(obj));
const named = (name: string, message: string): Error => Object.assign(new Error(message), { name });

describe('BedrockEmbeddingProvider', () => {
  it('embeds each text via a single InvokeModel call', async () => {
    const send = vi.fn().mockImplementation(async (command: { input: { body: string } }) => {
      const parsed = JSON.parse(String(command.input.body)) as { inputText: string };
      const vector = parsed.inputText === 'a' ? [0.1, 0.2] : [0.3, 0.4];
      return { body: encode({ embedding: vector, inputTextTokenCount: 1 }) };
    });
    const provider = new BedrockEmbeddingProvider(baseConfig, { send, sleep: vi.fn() });

    const result = await provider.embed(['a', 'b']);

    expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('throws DimensionMismatchError when the vector length differs', async () => {
    const send = vi.fn().mockResolvedValue({ body: encode({ embedding: [0.1, 0.2, 0.3] }) });
    const provider = new BedrockEmbeddingProvider(baseConfig, { send, sleep: vi.fn() });
    await expect(provider.embed(['a'])).rejects.toBeInstanceOf(DimensionMismatchError);
  });

  it('retries on ThrottlingException then succeeds', async () => {
    let attempts = 0;
    const send = vi.fn().mockImplementation(async () => {
      attempts += 1;
      if (attempts < 3) throw named('ThrottlingException', 'slow down');
      return { body: encode({ embedding: [0.5, 0.6] }) };
    });
    const sleep = vi.fn();
    const provider = new BedrockEmbeddingProvider(baseConfig, { send, sleep });

    const result = await provider.embed(['a']);

    expect(result).toEqual([[0.5, 0.6]]);
    expect(send).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not retry AccessDeniedException (surfaces RetryExhaustedError once)', async () => {
    const send = vi.fn().mockImplementation(async () => {
      throw named('AccessDeniedException', 'no access');
    });
    const provider = new BedrockEmbeddingProvider(baseConfig, { send, sleep: vi.fn() });
    await expect(provider.embed(['a'])).rejects.toBeInstanceOf(RetryExhaustedError);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('healthCheck returns true when dimensions match', async () => {
    const send = vi.fn().mockResolvedValue({ body: encode({ embedding: [0.1, 0.2] }) });
    const provider = new BedrockEmbeddingProvider(baseConfig, { send, sleep: vi.fn() });
    expect(await provider.healthCheck()).toBe(true);
  });
});
```

- [ ] **Step 3: テストが失敗することを確認**

Run: `npx vitest run tests/unit/plugins/embeddings/bedrock.test.ts`
Expected: FAIL（`bedrock.ts` が存在しない）。

- [ ] **Step 4: プロバイダを実装する**

`src/plugins/embeddings/bedrock.ts` を新規作成する。

```typescript
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { fromIni } from '@aws-sdk/credential-providers';
import pLimit from 'p-limit';

import type { EmbeddingConfig } from '../../types/index.js';
import { RetryExhaustedError, DimensionMismatchError, NonRetryableEmbeddingError } from '../../types/index.js';
import { BaseEmbeddingProvider } from './base.js';

const DEFAULT_REGION = 'us-east-1';

const NON_RETRYABLE_ERROR_NAMES = new Set([
  'AccessDeniedException',
  'ValidationException',
  'ResourceNotFoundException',
  'ExpiredTokenException',
  'UnrecognizedClientException',
]);

export interface BedrockDependencies {
  send: (command: InvokeModelCommand) => Promise<{ body: Uint8Array }>;
  sleep: (ms: number) => Promise<void>;
}

interface TitanEmbedResponse {
  embedding: number[];
  inputTextTokenCount?: number;
}

const createDefaultSend = (region: string, profile?: string): BedrockDependencies['send'] => {
  const client = new BedrockRuntimeClient({
    region,
    ...(profile ? { credentials: fromIni({ profile }) } : {}),
  });
  return async (command) => {
    const output = await client.send(command);
    return { body: output.body };
  };
};

export class BedrockEmbeddingProvider extends BaseEmbeddingProvider {
  readonly dimensions: number;

  private readonly limit;
  private readonly send: BedrockDependencies['send'];
  private readonly sleep: BedrockDependencies['sleep'];

  constructor(
    private readonly config: Pick<
      EmbeddingConfig,
      'model' | 'dimensions' | 'maxConcurrency' | 'retryCount' | 'retryBaseDelayMs' | 'region' | 'profile'
    >,
    dependencies: Partial<BedrockDependencies> = {},
  ) {
    super();
    this.dimensions = config.dimensions;
    this.limit = pLimit(config.maxConcurrency);
    this.send = dependencies.send ?? createDefaultSend(config.region ?? DEFAULT_REGION, config.profile);
    this.sleep = dependencies.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async embed(texts: string[]): Promise<number[][]> {
    const promises = texts.map((text) => this.limit(() => this.embedTextWithRetry(text)));
    return Promise.all(promises);
  }

  async healthCheck(): Promise<boolean> {
    try {
      const vector = await this.requestEmbedding('ping');
      return vector.length === this.dimensions;
    } catch {
      return false;
    }
  }

  private async embedTextWithRetry(text: string): Promise<number[]> {
    let attempt = 0;
    let lastError: Error | undefined;

    while (attempt <= this.config.retryCount) {
      try {
        return await this.requestEmbedding(text);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (error instanceof DimensionMismatchError) {
          throw error;
        }
        if (error instanceof NonRetryableEmbeddingError) {
          throw new RetryExhaustedError(error.message, 1, { cause: error });
        }
        if (attempt >= this.config.retryCount) {
          break;
        }
        attempt += 1;
        await this.sleep(this.config.retryBaseDelayMs * 2 ** (attempt - 1));
      }
    }

    throw new RetryExhaustedError('Failed to fetch embeddings from AWS Bedrock', attempt + 1, {
      cause: lastError,
    });
  }

  private async requestEmbedding(inputText: string): Promise<number[]> {
    if (!Number.isInteger(this.dimensions) || this.dimensions <= 0) {
      throw new NonRetryableEmbeddingError('Embedding dimensions must be a positive integer');
    }

    const command = new InvokeModelCommand({
      modelId: this.config.model,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({ inputText, dimensions: this.dimensions, normalize: true }),
    });

    let output: { body: Uint8Array };
    try {
      output = await this.send(command);
    } catch (error) {
      throw this.mapAwsError(error);
    }

    const payload = JSON.parse(new TextDecoder().decode(output.body)) as TitanEmbedResponse;
    if (!Array.isArray(payload.embedding) || !payload.embedding.every((v) => typeof v === 'number')) {
      throw new NonRetryableEmbeddingError('Invalid embedding payload from AWS Bedrock');
    }
    if (payload.embedding.length !== this.dimensions) {
      throw new DimensionMismatchError(
        `Unexpected embedding dimension: expected ${this.dimensions}, received ${payload.embedding.length}`,
      );
    }
    return payload.embedding;
  }

  private mapAwsError(error: unknown): Error {
    const name = error instanceof Error ? error.name : '';
    const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    const message = error instanceof Error ? error.message : String(error);
    const isClientError = status !== undefined && status >= 400 && status < 500 && status !== 429;

    if (NON_RETRYABLE_ERROR_NAMES.has(name) || isClientError) {
      return new NonRetryableEmbeddingError(`AWS Bedrock request failed (${name || String(status)}): ${message}`);
    }
    return error instanceof Error ? error : new Error(message);
  }
}
```

- [ ] **Step 5: テストが通ることを確認**

Run: `npx vitest run tests/unit/plugins/embeddings/bedrock.test.ts && npm run lint`
Expected: 全 5 ケース PASS、lint エラーなし。

- [ ] **Step 6: コミット**

```bash
git add package.json package-lock.json src/plugins/embeddings/bedrock.ts tests/unit/plugins/embeddings/bedrock.test.ts
git commit -m "feat: AWS Bedrock埋め込みプロバイダを追加"
```

---

### Task 3: factory 配線 ＋ パッケージモードのハードロック

**Files:**
- Modify: `src/server/factory.ts`
- Test: `tests/unit/config/index.test.ts`（Task 1 で追加した `assertPackageModeConstraints` テストが本タスクの回帰ゲートを兼ねる）

**Interfaces:**
- Consumes: `BedrockEmbeddingProvider`（Task 2）、`assertPackageModeConstraints`（Task 1）。
- Produces: `config.embedding.provider === 'bedrock'` のとき `setupPluginRegistry` が `BedrockEmbeddingProvider` を登録する。`packageMode` かつ非 bedrock はサーバ構築時に fail-fast する。

- [ ] **Step 1: import を追加する**

`src/server/factory.ts` の import 群に追加する。

```typescript
import { BedrockEmbeddingProvider } from "../plugins/embeddings/bedrock.js";
import { assertPackageModeConstraints } from "../config/index.js";
```

- [ ] **Step 2: switch に bedrock ケースを追加する**

`setupPluginRegistry` の `switch (config.embedding.provider)` に、`case "openai-compat"` の直後へ追加する。

```typescript
      case "bedrock":
        provider = new BedrockEmbeddingProvider(config.embedding);
        break;
```

- [ ] **Step 3: ハードロックを呼び出す**

`setupPluginRegistry` の先頭（`const registry = new PluginRegistry();` の直前）に追加する。

```typescript
    assertPackageModeConstraints(config);
```

- [ ] **Step 4: ビルドと関連テストで検証する**

Run: `npm run build && npx vitest run tests/unit/config/index.test.ts tests/unit/plugins/embeddings/bedrock.test.ts && npm run lint`
Expected: 型エラーなしでビルド成功（`bedrock` ケース・ハードロック呼び出しが型整合）、テスト PASS、lint クリーン。

- [ ] **Step 5: 回帰確認（原本モードが不変であること）**

Run: `npm test`
Expected: 既存テストが全て PASS（`ollama` / `openai-compat` / metrics / TUI 関連に影響なし）。pre-existing の失敗があれば、その正確なコマンドと失敗要約を報告し、本変更起因でないことを明示する。

- [ ] **Step 6: コミット**

```bash
git add src/server/factory.ts
git commit -m "feat: factoryにbedrock分岐とpackageModeハードロックを配線"
```

---

## Phase 2: 配布（stage 時 plugin.json 変換）

### Task 4: ソースミラー staging スクリプト（plugin.json 変換つき）

**Files:**
- Create: `scripts/stage-plugin-dist.sh`
- Test: 本タスクの Step 内でローカル実行検証（staging 出力の検査 ＋ 自己完結ビルド）

**Interfaces:**
- Produces: `scripts/stage-plugin-dist.sh <staging-dir>` — 第 1 引数の staging ディレクトリを作り直し、ビルド可能な最小ソース一式（`.claude-plugin/plugin.json`（変換後）, `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.build.json`, `src/`, `packages/dashboard/{package.json,src/}`, `scripts/setup-plugin.sh`, `LICENSE`, `NOTICE`）をコピーする。plugin.json は `userConfig` を除去し `mcpServers.nexus.env` を固定値へ置換する。固定値は環境変数 `NEXUS_EMBEDDING_REGION`（既定 `us-east-1`）・`NEXUS_EMBEDDING_MODEL`（既定 `amazon.titan-embed-text-v2:0`）・`NEXUS_EMBEDDING_DIMENSIONS`（既定 `1024`）・`NEXUS_EMBEDDING_PROFILE`（任意）から読む。

- [ ] **Step 1: スクリプトを作成する**

`scripts/stage-plugin-dist.sh` を新規作成する。

```bash
#!/bin/bash
# Stage the nexus PACKAGED plugin as a build-ready "source mirror" for Bitbucket.
#
# ネイティブ依存(better-sqlite3, @lancedb/lancedb)と tsc(非バンドル)ビルドのため
# dist-only では配れない。利用者マシンで npm install && npm run build する前提で
# ビルド可能な最小ソース一式を配布する。packages/dashboard(ローカルTUI)は同梱する。
#
# パッケージ版差分は plugin.json の stage 時変換のみ:
#   - userConfig を除去
#   - mcpServers.nexus.env を固定値へ置換(NEXUS_PACKAGE_MODE=1 + Bedrock 固定)
#
# Usage: scripts/stage-plugin-dist.sh <staging-dir>
set -euo pipefail

STAGING_DIR="${1:?usage: stage-plugin-dist.sh <staging-dir>}"

REGION="${NEXUS_EMBEDDING_REGION:-us-east-1}"
MODEL="${NEXUS_EMBEDDING_MODEL:-amazon.titan-embed-text-v2:0}"
DIMENSIONS="${NEXUS_EMBEDDING_DIMENSIONS:-1024}"
PROFILE="${NEXUS_EMBEDDING_PROFILE:-}"

rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR/.claude-plugin" "$STAGING_DIR/scripts" "$STAGING_DIR/packages/dashboard"

# Package manifests + lockfile, TS build config, root source
cp package.json package-lock.json "$STAGING_DIR/"
cp tsconfig.json tsconfig.build.json "$STAGING_DIR/"
cp -r src "$STAGING_DIR/"

# Dashboard workspace (local TUI は維持)
cp packages/dashboard/package.json "$STAGING_DIR/packages/dashboard/"
cp -r packages/dashboard/src "$STAGING_DIR/packages/dashboard/"

# Runtime setup hook + license files
cp scripts/setup-plugin.sh "$STAGING_DIR/scripts/"
cp LICENSE NOTICE "$STAGING_DIR/"

# Transform plugin.json: strip userConfig, inject fixed env
STAGING_DIR="$STAGING_DIR" REGION="$REGION" MODEL="$MODEL" DIMENSIONS="$DIMENSIONS" PROFILE="$PROFILE" \
  node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';

const src = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8'));
delete src.userConfig;

const env = {
  NEXUS_PACKAGE_MODE: '1',
  NEXUS_EMBEDDING_PROVIDER: 'bedrock',
  NEXUS_EMBEDDING_MODEL: process.env.MODEL,
  NEXUS_EMBEDDING_DIMENSIONS: process.env.DIMENSIONS,
  NEXUS_EMBEDDING_REGION: process.env.REGION,
};
if (process.env.PROFILE) env.NEXUS_EMBEDDING_PROFILE = process.env.PROFILE;

src.mcpServers.nexus.env = env;

const out = `${process.env.STAGING_DIR}/.claude-plugin/plugin.json`;
writeFileSync(out, JSON.stringify(src, null, 2) + '\n');
NODE

echo "Staged packaged nexus plugin source mirror into: $STAGING_DIR"
```

- [ ] **Step 2: 実行権限を付与して staging を生成する**

Run:
```bash
chmod +x scripts/stage-plugin-dist.sh
NEXUS_EMBEDDING_REGION=ap-northeast-1 bash scripts/stage-plugin-dist.sh /tmp/nexus-pkg-stage
```
Expected: 最終行 `Staged packaged nexus plugin source mirror into: /tmp/nexus-pkg-stage`。非ゼロ終了しないこと。

- [ ] **Step 3: 変換後 plugin.json とファイル集合を検証する**

Run:
```bash
node --input-type=module <<'NODE'
import { readFileSync, existsSync } from 'node:fs';
const p = JSON.parse(readFileSync('/tmp/nexus-pkg-stage/.claude-plugin/plugin.json', 'utf8'));
if (p.userConfig) throw new Error('userConfig should be removed');
const e = p.mcpServers.nexus.env;
const expected = { NEXUS_PACKAGE_MODE: '1', NEXUS_EMBEDDING_PROVIDER: 'bedrock', NEXUS_EMBEDDING_DIMENSIONS: '1024', NEXUS_EMBEDDING_REGION: 'ap-northeast-1' };
for (const [k, v] of Object.entries(expected)) if (e[k] !== v) throw new Error(`env.${k} expected ${v}, got ${e[k]}`);
if (e.NEXUS_EMBEDDING_BASE_URL || e.NEXUS_EMBEDDING_API_KEY) throw new Error('base_url/api_key env must be absent');
if (!existsSync('/tmp/nexus-pkg-stage/packages/dashboard/src')) throw new Error('packages/dashboard must be bundled');
console.log('PLUGIN-TRANSFORM-OK');
NODE
```
Expected: `PLUGIN-TRANSFORM-OK`。

- [ ] **Step 4: ソースミラーが単体でビルドできることを検証する**

Run:
```bash
rm -rf /tmp/nexus-pkg-verify && cp -r /tmp/nexus-pkg-stage /tmp/nexus-pkg-verify
( cd /tmp/nexus-pkg-verify && npm install --no-audit --no-fund && npm run build && test -f dist/bin/nexus.js && test -f dist/dashboard/cli.js && echo "SELF-SUFFICIENT-OK" )
```
Expected: `npm run build` 成功（dashboard 込み）、最後に `SELF-SUFFICIENT-OK`。

- [ ] **Step 5: 掃除してコミット**

Run:
```bash
rm -rf /tmp/nexus-pkg-stage /tmp/nexus-pkg-verify
git add scripts/stage-plugin-dist.sh
git commit -m "feat: パッケージ版配布用ソースミラーstagingスクリプトを追加"
```

---

### Task 5: 配布計画ドキュメントの改訂

**Files:**
- Modify: `docs/superpowers/plans/2026-07-07-nexus-plugin-bitbucket-source-mirror-deploy.md`

**Interfaces:**
- Consumes: `scripts/stage-plugin-dist.sh`（Task 4）。
- Produces: 既存のソースミラー配布計画を「パッケージ版生成」に整合させた改訂（前提・制約・staging の記述）。

- [ ] **Step 1: Global Constraints を改訂する**

「`.claude-plugin/plugin.json` は編集しない」制約を、次の趣旨へ置き換える。

```markdown
- `.claude-plugin/plugin.json` はソース側では編集しない。パッケージ版差分は `scripts/stage-plugin-dist.sh` の stage 時変換で注入する（`userConfig` 除去・固定 env 注入）。
```

- [ ] **Step 2: Task 1 のファイル集合注記を更新する**

Task 1（staging スクリプト）の記述に、次を明記する。

```markdown
- パッケージ版では staging 時に plugin.json を変換する（`userConfig` 除去、`mcpServers.nexus.env` を `NEXUS_PACKAGE_MODE=1` ＋ Bedrock 固定へ置換）。実装は `scripts/stage-plugin-dist.sh`（本リポジトリの実装計画 2026-07-07-nexus-packaged-plugin-implementation.md Task 4）を正とする。`packages/dashboard` は同梱維持（ローカル TUI のため）。
```

- [ ] **Step 3: Prerequisites に AWS / GitHub Actions 変数を追記する**

```markdown
- [ ] **P5: AWS 資格情報（利用者マシン）**
  - パッケージ版は AWS Bedrock を直接呼ぶ。利用者マシンに AWS SDK デフォルト認証チェーンで解決可能な資格情報（env の IAM アクセスキー / SSO / 名前付きプロファイル / IAM ロールのいずれか）が必要。

- [ ] **P6: GitHub Actions 変数（deploy 可変値）**
  - `NEXUS_EMBEDDING_REGION`（既定 us-east-1）、任意 `NEXUS_EMBEDDING_PROFILE`、`NEXUS_EMBEDDING_MODEL`・`NEXUS_EMBEDDING_DIMENSIONS`（既定 titan v2 / 1024）を Repository variable として設定し、ワークフローの `stage-plugin-dist.sh` 実行 step に env として渡す。
```

- [ ] **Step 4: 冒頭の「保留」注記を解除する**

冒頭の前提変更注記（保留）を、本実装計画により未確定事項が確定した旨へ更新する。

```markdown
> **前提確定(2026-07-07):** [../specs/2026-07-07-nexus-packaged-plugin-restrictions.md](../specs/2026-07-07-nexus-packaged-plugin-restrictions.md) で全決定が確定。コア変更と stage 変換は [2026-07-07-nexus-packaged-plugin-implementation.md](2026-07-07-nexus-packaged-plugin-implementation.md) を参照。本計画のワークフロー(Task 2)は `scripts/stage-plugin-dist.sh` をそのまま呼ぶ。
```

- [ ] **Step 5: markdownlint を確認してコミット**

Run: `npx --yes markdownlint-cli2 "docs/superpowers/plans/2026-07-07-nexus-plugin-bitbucket-source-mirror-deploy.md" 2>&1 | grep -oE 'MD[0-9]+' | sort | uniq -c`
Expected: 追記により MD013(日本語ソフトラップ)以外の新規ルール違反が増えないこと。

```bash
git add docs/superpowers/plans/2026-07-07-nexus-plugin-bitbucket-source-mirror-deploy.md
git commit -m "docs: ソースミラー配布計画をパッケージ版生成に整合"
```

---

## Self-Review

**1. Spec coverage（[spec](../specs/2026-07-07-nexus-packaged-plugin-restrictions.md) 各節への対応）**
- §3.1 LLM ロック → Task 1（packageMode）＋ Task 3（ハードロック）＋ Task 4（plugin.json 変換・userConfig 除去・固定 env）。
- §3.2 Bedrock 直接呼び出し → Task 2（プロバイダ）＋ Task 1（型/config）＋ Task 3（factory）。
- §3.3 Grafana/Prometheus 外部連携除外・ローカル TUI 維持 → 触らない（Global Constraints で明示、Task 4 で `packages/dashboard` 同梱維持）。
- §5.1〜5.5 決定 → Task 1〜4 に反映。§6.1 API 形状 → Task 2 実装。§6.3 env サーフェス → Task 1。§6.4 エラー処理 → Task 2（`mapAwsError`・healthCheck）。§8 配布 → Task 4/5。ギャップなし。

**2. Placeholder scan**
- 「適切に」等の曖昧語・TODO・コード無し実装ステップは無し。全コードステップは実体コードを含む。

**3. Type/名称整合性**
- `assertPackageModeConstraints`（Task 1 定義 → Task 3 呼び出し）一致。`BedrockEmbeddingProvider`・`BedrockDependencies`（Task 2 定義 → Task 3 利用）一致。env 名（`NEXUS_EMBEDDING_REGION`/`_PROFILE`/`NEXUS_PACKAGE_MODE`）は Task 1・4・5 で一致。`EmbeddingConfig.region`/`profile`・`Config.packageMode`（Task 1 定義 → Task 2/3 利用）一致。

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-07-nexus-packaged-plugin-implementation.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — タスクごとに新規サブエージェントを割り当て、タスク間でレビュー、速い反復。

**2. Inline Execution** — 本セッションで executing-plans を用いてチェックポイント付きバッチ実行。

**Which approach?**
