import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performanceSourceMetadata } from './performance-source.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const timeoutMs = 600_000;
const memoryLimitMb = 2_048;
const runIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const digestPattern = /^[a-f0-9]{64}$/;
const recipe = Object.freeze({
  recipeVersion: 'retrieval-performance-v1',
  profile: 'medium',
  job: Object.freeze({ id: 'cold_initial_index-0', kind: 'cold_initial_index', repeat: 0 }),
  auditPageSize: 512,
  cacheSeedBatchSize: 512,
});

function diagnosticRecipeDigest() {
  return createHash('sha256').update(JSON.stringify(recipe)).digest('hex');
}

async function writePrivateJson(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

export async function prepareDiagnosticRun(options, services = {}) {
  if (process.platform !== 'linux' || Number.parseInt(process.versions.node.split('.')[0] ?? '', 10) < 24) {
    throw new Error('diagnostic_platform_not_supported');
  }
  const source = await (services.sourceMetadata ?? performanceSourceMetadata)(services.repository ?? repository);
  const sourceFingerprint = source.environment.sourceFingerprint;
  if (typeof sourceFingerprint !== 'string' || !digestPattern.test(sourceFingerprint)) {
    throw new Error('diagnostic_source_identity_unavailable');
  }
  const runId = services.runId ?? randomUUID();
  if (!runIdPattern.test(runId)) throw new Error('diagnostic_run_id_invalid');

  const diagnosticsRoot = resolve(options.diagnosticsRoot);
  await mkdir(diagnosticsRoot, { recursive: true, mode: 0o700 });
  if (await realpath(diagnosticsRoot) !== diagnosticsRoot) throw new Error('diagnostic_root_not_canonical');
  const runDirectory = join(diagnosticsRoot, runId);
  const traceDirectory = join(runDirectory, 'trace');
  await mkdir(runDirectory, { mode: 0o700 });
  await mkdir(traceDirectory, { mode: 0o700 });

  const workerRequestFile = join(runDirectory, 'worker-request.json');
  const workerDiagnosticRequestFile = join(runDirectory, 'worker-diagnostic-request.json');
  const resultFile = join(runDirectory, 'worker-result.json');
  const phaseFile = join(runDirectory, 'worker-phase.json');
  const scenarioRequest = {
    schemaVersion: 1,
    mode: 'scenario',
    runId,
    ownerRoot: runDirectory,
    resultFile,
    phaseFile,
    deadlineEpochMs: (services.nowMs ?? Date.now)() + timeoutMs,
    memoryLimitMb,
    timeoutMs,
    options: {
      profile: 'medium',
      outputMode: 'file',
      revision: source.revision,
      timeoutMs,
      auditPageSize: 512,
      cacheSeedBatchSize: 512,
      memoryLimitMb,
      sampleMode: 'full',
    },
    job: recipe.job,
  };
  const workerDiagnosticRequest = {
    schemaVersion: 1,
    diagnosticOnly: true,
    runId,
    jobId: 'cold_initial_index',
    recipeDigest: diagnosticRecipeDigest(),
    sourceFingerprint,
    runDirectory: traceDirectory,
    operationId: `op_${randomBytes(16).toString('hex')}`,
    attemptId: 'attempt_1',
  };

  await writePrivateJson(workerRequestFile, scenarioRequest);
  await writePrivateJson(workerDiagnosticRequestFile, workerDiagnosticRequest);
  return Object.freeze({
    runId,
    diagnosticOnly: true,
    runDirectory,
    traceDirectory,
    workerRequestFile,
    workerDiagnosticRequestFile,
    resultFile,
    phaseFile,
    scenarioRequest,
    workerDiagnosticRequest,
  });
}

function parseArgs(args) {
  if (args.length === 0) return join(repository, 'reports/performance-execution/diagnostics');
  if (args.length !== 2 || args[0] !== '--output-root' || args[1] === undefined || args[1].startsWith('--')) {
    throw new Error('diagnostic_arguments_invalid');
  }
  return resolve(args[1]);
}

async function main() {
  try {
    const prepared = await prepareDiagnosticRun({ diagnosticsRoot: parseArgs(process.argv.slice(2)) });
    process.stdout.write(`${JSON.stringify({ status: 'prepared_only', diagnosticOnly: true, runId: prepared.runId })}\n`);
  } catch (error) {
    const allowedReasons = new Set([
      'diagnostic_platform_not_supported',
      'diagnostic_source_identity_unavailable',
      'diagnostic_run_id_invalid',
      'diagnostic_root_not_canonical',
    ]);
    const reason = error instanceof Error && allowedReasons.has(error.message)
      ? error.message
      : 'diagnostic_preparation_failed';
    process.stderr.write(`${reason}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
