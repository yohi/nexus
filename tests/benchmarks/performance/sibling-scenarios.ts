import type { FixtureManifest, Profile, ScenarioRecord } from './contracts.js';
import { scenarioRecordSchema } from './contracts.js';
import { createSiblingGitFixture, GitFixtureError } from './git-fixture.js';
import { runStartupScenario } from './lifecycle.js';
import type { LifecycleContext } from './lifecycle.js';
import { lifecycleBase } from './lifecycle-context.js';
import { createBenchmarkRuntimeFactory } from './runtime.js';
import { OutcomeCollector } from './outcomes.js';
import { systemClock } from './clock.js';

const kinds = ['sibling_first', 'sibling_second'] as const;

export async function runSiblingScenarios(profile: Profile, context: Readonly<LifecycleContext>, onFixture?: (manifest: FixtureManifest) => void): Promise<readonly ScenarioRecord[]> {
  const clock = context.clock ?? systemClock;
  const started = clock.now();
  let fixture: Awaited<ReturnType<typeof createSiblingGitFixture>> | undefined;
  let records: ScenarioRecord[] = [];
  let failureCode: string | undefined;
  try {
    fixture = await createSiblingGitFixture(profile, context.signal);
    if (fixture.status === 'skipped') return kinds.map((kind) => scenarioRecordSchema.parse({
      ...lifecycleBase(kind, context), status: 'skipped', reason: fixture?.status === 'skipped' ? fixture.reason : 'git_unavailable',
    }));
    onFixture?.(fixture.manifest);
    const setupMs = context.setupMs + clock.now() - started;
    for (const peer of fixture.worktrees) {
      const collector = new OutcomeCollector(context.signal);
      const kind = peer.role === 'first' ? 'sibling_first' : 'sibling_second';
      try {
        records.push(await runStartupScenario(kind, createBenchmarkRuntimeFactory(peer.root, collector), fixture.manifest,
          { ...context, collector, setupMs }));
      } finally { collector.releaseAll(); }
    }
  } catch (error) { failureCode = error instanceof GitFixtureError ? error.code : 'sibling_setup_failed'; }
  finally {
    if (fixture?.status === 'ready') {
      try { await fixture.dispose(); }
      catch { failureCode = 'git_cleanup_failed'; }
    }
  }
  if (failureCode !== undefined) records = kinds.map((kind) => scenarioRecordSchema.parse({
    ...lifecycleBase(kind, context), status: 'invalid', phase: 'setup',
    elapsedMs: context.setupMs + clock.now() - started,
    failures: [{ code: failureCode, count: 1, examples: [] }],
  }));
  return records;
}
