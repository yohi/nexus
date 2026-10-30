import { z } from 'zod';

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const identifierSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/);
export const operationIdSchema = z.string().regex(/^op_[a-f0-9]{16,64}$/);
export const attemptIdSchema = z.string().regex(/^attempt_[1-9][0-9]{0,15}$/);
const monotonicNsSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const processStartTicksSchema = z.string().regex(/^[1-9][0-9]*$/);
const nonNegativeIntegerSchema = z.number().int().min(0);
const runIdSchema = z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);

export const diagnosticStageIdSchema = z.enum([
  'S00_worker_bootstrap',
  'S01_fixture_generation',
  'S02_workload_preflight',
  'S03_runtime_assembly',
  'S04_runtime_initialization',
  'S05_directory_scan',
  'S06_parse_chunk',
  'S07_embedding_cache',
  'S08_storage_write',
  'S09_index_settlement',
  'S10_manifest_audit',
  'S11_readiness_probe',
  'S12_resource_cleanup',
]);

export const processRoleSchema = z.enum(['vitest_parent', 'vitest_worker', 'unknown_node']);
export const clockDomainSchema = z.enum(['linux_clock_monotonic_ns', 'process_local_monotonic']);
export const diagnosticSpanStatusSchema = z.enum([
  'completed',
  'failed',
  'aborted',
  'timed_out',
  'cancelled_by_supervisor',
]);
export const diagnosticErrorCategorySchema = z.enum([
  'abort_error',
  'cleanup_error',
  'io_error',
  'observer_error',
  'parse_error',
  'process_exit',
  'recorder_error',
  'storage_error',
  'timeout_error',
  'unknown_error',
]);
export const measurementNotCollectedReasonSchema = z.enum([
  'not_requested',
  'not_yet_sampled',
  'not_yet_written',
  'unsupported',
  'permission_denied',
  'process_exited',
  'read_error',
  'clock_unaligned',
  'profile_missing',
]);
export const stateIntegritySchema = z.enum([
  'verified',
  'unknown',
  'rollback_incomplete',
  'backup_cleanup_failed',
]);
export const traceIncompleteReasonSchema = z.enum([
  'clock_failure',
  'clock_regressed',
  'clock_unavailable',
  'counter_contract_violation',
  'event_validation_failed',
  'progress_outside_stage',
  'sequence_exhausted',
  'event_cap_exceeded',
  'byte_cap_exceeded',
  'write_error',
  'record_after_finalization',
  'finalization_with_active_spans',
  'finalization_unverified',
  'missing_profile_count_overflow',
  'observer_failure',
  'cleanup_failure',
]);

const diagnosticTraceIdentityShape = {
  runId: runIdSchema,
  jobId: z.literal('cold_initial_index'),
  recipeDigest: digestSchema,
  sourceFingerprint: digestSchema,
  pid: z.number().int().positive(),
  processStartTicks: processStartTicksSchema,
  ppid: z.number().int().min(0),
  processRole: processRoleSchema,
  clockDomain: clockDomainSchema,
};

export const diagnosticTraceIdentitySchema = z.object(diagnosticTraceIdentityShape).strict().readonly();

export const counterSemanticsSchema = z.enum([
  'visited',
  'attempted',
  'completed',
  'succeeded',
  'returned',
  'failed',
  'verified',
  'committed',
  'classified',
  'pending',
  'retained',
]);

export const progressInputSchema = z.object({
  counterId: identifierSchema,
  value: nonNegativeIntegerSchema,
  unit: identifierSchema,
  semantics: counterSemanticsSchema,
  expected: nonNegativeIntegerSchema.optional(),
  sampleReason: z.enum(['threshold', 'interval', 'stage_end']),
}).strict().readonly();

const eventEnvelope = {
  schemaVersion: z.literal(1),
  ...diagnosticTraceIdentityShape,
  seq: z.number().int().positive(),
  monotonicNs: monotonicNsSchema,
};

const preloadStartedEventSchema = z.object({
  ...eventEnvelope,
  event: z.literal('preload_started'),
}).strict().readonly();

const spanIdentity = {
  spanId: identifierSchema,
  parentSpanId: identifierSchema.optional(),
  operationId: operationIdSchema,
  attemptId: attemptIdSchema,
  stageId: diagnosticStageIdSchema,
};

