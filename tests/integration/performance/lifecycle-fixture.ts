import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateFixture } from '../../benchmarks/performance/fixtures.js';
import { OutcomeCollector } from '../../benchmarks/performance/outcomes.js';
import { createBenchmarkRuntimeFactory } from '../../benchmarks/performance/runtime.js';
import type { RuntimeAssembly } from '../../../src/server/runtime/assembly-types.js';

export async function createLifecycleFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-lifecycle-'));
  const source = join(directory, 'source');
  await mkdir(source);
  const root = await realpath(source);
  const manifest = await generateFixture(root, 'smoke');
  const collector = new OutcomeCollector();
  const baseFactory = createBenchmarkRuntimeFactory(root, collector);
  const assemblies: RuntimeAssembly[] = [];
  const closed = new WeakSet<RuntimeAssembly>();
  const factory = async (signal: AbortSignal): Promise<RuntimeAssembly> => {
    const assembly = await baseFactory(signal);
    assemblies.push(assembly);
    const close = assembly.runtime.close.bind(assembly.runtime);
    assembly.runtime.close = async () => { await close(); closed.add(assembly); };
    return assembly;
  };
  return { root, manifest, collector, factory,
    dispose: async () => {
      collector.releaseAll();
      try { for (const assembly of assemblies) if (!closed.has(assembly)) await assembly.runtime.close(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    },
  };
}

export class ControlledClock {
  private value = 0;
  readonly now = (): number => this.value;
  advance(milliseconds: number): void { this.value += milliseconds; }
}
