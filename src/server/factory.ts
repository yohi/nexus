import type { Config } from '../types/index.js';
import type { PluginRegistry } from '../plugins/registry.js';
import type { NexusRuntime } from './index.js';
import { createRuntimeAssembly } from './runtime-assembly.js';
import { setupPluginRegistry } from './runtime/plugins.js';
import { assertLiveWriterAdmission, type WriterAdmission } from './storage-ownership/admission.js';

export { assertPackageModeConstraints } from './runtime/plugins.js';

export class NexusServerFactory {
  /**
   * Creates a runtime behind the storage writer admission gate (Nexus #297). A supplied admission must be an
   * authentic, live, ISSUED handle for exactly this Config; the Assembly then consumes it once. Without a handle the
   * Assembly performs its own admission, so this entry point can never bypass the gate.
   */
  static async createRuntime(config: Config, admission?: WriterAdmission): Promise<NexusRuntime> {
    if (admission === undefined) return (await createRuntimeAssembly(config)).runtime;
    await assertLiveWriterAdmission(admission, config);
    return (await createRuntimeAssembly(config, { writerAdmission: admission })).runtime;
  }

  private static setupPluginRegistry(config: Config): PluginRegistry {
    return setupPluginRegistry(config);
  }
}
