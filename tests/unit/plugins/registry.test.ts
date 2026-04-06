import { describe, expect, it } from 'vitest';

import { PluginRegistry } from '../../../src/plugins/registry.js';
import { GoLanguagePlugin } from '../../../src/plugins/languages/go.js';
import { PythonLanguagePlugin } from '../../../src/plugins/languages/python.js';
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
    registry.registerLanguage(new PythonLanguagePlugin());
    registry.registerLanguage(new GoLanguagePlugin());

    expect(registry.getLanguagePlugin('src/index.ts')?.languageId).toBe('typescript');
    expect(registry.getLanguagePlugin('src/utils.py')?.languageId).toBe('python');
    expect(registry.getLanguagePlugin('src/handler.go')?.languageId).toBe('go');
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

    const result = await registry.healthCheck();
    expect(result).toEqual({
      languages: {
        registered: ['typescript'],
        healthy: true,
      },
      embeddings: {
        provider: 'test',
        healthy: true,
      },
      healthy: true,
      isOperational: true,
    });
  });

  it('reports operational even if embeddings are missing', async () => {
    const registry = new PluginRegistry();
    registry.registerLanguage(new TypeScriptLanguagePlugin());

    const result = await registry.healthCheck();
    expect(result).toMatchObject({
      languages: {
        healthy: true,
      },
      embeddings: {
        healthy: false,
      },
      healthy: false,
      isOperational: true,
    });
  });

  it('returns undefined for active provider name when none is registered', () => {
    const registry = new PluginRegistry();
    expect(registry.getActiveEmbeddingProviderName()).toBe(undefined);
  });

  it('lists registered embedding provider names', () => {
    const registry = new PluginRegistry();
    registry.registerEmbeddingProvider('ollama', new TestEmbeddingProvider());
    registry.registerEmbeddingProvider('openai', new TestEmbeddingProvider());

    const names = registry.getRegisteredEmbeddingProviderNames();
    expect(names).toContain('ollama');
    expect(names).toContain('openai');
    expect(names.length).toBe(2);
  });

  it('handles provider health check errors gracefully', async () => {
    const registry = new PluginRegistry();
    registry.registerLanguage(new TypeScriptLanguagePlugin());
    registry.registerEmbeddingProvider('crasher', new CrashingEmbeddingProvider());

    const status = await registry.healthCheck();
    expect(status.embeddings.healthy).toBe(false);
    expect(status.embeddings.provider).toBe('crasher');
    expect(status.healthy).toBe(false);
    expect(status.isOperational).toBe(true);
  });
});