const spanStartedEventSchema = z.object({
  ...eventEnvelope,
  event: z.literal('span_started'),
  ...spanIdentity,
  workKind: identifierSchema.optional(),
}).strict().readonly();

const spanFinishedEventSchema = z.object({
  ...eventEnvelope,
  event: z.literal('span_finished'),
  ...spanIdentity,
  status: diagnosticSpanStatusSchema,
  endMonotonicNs: monotonicNsSchema,
  elapsedNs: monotonicNsSchema,
  errorCategory: diagnosticErrorCategorySchema.optional(),
  stateIntegrity: stateIntegritySchema.optional(),
}).strict().readonly();

export const progressEventSchema = z.object({
  ...eventEnvelope,
  event: z.literal('progress'),
  spanId: identifierSchema,
  operationId: operationIdSchema,
  attemptId: attemptIdSchema,
  counterId: identifierSchema,
  value: nonNegativeIntegerSchema,
  unit: identifierSchema,
  expected: nonNegativeIntegerSchema.optional(),
  semantics: counterSemanticsSchema,
  sampleReason: z.enum(['threshold', 'interval', 'stage_end']),
}).strict().readonly();

const measuredValueSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('observed'), value: z.number().gte(0) }).strict().readonly(),
  z.object({ status: z.literal('not_collected'), reasonCode: measurementNotCollectedReasonSchema }).strict().readonly(),
]);

const resourceSampleEventSchema = z.object({
  ...eventEnvelope,
  event: z.literal('resource_sample'),
  sampleScope: z.enum(['worker_process', 'process_group', 'cgroup', 'host']),
  heapUsedBytes: measuredValueSchema,
  heapTotalBytes: measuredValueSchema,
  rssBytes: measuredValueSchema,
  externalBytes: measuredValueSchema,
  arrayBuffersBytes: measuredValueSchema,
  cpuUserUs: measuredValueSchema,
  cpuSystemUs: measuredValueSchema,
  ioReadBytes: measuredValueSchema,
  ioWriteBytes: measuredValueSchema,
  eventLoopDelayMaxNs: measuredValueSchema,
  cgroupMemoryCurrentBytes: measuredValueSchema,
  cgroupSwapCurrentBytes: measuredValueSchema,
  cpuPressureSomeAvg60: measuredValueSchema,
  ioPressureSomeAvg60: measuredValueSchema,
  memoryPressureSomeAvg60: measuredValueSchema,
  oomKillDelta: measuredValueSchema,
}).strict().readonly();

const profileSegmentStartedEventSchema = z.object({
  ...eventEnvelope,
  event: z.literal('profile_segment_started'),
  segmentId: identifierSchema,
  sampleCount: z.object({ status: z.literal('not_collected'), reasonCode: z.literal('not_yet_sampled') }).strict().readonly(),
  fileBytes: z.object({ status: z.literal('not_collected'), reasonCode: z.literal('not_yet_written') }).strict().readonly(),
}).strict().readonly();

const profileSegmentStartFailedEventSchema = z.object({
  ...eventEnvelope,
  event: z.literal('profile_segment_start_failed'),
  segmentId: identifierSchema,
  sampleCount: z.object({ status: z.literal('not_collected'), reasonCode: z.literal('profile_missing') }).strict().readonly(),
  fileBytes: z.object({ status: z.literal('not_collected'), reasonCode: z.literal('not_yet_written') }).strict().readonly(),
  errorCategory: diagnosticErrorCategorySchema,
}).strict().readonly();

const profileSegmentStopFailedEventSchema = z.object({
  ...eventEnvelope,
  event: z.literal('profile_segment_stop_failed'),
  segmentId: identifierSchema,
  sampleCount: z.object({ status: z.literal('not_collected'), reasonCode: z.literal('profile_missing') }).strict().readonly(),
  fileBytes: z.object({ status: z.literal('not_collected'), reasonCode: z.literal('not_yet_written') }).strict().readonly(),
  errorCategory: diagnosticErrorCategorySchema,
}).strict().readonly();

const profileSegmentStopRequestedEventSchema = z.object({
  ...eventEnvelope,
  event: z.literal('profile_segment_stop_requested'),
  segmentId: identifierSchema,
  sampleCount: z.object({ status: z.literal('not_collected'), reasonCode: z.literal('not_yet_sampled') }).strict().readonly(),
  fileBytes: z.object({ status: z.literal('not_collected'), reasonCode: z.literal('not_yet_written') }).strict().readonly(),
}).strict().readonly();

