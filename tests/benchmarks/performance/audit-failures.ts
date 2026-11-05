import type { AuditResult, FixtureManifest } from './contracts.js';

export type AuditCounts = { -readonly [Key in keyof AuditResult['counts']]: AuditResult['counts'][Key] };
export interface AuditProgress {
  readonly signal: AbortSignal;
  readonly counts: AuditCounts;
  readonly failures: AuditFailures;
}
export function createAuditCounts(): AuditCounts {
  return { legacyRows: 0, legacyFiles: 0, structuredRows: 0, structuredFiles: 0,
    declarations: 0, imports: 0, legacyGetStats: 0 };
}
export type AuditFailureCode = 'audit_aborted' | 'vector_read_error' | 'catalog_read_error' |
  'metadata_read_error' | 'concurrent_mutation' | 'runtime_not_settled' | 'index_stats_missing' |
  'persisted_index_error' | 'legacy_stats_mismatch' | 'catalog_counts_mismatch' | 'catalog_state_invalid' |
  'unexpected_active_file' | 'missing_vector_row' | 'duplicate_vector_row' | 'vector_hash_mismatch' |
  'vector_span_mismatch' | 'vector_identity_mismatch' | 'vector_generation_mismatch' |
  'catalog_generation_mismatch' | 'catalog_declaration_mismatch' | 'catalog_import_mismatch' |
  'source_file_mismatch' | 'dlq_not_empty';

export class AuditFailures {
  private readonly paths: ReadonlySet<string>;
  private readonly failures = new Map<AuditFailureCode, { count: number; examples: string[] }>();
  constructor(manifest: FixtureManifest) { this.paths = new Set(manifest.files.map((file) => file.path)); }
  get invalid(): boolean { return this.failures.size > 0; }

  add(code: AuditFailureCode, count = 1, path?: string): void {
    if (count === 0) return;
    const current = this.failures.get(code) ?? { count: 0, examples: [] };
    current.count += count;
    if (path !== undefined && this.paths.has(path) && current.examples.length < 20) current.examples.push(path);
    this.failures.set(code, current);
  }

  records() {
    return [...this.failures].map(([code, value]) => ({ code, count: value.count, examples: value.examples }));
  }
}
