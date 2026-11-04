import { z } from 'zod';

const GIB = 1_073_741_824;

const processSampleSchema = z.object({
  pid: z.number().int().positive(),
  startTicks: z.string().regex(/^[1-9][0-9]*$/),
  ppid: z.number().int().nonnegative(),
  pgid: z.number().int().nonnegative(),
  sid: z.number().int().nonnegative(),
  cpuTicks: z.number().int().nonnegative(),
  uid: z.number().int().nonnegative(),
  executable: z.string().min(1).max(256),
  cgroupClass: z.enum(['user_session', 'service', 'root', 'unknown']),
}).strict();
const pressureSchema = z.object({
  someAvg60: z.number().finite().nonnegative(),
  fullAvg60: z.number().finite().nonnegative(),
}).strict();
const pressureByScopeSchema = z.object({ host: pressureSchema, cgroup: pressureSchema }).strict();
const hostSnapshotSchema = z.object({
  capturedAtUtc: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  monotonicNs: z.string().regex(/^(0|[1-9][0-9]*)$/),
  selfPid: z.number().int().positive(),
  logicalCpuCount: z.number().int().positive(),
  affinityCpuCount: z.number().int().positive(),
  cpusetCpuCount: z.number().int().positive(),
  quotaCpuCapacity: z.number().finite().positive().nullable(),
  aggregateCpuTicks: z.number().int().nonnegative(),
  throttledPeriods: z.number().int().nonnegative(),
  cpuPressure: pressureByScopeSchema,
  memoryPressure: pressureByScopeSchema,
  ioPressure: pressureByScopeSchema,
  memoryAvailableBytes: z.number().int().nonnegative(),
  swapUsedBytes: z.number().int().nonnegative(),
  cgroupMemoryCurrentBytes: z.number().int().nonnegative(),
  cgroupMemoryMaxBytes: z.number().int().positive().nullable(),
  cgroupMemoryHighBytes: z.number().int().positive().nullable(),
  memoryEvents: z.object({
    high: z.number().int().nonnegative(),
    max: z.number().int().nonnegative(),
    oom: z.number().int().nonnegative(),
    oomKill: z.number().int().nonnegative(),
  }).strict(),
  cgroupSwapCurrentBytes: z.number().int().nonnegative(),
  ioReadBytes: z.number().int().nonnegative(),
  ioWriteBytes: z.number().int().nonnegative(),
  scratchFreeBytes: z.number().int().nonnegative(),
  processEnumerationComplete: z.boolean(),
  processes: z.array(processSampleSchema),
}).strict();

const workloadSchema = z.object({
  recipeVersion: z.literal('retrieval-performance-v1'),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.literal(100),
  utf8Bytes: z.literal(111_740),
  declarations: z.literal(1_000),
  imports: z.literal(100),
  legacyRows: z.literal(1_100),
  structuredRows: z.literal(1_000),
  provider: z.literal('test'),
  model: z.literal('nexus-synthetic-sha256-v1'),
  dimensions: z.literal(128),
  maxChunkChars: z.literal(4096),
  storage: z.object({
    metadata: z.literal('sqlite'),
    vectors: z.literal('lancedb'),
    isolation: z.literal('owned_state_outside_source'),
    locations: z.literal('redacted'),
  }).strict(),
}).passthrough();
const smallReportSchema = z.object({
  status: z.literal('complete'),
  options: z.object({ profile: z.literal('small') }).passthrough(),
  workload: workloadSchema,
  scenarios: z.array(z.unknown()),
}).passthrough();
const coldScenarioSchema = z.object({
  id: z.literal('cold_initial_index'),
  status: z.literal('valid'),
  fixtureDigest: z.string().regex(/^[a-f0-9]{64}$/),
  artifactBytes: z.object({ totalBytes: z.number().int().positive() }).passthrough(),
}).passthrough();
const mediumFixtureSizeSchema = z.object({
  files: z.literal(1_000),
  utf8Bytes: z.literal(1_084_640),
  declarations: z.literal(10_000),
  imports: z.literal(1_000),
  legacyRows: z.literal(11_000),
  structuredRows: z.literal(10_000),
}).strict();
export const passedHostGateResultSchema = z.object({
  status: z.literal('PASS'),
  snapshotCount: z.literal(3),
  reasonCodes: z.array(z.string()).length(0),
  requiredScratchBytes: z.number().int().positive().refine(Number.isSafeInteger),
  scratchFreeBytes: z.number().int().nonnegative().refine(Number.isSafeInteger),
  effectiveCpuCapacity: z.number().finite().min(4),
}).strict().refine((result) => result.scratchFreeBytes >= result.requiredScratchBytes);

