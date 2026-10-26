import type { RunOptions, ScenarioRecord } from './contracts.js';
import type { Clock } from './clock.js';
import type { OutcomeCollector } from './outcomes.js';
import type { CacheSeedResult } from './cache-seed.js';

export type StartupKind = 'cold_initial_index' | 'l2_rebuild' | 'warm_restart' | 'sibling_first' | 'sibling_second';
export type OperationKind = 'l1_replay' | 'incremental';
export interface LifecycleContext {
  readonly run: RunOptions;
  readonly collector: OutcomeCollector;
  readonly signal: AbortSignal;
  readonly setupMs: number;
  readonly clock?: Clock;
  readonly cacheSeed?: CacheSeedResult;
}
const cacheStates = { cold_initial_index: 'empty', l2_rebuild: 'l2', warm_restart: 'persisted',
  sibling_first: 'empty', sibling_second: 'empty', l1_replay: 'l1', incremental: 'l1',
} as const satisfies Readonly<Record<StartupKind | OperationKind, ScenarioRecord['cacheState']>>;

export function lifecycleBase(kind: StartupKind | OperationKind, context: LifecycleContext) {
  return { id: kind, revision: context.run.revision,
    boundary: kind === 'l1_replay' || kind === 'incremental' ? 'indexing-operation' as const : 'runtime-assembly-to-ready' as const,
    cacheState: cacheStates[kind], sampleMode: context.run.sampleMode, memoryLimitMb: context.run.memoryLimitMb };
}

export class LifecycleError extends Error {
  constructor(readonly code: 'cache_state_not_exercised' | 'unexpected_queued_work' | 'unsupported_pipeline' |
    'profile_mismatch' | 'operation_failed' | 'cleanup_failed') { super(code); this.name = 'LifecycleError'; }
}
