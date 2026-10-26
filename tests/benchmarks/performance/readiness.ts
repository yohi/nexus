import { z } from 'zod';
import type { RuntimeAssembly } from '../../../src/server/runtime/assembly-types.js';
import { auditRuntime } from './audit.js';
import { durationSchema, failureSchema, readinessEndpointsSchema, validReadinessRecordSchema } from './contracts.js';
import type { AuditResult, FixtureManifest } from './contracts.js';
import type { Clock } from './clock.js';
import type { RuntimeFactory } from './runtime.js';
import type { OutcomeCollector } from './outcomes.js';
import { probeReadiness } from './readiness-probe.js';
import { settleReadiness } from './readiness-settlement.js';
import { ReadinessError } from './readiness-error.js';

export { validReadinessRecordSchema } from './contracts.js';
export const readinessRecordSchema = z.discriminatedUnion('status', [
  validReadinessRecordSchema.unwrap(),
  z.object({ status: z.literal('invalid'), phase: z.enum(['construction', 'initialization', 'indexing', 'audit', 'probe']),
    elapsedMs: durationSchema, failures: z.array(failureSchema).readonly(),
    candidateEndpoints: readinessEndpointsSchema.unwrap().partial().readonly().optional() }).strict(),
]).readonly();
type ReadinessRecord = z.infer<typeof readinessRecordSchema>;
export type ReadinessCapture =
  | Readonly<{ status: 'valid'; startedAt: number; requestId: string; assembly: RuntimeAssembly;
      record: Extract<ReadinessRecord, { status: 'valid' }> }>
  | Readonly<{ status: 'invalid'; startedAt: number; requestId: string;
      record: Extract<ReadinessRecord, { status: 'invalid' }> }>;
let captureSequence = 0;

export async function captureReadiness(createRuntime: RuntimeFactory, collector: OutcomeCollector,
  manifest: FixtureManifest, clock: Clock, signal: AbortSignal): Promise<ReadinessCapture> {
  const requestId = `readiness-${++captureSequence}`;
  let assembly: RuntimeAssembly | undefined;
  let phase: 'construction' | 'initialization' | 'indexing' | 'audit' | 'probe' = 'construction';
  let runtimeReady: number | undefined;
  let audit: AuditResult | undefined;
  return collector.run(requestId, async () => {
    const startedAt = clock.now();
    try {
      assembly = await createRuntime(signal);
      phase = 'initialization';
      await assembly.runtime.initialize();
      phase = 'indexing';
      await settleReadiness(assembly, collector, requestId, signal);
      await collector.waitUntil(() => {
        if (collector.hasRuntimeFailure) throw new ReadinessError('indexing_failed');
        return collector.pendingRuntimeMutations === 0;
      }, signal);
      const runtimeEnd = clock.now();
      runtimeReady = runtimeEnd - startedAt;
      const candidateRevision = assembly.diagnostics.stateRevision();
      phase = 'audit';
      audit = await auditRuntime(assembly.diagnostics, manifest, signal);
      const auditEnd = clock.now();
      if (audit.status !== 'valid') throw new ReadinessError('audit_invalid');
      phase = 'probe';
      const probe = await probeReadiness(assembly, manifest, collector, signal);
      const probeEnd = clock.now();
      if (candidateRevision !== assembly.diagnostics.stateRevision() ||
        (await collector.seal(requestId)).status !== 'valid') throw new ReadinessError('concurrent_mutation');
      signal.throwIfAborted();
      const latestIndex = collector.successfulReindexes(requestId).at(-1);
      const indexWall = collector.reindexWallMs(requestId);
      const record = readinessRecordSchema.parse({ status: 'valid', audit, validation: probe.validation,
        cacheAccounting: collector.cacheAccounting(requestId), readinessProbe: probe.info,
        endpoints: { runtime_ready_ms: runtimeReady, audit_validation_ms: auditEnd - runtimeEnd,
          retrieval_probe_ms: probeEnd - auditEnd, audited_ready_ms: probeEnd - startedAt,
          ...(latestIndex === undefined ? {} : { indexing_diagnostic_ms: latestIndex.durationMs }),
          ...(indexWall === undefined ? {} : { indexing_operation_ms: indexWall }) } });
      if (record.status !== 'valid') throw new ReadinessError('probe_invalid');
      return { status: 'valid', startedAt, requestId, assembly, record };
    } catch (error) {
      const code = signal.aborted ? 'readiness_aborted' : error instanceof ReadinessError ? error.code : `${phase}_failed`;
      const failures: z.infer<typeof failureSchema>[] = [{ code, count: 1, examples: [] },
        ...(audit?.status === 'invalid' ? audit.failures : [])];
      try { await assembly?.runtime.close(); }
      catch { failures.push({ code: 'cleanup_failed', count: 1, examples: [] }); }
      const record = readinessRecordSchema.parse({ status: 'invalid', phase, failures,
        elapsedMs: clock.now() - startedAt,
        ...(runtimeReady === undefined ? {} : { candidateEndpoints: { runtime_ready_ms: runtimeReady } }) });
      if (record.status !== 'invalid') throw new ReadinessError('probe_invalid');
      collector.release(requestId);
      return { status: 'invalid', startedAt, requestId, record };
    }
  });
}
