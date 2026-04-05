import { describe, expect, it } from 'vitest';

import { PluginRegistry } from '../../../src/plugins/registry.js';
import { TypeScriptLanguagePlugin } from '../../../src/plugins/languages/typescript.js';
import { TestEmbeddingProvider } from '../plugins/embeddings/test-embedding-provider.js';

class UnhealthyEmbeddingProvider extends TestEmbeddingProvider {
  override async healthCheck(): Promise<boolean> {
    return false;
  }
}

class CrashingEmbeddingProvider extends TestEmbeddingProvider {
  override async healthCheck(): Promise<boolean> {
    throw new Error('Health check failed');
  }
}

describe('PluginRegistry', () => {
  it('registers language plugins and resolves by file path', () => {
    const registry = new PluginRegistry();
    registry.registerLanguage(new TypeScriptLanguagePlugin());

    expect(registry.getLanguagePlugin('src/index.ts')?.languageId).toBe('typescript');
  });

  it('switches the active embedding provider', () => {
    const registry = new PluginRegistry();
    registry.registerEmbeddingProvider('test', new TestEmbeddingProvider());
    registry.registerEmbeddingProvider('fallback', new UnhealthyEmbeddingProvider());

    registry.setActiveEmbeddingProvider('fallback');

    expect(registry.getEmbeddingProvider()).toBeInstanceOf(UnhealthyEmbeddingProvider);
  });

  it('reports aggregate plugin health', async () => {
    const registry = new PluginRegistry();
    registry.registerLanguage(new TypeScriptLanguagePlugin());
    registry.registerEmbeddingProvider('test', new TestEmbeddingProvider());

    await expect(registry.healthCheck()).resolves.toEqual({
      languages: ['typescript'],
      embeddingProvider: 'test',
      healthy: true,
    });
  });

  it('returns undefined for active provider name when none is registered', () => {
    const registry = new PluginRegistry();
    expect(registry.embeddings.getActiveName()).toBe(undefined);
  });

  it('handles provider health check errors gracefully', async () => {
    const registry = new PluginRegistry();
    registry.registerEmbeddingProvider('crasher', new CrashingEmbeddingProvider());

    const status = await registry.healthCheck();
    expect(status.healthy).toBe(false);
    expect(status.embeddingProvider).toBe('crasher');
  });
});
