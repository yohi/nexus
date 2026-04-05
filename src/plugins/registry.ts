import type { EmbeddingProvider, LanguagePlugin } from '../types/index.js';

/**
 * Result of the plugin registry health check.
 */
export interface HealthCheckResult {
  /**
   * Details about language plugins.
   */
  languages: {
    /**
     * List of registered language plugin IDs.
     */
    registered: string[];
    /**
     * True if at least one language plugin is registered.
     */
    healthy: boolean;
  };
  /**
   * Details about the embedding provider.
   */
  embeddings: {
    /**
     * Name of the active embedding provider, if any.
     */
    provider: string | undefined;
    /**
     * True if the active provider is registered and its health check passed.
     */
    healthy: boolean;
  };
  /**
   * Overall health status.
   * True if both language plugins and the embedding provider are healthy.
   */
  healthy: boolean;
  /**
   * Indicates if the registry is operational.
   * True if at least one language plugin is registered, which allows for basic
   * indexing and grep-based search even if semantic search is unavailable.
   */
  isOperational: boolean;
}

export class LanguageRegistry {
  private readonly plugins: LanguagePlugin[] = [];

  register(plugin: LanguagePlugin): void {
    const existingIndex = this.plugins.findIndex((candidate) => candidate.languageId === plugin.languageId);
    if (existingIndex >= 0) {
      this.plugins.splice(existingIndex, 1, plugin);
      return;
    }
    this.plugins.push(plugin);
  }

  findForFile(filePath: string): LanguagePlugin | undefined {
    return this.plugins.find((plugin) => plugin.supports(filePath));
  }

  list(): LanguagePlugin[] {
    return [...this.plugins];
  }
}

export class EmbeddingProviderRegistry {
  private readonly providers = new Map<string, EmbeddingProvider>();

  private activeProviderName: string | undefined = undefined;

  register(name: string, provider: EmbeddingProvider): void {
    this.providers.set(name, provider);
    if (this.activeProviderName === undefined) {
      this.activeProviderName = name;
    }
  }

  setActive(name: string): void {
    if (!this.providers.has(name)) {
      throw new Error(`Embedding provider not found: ${name}`);
    }
    this.activeProviderName = name;
  }

  getActive(): EmbeddingProvider | undefined {
    if (this.activeProviderName === undefined) {
      return undefined;
    }
    return this.providers.get(this.activeProviderName);
  }

  getActiveName(): string | undefined {
    return this.activeProviderName;
  }

  getRegisteredProviderNames(): string[] {
    return Array.from(this.providers.keys());
  }
}

export class PluginRegistry {
  readonly languages = new LanguageRegistry();

  readonly embeddings = new EmbeddingProviderRegistry();

  registerLanguage(plugin: LanguagePlugin): void {
    this.languages.register(plugin);
  }

  getLanguagePlugin(filePath: string): LanguagePlugin | undefined {
    return this.languages.findForFile(filePath);
  }

  registerEmbeddingProvider(name: string, provider: EmbeddingProvider): void {
    this.embeddings.register(name, provider);
  }

  getEmbeddingProvider(): EmbeddingProvider | undefined {
    return this.embeddings.getActive();
  }

  setActiveEmbeddingProvider(name: string): void {
    this.embeddings.setActive(name);
  }

  /**
   * Performs a health check on all registered plugins and providers.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const provider = this.embeddings.getActive();
    let embeddingHealthy = false;
    if (provider) {
      try {
        embeddingHealthy = await provider.healthCheck();
      } catch {
        embeddingHealthy = false;
      }
    }

    const registeredLanguages = this.languages.list().map((plugin) => plugin.languageId);
    const languagesHealthy = registeredLanguages.length > 0;

    return {
      languages: {
        registered: registeredLanguages,
        healthy: languagesHealthy,
      },
      embeddings: {
        provider: this.embeddings.getActiveName(),
        healthy: embeddingHealthy,
      },
      healthy: languagesHealthy && embeddingHealthy,
      isOperational: languagesHealthy,
    };
  }
}
