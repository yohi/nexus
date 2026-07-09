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
