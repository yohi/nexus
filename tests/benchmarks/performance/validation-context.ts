import type { FixtureManifest, QueryCase } from './contracts.js';
import type { SealedOutcome } from './outcomes.js';
import type { RuntimeWorkKind } from '../../../src/observability/runtime-observer.js';

export interface RetrievalOutcomeContext {
  readonly execution: SealedOutcome;
  readonly manifest: FixtureManifest;
  readonly signal: AbortSignal;
}
export class RetrievalError extends Error {
  constructor(readonly code: 'invalid_arguments' | 'missing_handler' | 'handler_exception' | 'malformed_envelope' |
    'envelope_error' | 'serialization_error' | 'execution_failed' | 'missing_branch_outcome' | 'missing_grep_evidence' |
    'grep_multiset_mismatch' | 'malformed_response' | 'invalid_result_path' | 'unknown_fixture_result' |
    'duplicate_result' | 'effective_limit_mismatch' | 'structured_not_success' | 'structured_source_mismatch' |
    'structured_budget_mismatch' | 'scenario_aborted' | 'runtime_mutation') { super(code); this.name = 'RetrievalError'; }
}

export function requireExecution(query: QueryCase, outcomes: RetrievalOutcomeContext): void {
  outcomes.signal.throwIfAborted();
  if (outcomes.execution.status !== 'valid') throw new RetrievalError('execution_failed');
  const required: readonly RuntimeWorkKind[] = (() => {
    switch (query.tool) {
      case 'grep_search': return ['grep', 'grep_spawn'];
      case 'semantic_search': return ['semantic'];
      case 'hybrid_search': return ['hybrid', 'semantic_branch', 'grep_branch', 'semantic', 'grep', 'grep_spawn'];
      case 'get_file_outline': case 'get_symbol_source': case 'get_symbol_context': return ['initialization'];
    }
  })();
  if (required.some((kind) => !outcomes.execution.workKinds.includes(kind))) throw new RetrievalError('missing_branch_outcome');
}
