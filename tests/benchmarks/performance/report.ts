import type { z } from 'zod';
import { reportSchema, scenarioRecordSchema } from './contracts.js';
import type { environmentSchema, failureSchema } from './contracts.js';
import type { PerformanceReport, RunOptions, ScenarioRecord } from './contracts.js';
import { summarizeLifecycle, summarizeWarm } from './statistics.js';
import type { WorkloadSummary } from './workload.js';
import { profiles } from './profiles.js';

export interface ReportMetadata {
  readonly runId: string;
  readonly fixtureDigest: string | null;
  readonly options: RunOptions | null;
  readonly environment: z.infer<typeof environmentSchema>;
  readonly workload?: WorkloadSummary | null;
  readonly expectedScenarioIds?: readonly string[];
  readonly diagnostics?: readonly z.infer<typeof failureSchema>[];
  readonly warnings?: readonly string[];
}
export class ReportError extends Error {
  readonly code = 'invalid_report_data';
  constructor() { super('invalid_report_data'); this.name = 'ReportError'; }
}

export function buildReport(records: readonly unknown[], metadata: Readonly<ReportMetadata>): PerformanceReport {
  try {
    const scenarios = records.map((record) => scenarioRecordSchema.parse(record));
    const warnings = new Set(metadata.warnings ?? []);
    const expectedIds = [...new Set(metadata.expectedScenarioIds ?? scenarios.map((record) => record.id))];
    const actualIds = new Set(scenarios.map((record) => record.id));
    const missingIds = expectedIds.filter((id) => !actualIds.has(id));
    const valid = scenarios.filter((record) => record.status === 'valid');
    if (metadata.workload !== null && metadata.workload !== undefined && metadata.options !== null) {
      const workload = metadata.workload;
      const scale = profiles[metadata.options.profile];
      if (workload.files !== scale.files || workload.declarations !== scale.files * scale.declarationsPerFile ||
        workload.imports !== scale.files || workload.legacyRows !== workload.declarations + workload.imports ||
        workload.structuredRows !== workload.declarations) throw new ReportError();
      for (const record of valid) {
        const counts = record.audit.counts;
        if (counts.legacyRows !== workload.legacyRows || counts.legacyFiles !== workload.files ||
          counts.structuredRows !== workload.structuredRows || counts.structuredFiles !== workload.files ||
          counts.declarations !== workload.declarations || counts.imports !== workload.imports ||
          counts.legacyGetStats !== workload.legacyRows) throw new ReportError();
      }
    }
    const invalidRecords = scenarios.filter((record) => record.status === 'invalid').length;
    const skippedRecords = scenarios.filter((record) => record.status === 'skipped').length;
    const blockedRecords = scenarios.filter((record) => record.status === 'blocked').length;
    let incomplete = metadata.options === null || metadata.fixtureDigest === null || scenarios.length === 0 || missingIds.length > 0 ||
      invalidRecords > 0 || skippedRecords > 0 || blockedRecords > 0 || (metadata.diagnostics?.length ?? 0) > 0;
    if (metadata.workload === null || metadata.workload === undefined) { incomplete = true; warnings.add('missing_workload_identity'); }
    else if (metadata.workload.digest !== metadata.fixtureDigest) throw new ReportError();
    const summaries: PerformanceReport['summaries'][number][] = [];
    if (metadata.options?.revision.commit === null) { incomplete = true; warnings.add('source_revision_unavailable'); }
    if (metadata.options?.sampleMode === 'smoke') { warnings.add('smoke_not_baseline'); warnings.add('smoke_no_tail_latency'); }
    if (missingIds.length > 0) warnings.add('missing_scenarios');
    const groups = new Map<string, Extract<ScenarioRecord, { status: 'valid' }>[] >();
    for (const record of valid) {
      const key = `${record.sampleKind}:${record.id}`;
      const group = groups.get(key) ?? [];
      group.push(record); groups.set(key, group);
    }
    for (const group of groups.values()) {
      const first = group[0];
      if (first === undefined || metadata.options === null) continue;
      const samples = group.flatMap((record) => [...record.rawSamples]);
      const expectedCount = first.sampleKind === 'warm' ? (metadata.options.sampleMode === 'full' ? 100 : 3)
        : metadata.options.sampleMode === 'full' ? 3 : 1;
      if (group.some((record) => record.sampleMode !== metadata.options?.sampleMode) || samples.length !== expectedCount) {
        incomplete = true; warnings.add('incomplete_sample_count'); continue;
      }
      switch (first.sampleKind) {
        case 'warm':
          if (metadata.options.sampleMode === 'full') summaries.push({ kind: 'warm', id: first.id, count: samples.length, ...summarizeWarm(samples) });
          break;
        case 'lifecycle': case 'first_call': summaries.push({ kind: first.sampleKind, id: first.id, ...summarizeLifecycle(samples) }); break;
      }
    }
    return reportSchema.parse({ schemaVersion: 1, recipeVersion: 'retrieval-performance-v1', status: incomplete ? 'incomplete' : 'complete',
      runId: metadata.runId, fixtureDigest: metadata.fixtureDigest, options: metadata.options, environment: metadata.environment,
      workload: metadata.workload ?? null,
      scenarios, summaries, warnings: [...warnings], diagnostics: metadata.diagnostics ?? [],
      coverage: { expectedIds, missingIds, validRecords: valid.length, invalidRecords, skippedRecords, blockedRecords } });
  } catch { throw new ReportError(); }
}
