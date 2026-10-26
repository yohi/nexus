export type ReadinessFailureCode = 'construction_failed' | 'initialization_failed' | 'indexing_failed' |
  'audit_failed' | 'audit_invalid' | 'probe_failed' | 'probe_invalid' | 'readiness_aborted' |
  'runtime_index_error' | 'runtime_not_settled' | 'dropped_events' | 'runtime_skipped_files' |
  'stale_index_timestamp' | 'concurrent_mutation' | 'cleanup_failed';
export class ReadinessError extends Error {
  constructor(readonly code: ReadinessFailureCode) { super(code); this.name = 'ReadinessError'; }
}
