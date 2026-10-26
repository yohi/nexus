import { z } from 'zod';
import { TOOL_DEFINITIONS } from '../../../src/server/tools/registry/definitions.js';
import { toZodV3Shape } from '../../../src/server/tools/registry/adapters/v1-adapter.js';
import type { ToolHandler } from '../../../src/server/tools/types.js';
import { runtimeStateRevision } from '../../../src/observability/runtime-observer.js';
import type { FixtureManifest, QueryCase, RetrievalValidation, RunOptions } from './contracts.js';
import { codeSchema, durationSchema, failureSchema, validRetrievalValidationSchema } from './contracts.js';
import type { FixturePathNormalizer } from './logical-path.js';
import type { OutcomeCollector } from './outcomes.js';
import { validateHandlerResponse } from './validate-response.js';
import { RetrievalError } from './validation-context.js';
import { executableQueryCase } from './validation-symbols.js';
import { systemClock } from './clock.js';
import type { Clock } from './clock.js';
import { grepExecutionSchema, queryMetadataSchema } from './execution-contracts.js';
import type { GrepExecution } from './execution-contracts.js';

export interface RetrievalRunOptions {
  readonly run: RunOptions;
  readonly manifest: FixtureManifest;
  readonly signal: AbortSignal;
  readonly mode: 'warm' | 'first_call';
  readonly clock?: Clock;
}
export type RetrievalHandlers = Readonly<Partial<Record<QueryCase['tool'], ToolHandler>>>;
const retrievalFactsSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('valid'), boundary: z.literal('handler-internal'), id: z.string(),
    rawSamples: z.array(durationSchema).min(1).readonly(), warmupCalls: z.number().int().nonnegative(),
    measuredCalls: z.number().int().positive(), validation: validRetrievalValidationSchema,
    queryMetadata: queryMetadataSchema, grepExecution: z.array(grepExecutionSchema).readonly() }).strict(),
  z.object({ status: z.literal('invalid'), boundary: z.literal('handler-internal'), id: z.string(),
    candidateSamples: z.array(durationSchema).readonly(), warmupCalls: z.number().int().nonnegative(),
    measuredCalls: z.number().int().nonnegative(), elapsedMs: durationSchema,
    failures: z.array(failureSchema).min(1).readonly(), code: codeSchema,
    queryMetadata: queryMetadataSchema, grepExecution: z.array(grepExecutionSchema).readonly() }).strict(),
]).readonly();
export type RetrievalFacts = z.infer<typeof retrievalFactsSchema>;
let sampleSequence = 0;

export function validateArguments(tool: QueryCase['tool'], args: unknown): Record<string, unknown> {
  const definition = TOOL_DEFINITIONS.find((item) => item.name === tool);
  if (definition === undefined) throw new RetrievalError('invalid_arguments');
  const result = z.object(toZodV3Shape(definition.input)).strict().safeParse(args);
  if (!result.success) throw new RetrievalError('invalid_arguments');
  return result.data;
}

export async function runRetrievalCase(handlers: RetrievalHandlers, queryCase: QueryCase, collector: OutcomeCollector,
  options: Readonly<RetrievalRunOptions>, normalizePath: FixturePathNormalizer): Promise<RetrievalFacts> {
  const clock = options.clock ?? systemClock;
  const caseStarted = clock.now();
  const samples: number[] = [];
  const grepExecution: GrepExecution[] = [];
  const queryMetadata = queryMetadataSchema.parse({ tool: queryCase.tool, requestedMaximum: queryCase.requestedMaximum, limits: queryCase.limits });
  let warmupCalls = 0;
  let measuring = false;
  let pendingDuration: number | undefined;
  const invalid = (failures: Extract<RetrievalValidation, { status: 'invalid' }>['failures']) => retrievalFactsSchema.parse({
    status: 'invalid', boundary: 'handler-internal', id: queryCase.id, candidateSamples: samples,
    warmupCalls, measuredCalls: samples.length, elapsedMs: clock.now() - caseStarted, failures,
    code: failures[0]?.code ?? 'malformed_response',
    queryMetadata, grepExecution,
  });
  try {
    const query = executableQueryCase(queryCase, options.manifest);
    const args = validateArguments(query.tool, query.args);
    const handler = handlers[query.tool];
    if (handler === undefined) throw new RetrievalError('missing_handler');
    const warmups = options.mode === 'first_call' ? 0 : 5;
    const count = options.mode === 'first_call' ? 1 : options.run.sampleMode === 'full' ? 100 : 3;
    let validation: z.infer<typeof validRetrievalValidationSchema> | undefined;
    for (let index = 0; index < warmups + count; index += 1) {
      measuring = index >= warmups;
      pendingDuration = undefined;
      options.signal.throwIfAborted();
      const requestId = `retrieval-${++sampleSequence}`;
      try {
        const sample = await collector.run(requestId, async () => {
          if (collector.hasRuntimeFailure) throw new RetrievalError('execution_failed');
          const revision = runtimeStateRevision(collector);
          const started = clock.now();
          let envelope: unknown;
          try { envelope = await handler(args, { signal: options.signal }); }
          catch {
            pendingDuration = durationSchema.parse(clock.now() - started);
            throw new RetrievalError('handler_exception');
          }
          const ended = clock.now();
          const duration = durationSchema.parse(ended - started);
          pendingDuration = duration;
          const execution = await collector.seal(requestId);
          const result = await validateHandlerResponse(query, envelope,
            { execution, manifest: options.manifest, signal: options.signal }, normalizePath);
          if (collector.hasRuntimeFailure || revision !== runtimeStateRevision(collector)) throw new RetrievalError('runtime_mutation');
          return { duration, validation: result, grepExecution: execution.grepExecution };
        });
        if (measuring) { samples.push(sample.duration); grepExecution.push(...sample.grepExecution); }
        pendingDuration = undefined;
        if (sample.validation.status === 'invalid') return invalid(sample.validation.failures);
        validation = sample.validation;
        if (!measuring) warmupCalls += 1;
      } finally { collector.release(requestId); }
    }
    if (validation === undefined) throw new RetrievalError('malformed_response');
    options.signal.throwIfAborted();
    return retrievalFactsSchema.parse({ status: 'valid', boundary: 'handler-internal', id: queryCase.id,
      rawSamples: samples, warmupCalls, measuredCalls: samples.length, validation, queryMetadata, grepExecution });
  } catch (error) {
    if (measuring && pendingDuration !== undefined) samples.push(pendingDuration);
    const code = options.signal.aborted ? 'scenario_aborted' : error instanceof RetrievalError ? error.code : 'malformed_response';
    return invalid([{ code, count: 1, examples: [] }]);
  }
}
