import type { Config } from '../types/index.js';
import type { PluginRegistry } from '../plugins/registry.js';
import type { NexusRuntime } from './index.js';
import { createRuntimeAssembly } from './runtime-assembly.js';
import { setupPluginRegistry } from './runtime/plugins.js';

export { assertPackageModeConstraints } from './runtime/plugins.js';

export class NexusServerFactory {
  static async createRuntime(config: Config): Promise<NexusRuntime> {
    return (await createRuntimeAssembly(config)).runtime;
  }

  private static setupPluginRegistry(config: Config): PluginRegistry {
    return setupPluginRegistry(config);
  }
}
