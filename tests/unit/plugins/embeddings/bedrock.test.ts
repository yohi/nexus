import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BedrockEmbeddingProvider } from '../../../../src/plugins/embeddings/bedrock.js';
import { RetryExhaustedError, DimensionMismatchError } from '../../../../src/types/index.js';

const { bedrockClientMock, fromIniMock } = vi.hoisted(() => ({
  bedrockClientMock: vi.fn(),
  fromIniMock: vi.fn(),
}));

vi.mock('@aws-sdk/client-bedrock-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-bedrock-runtime')>();
  return {
    ...actual,
    BedrockRuntimeClient: vi.fn().mockImplementation((options: unknown) => {
      bedrockClientMock(options);
      return { send: vi.fn() };
    }),
  };
});

vi.mock('@aws-sdk/credential-providers', () => ({
  fromIni: fromIniMock,
}));

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

    const command = send.mock.calls[0]?.[0] as { input: { modelId: string; body: string } };
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

  it('warns with credential guidance from healthCheck on AccessDeniedException', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const send = vi.fn().mockImplementation(async () => {
      const err = new Error('not authorized to invoke model');
      err.name = 'AccessDeniedException';
      throw err;
    });
    const provider = new BedrockEmbeddingProvider(mockConfig, { client: { send }, sleep: vi.fn() });

    expect(await provider.healthCheck()).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('AWS認証情報が無効か期限切れの可能性があります'),
    );
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("'aws sso login'"));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('(AccessDeniedException: not authorized to invoke model)'),
    );
    warnSpy.mockRestore();
  });

  it('warns with credential guidance from healthCheck on ExpiredTokenException', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const send = vi.fn().mockImplementation(async () => {
      const err = new Error('the security token included in the request is expired');
      err.name = 'ExpiredTokenException';
      throw err;
    });
    const provider = new BedrockEmbeddingProvider(mockConfig, { client: { send }, sleep: vi.fn() });

    expect(await provider.healthCheck()).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('AWS認証情報が無効か期限切れの可能性があります'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('(ExpiredTokenException: the security token included in the request is expired)'),
    );
    warnSpy.mockRestore();
  });

  it('warns with credential guidance from healthCheck on UnrecognizedClientException', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const send = vi.fn().mockImplementation(async () => {
      const err = new Error('the security token included in the request is invalid');
      err.name = 'UnrecognizedClientException';
      throw err;
    });
    const provider = new BedrockEmbeddingProvider(mockConfig, { client: { send }, sleep: vi.fn() });

    expect(await provider.healthCheck()).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('AWS認証情報が無効か期限切れの可能性があります'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('(UnrecognizedClientException: the security token included in the request is invalid)'),
    );
    warnSpy.mockRestore();
  });

  it('warns to enable the model from healthCheck on ResourceNotFoundException', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const send = vi.fn().mockImplementation(async () => {
      const err = new Error('the requested model is not available');
      err.name = 'ResourceNotFoundException';
      throw err;
    });
    const provider = new BedrockEmbeddingProvider(mockConfig, { client: { send }, sleep: vi.fn() });

    expect(await provider.healthCheck()).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('モデル "amazon.titan-embed-text-v2:0" が有効化されていない可能性があります'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('AWSコンソールでBedrockのモデルアクセスを有効化してください'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('(ResourceNotFoundException: the requested model is not available)'),
    );
    warnSpy.mockRestore();
  });

  it('warns about invalid parameters from healthCheck on ValidationException', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const send = vi.fn().mockImplementation(async () => {
      const err = new Error('malformed input request');
      err.name = 'ValidationException';
      throw err;
    });
    const provider = new BedrockEmbeddingProvider(mockConfig, { client: { send }, sleep: vi.fn() });

    expect(await provider.healthCheck()).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('リクエストパラメータが無効です'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('model/dimensions/region の設定を確認してください'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('(ValidationException: malformed input request)'),
    );
    warnSpy.mockRestore();
  });

  it('warns with the raw message from healthCheck on an unclassified error', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const send = vi.fn().mockImplementation(async () => {
      const err = new Error('connection refused');
      err.name = 'TimeoutError';
      throw err;
    });
    const provider = new BedrockEmbeddingProvider(mockConfig, { client: { send }, sleep: vi.fn() });

    expect(await provider.healthCheck()).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith('[Nexus] Bedrock ヘルスチェック失敗: connection refused');
    warnSpy.mockRestore();
  });

  it('warns with String(error) from healthCheck when a non-Error value is thrown', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const send = vi.fn().mockImplementation(async () => {
      throw 'plain string failure';
    });
    const provider = new BedrockEmbeddingProvider(mockConfig, { client: { send }, sleep: vi.fn() });

    expect(await provider.healthCheck()).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith('[Nexus] Bedrock ヘルスチェック失敗: plain string failure');
    warnSpy.mockRestore();
  });
});

describe('BedrockEmbeddingProvider default dependencies', () => {
  beforeEach(() => {
    bedrockClientMock.mockClear();
    fromIniMock.mockClear();
  });

  it('warns and falls back to the default region when region is unset', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const configWithoutRegion = {
      model: 'amazon.titan-embed-text-v2:0',
      dimensions: 2,
      maxConcurrency: 1,
      retryCount: 3,
      retryBaseDelayMs: 10,
    };

    const provider = new BedrockEmbeddingProvider(configWithoutRegion);

    expect(provider).toBeInstanceOf(BedrockEmbeddingProvider);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('NEXUS_EMBEDDING_REGION is not set'));
    expect(bedrockClientMock).toHaveBeenCalledWith(expect.objectContaining({ region: 'us-east-1' }));
    warnSpy.mockRestore();
  });

  it('wires the configured profile through fromIni into the client credentials', () => {
    const sentinelCredentials = { accessKeyId: 'sentinel' };
    fromIniMock.mockReturnValue(sentinelCredentials);

    const provider = new BedrockEmbeddingProvider({ ...mockConfig, profile: 'nexus-dev' });

    expect(provider).toBeInstanceOf(BedrockEmbeddingProvider);
    expect(fromIniMock).toHaveBeenCalledWith({ profile: 'nexus-dev' });
    expect(bedrockClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: sentinelCredentials }),
    );
  });
});
