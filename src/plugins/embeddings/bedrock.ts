import { randomInt } from 'node:crypto';
import pLimit from 'p-limit';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { fromIni } from '@aws-sdk/credential-providers';
import { NodeHttpHandler } from '@smithy/node-http-handler';

import type { EmbeddingConfig } from '../../types/index.js';
import { RetryExhaustedError, DimensionMismatchError } from '../../types/index.js';
import { BaseEmbeddingProvider } from './base.js';

const DEFAULT_REGION = 'us-east-1';

const DEFAULT_TIMEOUT_MS = 30_000; // 30 seconds

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
    public readonly retriable: boolean = false,
  ) {
    super(message);
    this.name = 'BedrockEmbedError';
  }
}

// AWS SDK v3 modeled exception `.name` values that must NOT be retried.
// DimensionMismatchError is intentionally absent: it is caught by a dedicated
// branch in embedOneWithRetry and re-thrown before isRetriable is ever reached.
const NON_RETRIABLE_EXCEPTIONS = new Set([
  'AccessDeniedException',
  'ValidationException',
  'ResourceNotFoundException',
  'ExpiredTokenException',
  'UnrecognizedClientException',
]);

export type BedrockProviderConfig = Pick<
  EmbeddingConfig,
  'model' | 'dimensions' | 'maxConcurrency' | 'retryCount' | 'retryBaseDelayMs' | 'region' | 'profile' | 'timeoutMs'
>;

const createDefaultDependencies = (config: BedrockProviderConfig): BedrockDependencies => {
  const region = config.region ?? DEFAULT_REGION;
  if (!config.region) {
    console.warn(
      `[Nexus] NEXUS_EMBEDDING_REGION is not set; falling back to "${DEFAULT_REGION}". ` +
        `Set the region to match your Bedrock deployment.`,
    );
  }

  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requestHandler = new NodeHttpHandler({
    requestTimeout: timeoutMs,
    connectionTimeout: timeoutMs,
  });

  const runtimeClient = new BedrockRuntimeClient({
    region,
    requestHandler,
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
      // Single, no-retry probe: liveness checks must fail fast rather than
      // inheriting the full embed retry/backoff budget.
      const vector = await this.embedOne('nexus health check');
      return Array.isArray(vector) && vector.length === this.dimensions;
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const message = error instanceof Error ? error.message : String(error);
      if (
        name === 'AccessDeniedException' ||
        name === 'ExpiredTokenException' ||
        name === 'UnrecognizedClientException'
      ) {
        console.warn(
          `[Nexus] Bedrock ヘルスチェック失敗: AWS認証情報が無効か期限切れの可能性があります。` +
            `'aws sso login' を実行するか、IAMロール/ポリシーの権限を確認してください。(${name}: ${message})`,
        );
      } else if (name === 'ResourceNotFoundException') {
        console.warn(
          `[Nexus] Bedrock ヘルスチェック失敗: モデル "${this.config.model}" が有効化されていない可能性があります。` +
            `AWSコンソールでBedrockのモデルアクセスを有効化してください。(${name}: ${message})`,
        );
      } else if (name === 'ValidationException') {
        console.warn(
          `[Nexus] Bedrock ヘルスチェック失敗: リクエストパラメータが無効です。` +
            `model/dimensions/region の設定を確認してください。(${name}: ${message})`,
        );
      } else {
        console.warn(`[Nexus] Bedrock ヘルスチェック失敗: ${message}`);
      }
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
        // Full jitter over the exponential backoff window avoids synchronized
        // retry bursts (thundering herd) across concurrent embed requests.
        const backoffMs = this.config.retryBaseDelayMs * 2 ** (attempt - 1);
        // Sonar (S2245) flags Math.random() unconditionally; use crypto.randomInt
        // for the jitter draw even though this is not security-sensitive.
        const jitterMs = backoffMs > 0 ? randomInt(0, Math.ceil(backoffMs)) : 0;
        await this.dependencies.sleep(jitterMs);
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
