import { z } from 'zod';
import type { RuntimeAssembly } from '../../../src/server/runtime/assembly-types.js';
import { buildToolHandlers } from '../../../src/server/tools/tool-support.js';
import type { QueryCase } from './contracts.js';
import { durationSchema, failureSchema, resourcesSchema, validAuditResultSchema, validRetrievalValidationSchema } from './contracts.js';
import { captureReadiness, validReadinessRecordSchema } from './readiness.js';
import { OutcomeCollector } from './outcomes.js';
import type { RuntimeFactory } from './runtime.js';
import { runRetrievalCase } from './retrieval.js';
import type { RetrievalRunOptions } from './retrieval.js';
import type { FixturePathNormalizer } from './logical-path.js';
import { captureNodeResources, systemClock } from './clock.js';
import { RetrievalError } from './validation-context.js';
import { grepExecutionSchema, queryMetadataSchema } from './execution-contracts.js';
import type { GrepExecution } from './execution-contracts.js';

const firstCallFactsSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('valid'), id: z.string(), boundary: z.literal('handler-internal'),
    rawSamples: z.array(durationSchema).min(1).readonly(), warmupCalls: z.literal(0),
    measuredCalls: z.number().int().positive(), reopenedRuntimes: z.number().int().positive(),
    readiness: z.array(validReadinessRecordSchema).min(1).readonly(), audit: validAuditResultSchema,
    validation: validRetrievalValidationSchema, resources: resourcesSchema,
    queryMetadata: queryMetadataSchema, grepExecution: z.array(grepExecutionSchema).readonly() }).strict(),
  z.object({ status: z.literal('invalid'), id: z.string(), boundary: z.literal('handler-internal'),
    candidateSamples: z.array(durationSchema).readonly(), failures: z.array(failureSchema).min(1).readonly(), elapsedMs: durationSchema,
    queryMetadata: queryMetadataSchema, grepExecution: z.array(grepExecutionSchema).readonly() }).strict(),
]).readonly();
export type FirstCallFacts = z.infer<typeof firstCallFactsSchema>;

export async function runFirstCallGroup(createFactory: (collector: OutcomeCollector) => RuntimeFactory,
  query: QueryCase, options: Readonly<Omit<RetrievalRunOptions, 'mode'>>, normalize: FixturePathNormalizer): Promise<FirstCallFacts> {
  const clock = options.clock ?? systemClock;
  const started = clock.now();
  const cpu = process.cpuUsage();
  const samples: number[] = [];
  const grepExecution: GrepExecution[] = [];
  const queryMetadata = queryMetadataSchema.parse({ tool: query.tool, requestedMaximum: query.requestedMaximum, limits: query.limits });
  const readiness: z.infer<typeof validReadinessRecordSchema>[] = [];
  let validation: z.infer<typeof validRetrievalValidationSchema> | undefined;
  let failures: readonly z.infer<typeof failureSchema>[] | undefined;
  try {
    const count = options.run.sampleMode === 'full' ? 3 : 1;
    for (let run = 0; run < count; run += 1) {
      options.signal.throwIfAborted();
      const collector = new OutcomeCollector(options.signal);
      let assembly: RuntimeAssembly | undefined;
      try {
        const factory = createFactory(collector);
        const ready = await captureReadiness(factory, collector, options.manifest, clock, options.signal);
        if (ready.status !== 'valid') { failures = ready.record.failures; throw new RetrievalError('execution_failed'); }
        assembly = ready.assembly;
        const handlers = buildToolHandlers(assembly.options, assembly.runtime.initialize.bind(assembly.runtime));
        const measured = await runRetrievalCase(handlers, query, collector, { ...options, mode: 'first_call' }, normalize);
        if (measured.status !== 'valid') {
          samples.push(...measured.candidateSamples); failures = measured.failures; throw new RetrievalError('execution_failed');
        }
        samples.push(...measured.rawSamples);
        grepExecution.push(...measured.grepExecution);
        validation = measured.validation;
        readiness.push(ready.record);
      } finally {
        try { await assembly?.runtime.close(); } finally { collector.releaseAll(); }
      }
      options.signal.throwIfAborted();
    }
    const latest = readiness.at(-1);
    if (latest === undefined || validation === undefined) throw new RetrievalError('malformed_response');
    return firstCallFactsSchema.parse({ status: 'valid', id: query.id, boundary: 'handler-internal', rawSamples: samples,
      warmupCalls: 0, measuredCalls: samples.length, reopenedRuntimes: readiness.length, readiness,
      audit: latest.audit, validation, resources: captureNodeResources(cpu, 'handler_group'), queryMetadata, grepExecution });
  } catch (error) {
    const code = options.signal.aborted ? 'scenario_aborted' : error instanceof RetrievalError ? error.code : 'first_call_failed';
    return firstCallFactsSchema.parse({ status: 'invalid', id: query.id, boundary: 'handler-internal',
      candidateSamples: samples, elapsedMs: clock.now() - started,
      failures: failures ?? [{ code, count: 1, examples: [] }], queryMetadata, grepExecution });
  }
}
