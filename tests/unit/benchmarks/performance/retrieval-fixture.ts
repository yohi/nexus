import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GrepMatch } from '../../../../src/types/index.js';
import { toolResult } from '../../../../src/server/tools/tool-support.js';
import { captureObservedGrep, observeRuntimeWork, startRuntimeWork } from '../../../../src/observability/runtime-work.js';
import { generateFixture } from '../../../benchmarks/performance/fixtures.js';
import { createFixturePathNormalizer } from '../../../benchmarks/performance/logical-path.js';
import { runOptionsSchema } from '../../../benchmarks/performance/contracts.js';
import type { OutcomeCollector } from '../../../benchmarks/performance/outcomes.js';

export async function createRetrievalFixture() {
  const root = await mkdtemp(join(tmpdir(), 'nexus-retrieval-contract-'));
  const manifest = await generateFixture(root, 'smoke');
  const normalize = await createFixturePathNormalizer(root, manifest);
  const run = runOptionsSchema.parse({ profile: 'smoke', outputMode: 'stdout', revision: { commit: 'a'.repeat(40), dirty: true },
    timeoutMs: 30_000, auditPageSize: 512, cacheSeedBatchSize: 512, memoryLimitMb: 2_048, sampleMode: 'smoke' });
  const query = (id: string) => {
    const value = manifest.queries.find((item) => item.id === id);
    if (value === undefined) throw new Error('query required');
    return value;
  };
  return { root, manifest, normalize, run, query,
    dispose: () => rm(root, { recursive: true, force: true }) };
}

export function observedGrepHandler(collector: OutcomeCollector, matches: GrepMatch[]) {
  return () => observeRuntimeWork(collector, 'grep', () => {
    const child = startRuntimeWork(collector, 'grep_spawn');
    child.emit({ kind: 'grep_child_finished', outcome: { status: 'exited', exitCode: matches.length === 0 ? 1 : 0 } });
    child.finish('success');
    captureObservedGrep(collector, matches, 'direct');
    return Promise.resolve(toolResult({ matches }));
  });
}
