import type { EmbeddingProvider, LanguagePlugin } from '../types/index.js';

export interface HealthCheckResult {
  languages: string[];
  embeddingProvider: string | undefined;
  healthy: boolean;
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

  async healthCheck(): Promise<HealthCheckResult> {
    const provider = this.embeddings.getActive();
    const healthy = provider ? await provider.healthCheck() : false;

    return {
      languages: this.languages.list().map((plugin) => plugin.languageId),
      embeddingProvider: this.embeddings.getActiveName(),
      healthy,
    };
  }
}