export function indeterminate(reasonCodes, missingInputs = []) {
  return Object.freeze({
    status: 'HOST_GATE_INDETERMINATE',
    reasonCodes: Object.freeze([...reasonCodes]),
    missingInputs: Object.freeze([...missingInputs]),
  });
}

function parseSmallArtifactBytes(reportValue) {
  const report = smallReportSchema.safeParse(reportValue);
  if (!report.success) return undefined;
  const coldScenarios = report.data.scenarios
    .map((scenario) => coldScenarioSchema.safeParse(scenario))
    .filter((scenario) => scenario.success && scenario.data.fixtureDigest === report.data.workload.digest);
  if (coldScenarios.length === 0) return undefined;
  return Math.max(...coldScenarios.map((scenario) => scenario.data.artifactBytes.totalBytes));
}

function calculateScratchRequirement(artifactBytes, smallWorkload, mediumSize) {
  const ratios = [
    mediumSize.files / smallWorkload.files,
    mediumSize.utf8Bytes / smallWorkload.utf8Bytes,
    mediumSize.declarations / smallWorkload.declarations,
    mediumSize.imports / smallWorkload.imports,
    mediumSize.legacyRows / smallWorkload.legacyRows,
    mediumSize.structuredRows / smallWorkload.structuredRows,
  ];
  if (!ratios.every((ratio) => Number.isFinite(ratio) && ratio > 0)) return undefined;
  const estimate = mediumSize.utf8Bytes + Math.ceil(artifactBytes * Math.max(...ratios));
  const requiredBytes = 2 * estimate + GIB;
  return Number.isSafeInteger(requiredBytes) ? requiredBytes : undefined;
}

export function parseHostGateInputs(snapshotsValue, smallReportValue, mediumFixtureSizeValue) {
  const snapshots = z.array(hostSnapshotSchema).safeParse(snapshotsValue);
  if (!snapshots.success) return { ready: false, result: indeterminate(['telemetry_missing'], snapshots.error.issues.map((issue) => issue.path.join('.'))) };
  const smallReport = smallReportSchema.safeParse(smallReportValue);
  if (!smallReport.success) return { ready: false, result: indeterminate(['small_artifact_invalid'], ['small_report']) };
  const mediumSize = mediumFixtureSizeSchema.safeParse(mediumFixtureSizeValue);
  if (!mediumSize.success) return { ready: false, result: indeterminate(['medium_fixture_size_invalid'], ['medium_fixture_size']) };
  const artifactBytes = parseSmallArtifactBytes(smallReportValue);
  if (artifactBytes === undefined) {
    return { ready: false, result: indeterminate(['small_artifact_incompatible'], ['cold_initial_index.artifactBytes']) };
  }
  const scratchBytes = calculateScratchRequirement(artifactBytes, smallReport.data.workload, mediumSize.data);
  if (scratchBytes === undefined) return { ready: false, result: indeterminate(['scratch_estimate_unavailable'], ['workload_dimensions']) };
  return {
    ready: true,
    snapshots: snapshots.data,
    smallWorkload: smallReport.data.workload,
    mediumFixtureSize: mediumSize.data,
    requiredScratchBytes: scratchBytes,
  };
}
