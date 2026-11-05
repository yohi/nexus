import { DEFAULT_OLLAMA_NUM_THREAD } from '../../config/index.js';
import { PluginRegistry } from '../../plugins/registry.js';
import { TypeScriptLanguagePlugin } from '../../plugins/languages/typescript.js';
import { PythonLanguagePlugin } from '../../plugins/languages/python.js';
import { GoLanguagePlugin } from '../../plugins/languages/go.js';
import { CLanguagePlugin } from '../../plugins/languages/c.js';
import { CppLanguagePlugin } from '../../plugins/languages/cpp.js';
import { CSharpLanguagePlugin } from '../../plugins/languages/csharp.js';
import { JavaLanguagePlugin } from '../../plugins/languages/java.js';
import { RustLanguagePlugin } from '../../plugins/languages/rust.js';
import { OllamaEmbeddingProvider } from '../../plugins/embeddings/ollama.js';
import { OpenAICompatEmbeddingProvider } from '../../plugins/embeddings/openai-compat.js';
import { BedrockEmbeddingProvider } from '../../plugins/embeddings/bedrock.js';
import type { Config, EmbeddingConfig, EmbeddingProvider } from '../../types/index.js';

export type EmbeddingProviderFactory = (config: Readonly<EmbeddingConfig>) => EmbeddingProvider;

export function assertPackageModeConstraints(config: Config): void {
  if (!config.packageMode) return;
  if (config.embedding.provider !== 'bedrock') {
    throw new Error(`NEXUS_PACKAGE_MODE requires embedding.provider="bedrock", ` +
      `but received "${config.embedding.provider}". The packaged plugin only supports AWS Bedrock embeddings.`);
  }
}

export function assertInternalProvider(config: Config, factory?: EmbeddingProviderFactory): void {
  if (factory === undefined) return;
  const allowedKeys = new Set(['provider', 'model', 'dimensions', 'maxConcurrency', 'batchSize', 'retryCount', 'retryBaseDelayMs']);
  const embedding = config.embedding;
  if (config.packageMode || embedding.provider !== 'test' || embedding.model !== 'nexus-synthetic-sha256-v1' ||
    embedding.dimensions !== 128 || embedding.maxConcurrency !== 1 || embedding.batchSize !== 64 ||
    embedding.retryCount !== 0 || embedding.retryBaseDelayMs !== 0 ||
    Object.keys(embedding).some((key) => !allowedKeys.has(key))) {
    throw new TypeError('invalid_internal_embedding_configuration');
  }
}

export function setupPluginRegistry(config: Config, factory?: EmbeddingProviderFactory): PluginRegistry {
  assertPackageModeConstraints(config);
  assertInternalProvider(config, factory);
  const registry = new PluginRegistry();
  registry.registerLanguage(new TypeScriptLanguagePlugin());
  registry.registerLanguage(new PythonLanguagePlugin());
  registry.registerLanguage(new GoLanguagePlugin());
  registry.registerLanguage(new CLanguagePlugin());
  registry.registerLanguage(new CppLanguagePlugin());
  registry.registerLanguage(new CSharpLanguagePlugin());
  registry.registerLanguage(new JavaLanguagePlugin());
  registry.registerLanguage(new RustLanguagePlugin());
  let provider: EmbeddingProvider;
  switch (config.embedding.provider) {
    case 'ollama':
      provider = new OllamaEmbeddingProvider({ ...config.embedding,
        ollamaNumThread: config.embedding.ollamaNumThread ?? DEFAULT_OLLAMA_NUM_THREAD });
      break;
    case 'openai-compat': provider = new OpenAICompatEmbeddingProvider(config.embedding); break;
    case 'bedrock': provider = new BedrockEmbeddingProvider(config.embedding); break;
    case 'test':
      if (factory === undefined) throw new Error('Test embedding provider is not supported in production.');
      provider = factory(Object.freeze({ ...config.embedding }));
      if (provider.dimensions !== config.embedding.dimensions) throw new TypeError('invalid_internal_embedding_dimensions');
      break;
    default: throw new Error('Unsupported embedding provider: ' + String(config.embedding.provider));
  }
  registry.registerEmbeddingProvider(config.embedding.provider, provider);
  registry.setActiveEmbeddingProvider(config.embedding.provider);
  return registry;
}