const profileSegmentStoppedEventSchema = z.object({
  ...eventEnvelope,
  event: z.literal('profile_segment_stopped'),
  segmentId: identifierSchema,
  sampleCount: z.object({ status: z.literal('observed'), value: nonNegativeIntegerSchema }).strict().readonly(),
  fileBytes: z.object({ status: z.literal('not_collected'), reasonCode: z.literal('not_yet_written') }).strict().readonly(),
}).strict().readonly();

const profileWriteCompletedEventSchema = z.object({
  ...eventEnvelope,
  event: z.literal('profile_write_completed'),
  segmentId: identifierSchema,
  sampleCount: z.object({ status: z.literal('observed'), value: nonNegativeIntegerSchema }).strict().readonly(),
  fileBytes: z.object({ status: z.literal('observed'), value: nonNegativeIntegerSchema }).strict().readonly(),
}).strict().readonly();

const profileWriteFailedEventSchema = z.object({
  ...eventEnvelope,
  event: z.literal('profile_write_failed'),
  segmentId: identifierSchema,
  sampleCount: measuredValueSchema,
  fileBytes: z.object({ status: z.literal('not_collected'), reasonCode: z.literal('profile_missing') }).strict().readonly(),
  errorCategory: diagnosticErrorCategorySchema,
}).strict().readonly();

const traceStatusEventSchema = z.object({
  ...eventEnvelope,
  event: z.literal('trace_status'),
  finalizationState: z.literal('provisional'),
  traceIncomplete: z.boolean(),
  traceTruncated: z.boolean(),
  samplingIncomplete: z.boolean(),
  diagnosticAdmissible: z.boolean(),
  eventsDropped: nonNegativeIntegerSchema,
  bytesDropped: nonNegativeIntegerSchema,
  profilesMissing: nonNegativeIntegerSchema,
  profilesMissingExact: z.boolean(),
  stateIntegrity: stateIntegritySchema,
  reasonCode: traceIncompleteReasonSchema.optional(),
  reasonCodes: z.array(traceIncompleteReasonSchema).max(traceIncompleteReasonSchema.options.length).readonly(),
}).strict().readonly();

export const diagnosticTraceEventSchema = z.discriminatedUnion('event', [
  preloadStartedEventSchema,
  spanStartedEventSchema,
  spanFinishedEventSchema,
  progressEventSchema,
  resourceSampleEventSchema,
  profileSegmentStartedEventSchema,
  profileSegmentStartFailedEventSchema,
  profileSegmentStopFailedEventSchema,
  profileSegmentStopRequestedEventSchema,
  profileSegmentStoppedEventSchema,
  profileWriteCompletedEventSchema,
  profileWriteFailedEventSchema,
  traceStatusEventSchema,
]).readonly();

export type DiagnosticTraceIdentity = z.infer<typeof diagnosticTraceIdentitySchema>;
export type DiagnosticStageId = z.infer<typeof diagnosticStageIdSchema>;
export type DiagnosticSpanStatus = z.infer<typeof diagnosticSpanStatusSchema>;
export type DiagnosticErrorCategory = z.infer<typeof diagnosticErrorCategorySchema>;
export type DiagnosticStateIntegrity = z.infer<typeof stateIntegritySchema>;
export type MeasurementNotCollectedReason = z.infer<typeof measurementNotCollectedReasonSchema>;
export type TraceIncompleteReason = z.infer<typeof traceIncompleteReasonSchema>;
export type CounterSemantics = z.infer<typeof counterSemanticsSchema>;
export type DiagnosticTraceEvent = z.infer<typeof diagnosticTraceEventSchema>;

export type StageInput = Readonly<{
  stageId: DiagnosticStageId;
  operationId: string;
  attemptId: string;
  workKind?: string;
}>;

export type ProgressInput = z.infer<typeof progressInputSchema>;

export type TraceClock = Readonly<{ nowNs: () => bigint }>;

export type TraceSnapshot = Readonly<{
  events: readonly DiagnosticTraceEvent[];
  traceIncomplete: boolean;
  incompleteReasons: readonly TraceIncompleteReason[];
  traceTruncated: boolean;
  eventsDropped: number;
  bytesDropped: number;
}>;
