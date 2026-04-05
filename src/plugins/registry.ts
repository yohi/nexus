import type { LanguagePlugin } from '../types/index.js';

export class LanguageRegistry {
  private readonly plugins: LanguagePlugin[] = [];

  register(plugin: LanguagePlugin): void {
    this.plugins.push(plugin);
  }

  findForFile(filePath: string): LanguagePlugin | undefined {
    return this.plugins.find((plugin) => plugin.supports(filePath));
  }
}

export class PluginRegistry {
  private readonly languageRegistry = new LanguageRegistry();

  registerLanguage(plugin: LanguagePlugin): void {
    this.languageRegistry.register(plugin);
  }

  getLanguagePlugin(filePath: string): LanguagePlugin | undefined {
    return this.languageRegistry.findForFile(filePath);
  }
}
