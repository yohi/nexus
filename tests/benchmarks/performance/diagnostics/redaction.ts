const counterIds = new Set([
  'fixture.files_attempted', 'fixture.files_written_succeeded', 'fixture.recipe_descriptions_succeeded', 'fixture.bytes_written',
  'preflight.raw_text_inputs', 'preflight.unique_text_inputs', 'preflight.vectors_checked', 'preflight.vectors_locally_validated',
  'scan.entries_seen', 'scan.entries_ignored', 'scan.entries_eligible', 'scan.files_expected', 'scan.files_emitted', 'scan.directories_visited',
  'index.window_files', 'index.legacy_parser_attempted', 'index.legacy_parser_succeeded', 'index.legacy_parser_failed',
  'index.legacy_fixedline_fallback_attempted', 'index.legacy_fixedline_fallback_succeeded',
  'index.legacy_fallback_no_plugin', 'index.legacy_fallback_empty_parse', 'index.legacy_fallback_parser_error',
  'index.structured_parse_attempted', 'index.structured_parse_ok', 'index.structured_parse_degraded', 'index.structured_parse_failed',
  'index.legacy_chunk_files_attempted', 'index.structured_chunk_files_attempted',
  'index.legacy_chunk_files_succeeded', 'index.structured_chunk_files_succeeded',
  'index.legacy_chunks_emitted', 'index.structured_chunks_emitted',
  'index.embedding_cache_l1_hits', 'index.embedding_cache_l2_hits', 'index.embedding_cache_misses',
  'index.embedding_batches_attempted', 'index.embedding_batches_succeeded', 'index.embedding_batches_failed',
  'index.embedding_inputs_submitted', 'index.embedding_vectors_returned', 'index.embedding_inputs_completed',
  'index.legacy_vector_rows_attempted', 'index.structured_vector_rows_attempted',
  'index.legacy_vector_rows_write_succeeded', 'index.structured_vector_rows_write_succeeded',
  'index.structured_vector_rows_activated', 'index.sqlite_generation_stage_attempted', 'index.sqlite_generation_stage_succeeded',
  'index.sqlite_declaration_rows_attempted', 'index.sqlite_import_rows_attempted',
  'index.sqlite_declaration_rows_committed', 'index.sqlite_import_rows_committed',
  'index.pipeline_files_finalized', 'index.pipeline_files_indexed_succeeded', 'index.pipeline_files_skipped_or_dlq',
  'index.full_rebuild_retained_files', 'index.retained_chunks', 'index.retained_vectors',
  'settlement.queue_pending', 'settlement.drain_inflight', 'settlement.postscan_pending', 'settlement.dropped_events',
  'audit.rows_seen', 'audit.catalog_files_attempted', 'audit.rows_verified', 'audit.catalog_files_verified',
  'audit.declarations_verified', 'audit.imports_verified', 'audit.validation_failures',
]);

export function isAllowedCounterId(value: string): boolean {
  return counterIds.has(value);
}

const units = new Set([
  'files', 'bytes', 'occurrences', 'inputs', 'vectors', 'entries', 'directories', 'calls',
  'chunks', 'batches', 'items', 'rows', 'records', 'events', 'failures',
]);

export function isAllowedUnit(value: string): boolean {
  return units.has(value);
}

const workKinds = new Set(['legacy', 'structured', 'scan', 'fixture', 'embedding', 'audit', 'probe']);

export function isAllowedWorkKind(value: string): boolean {
  return workKinds.has(value);
}
