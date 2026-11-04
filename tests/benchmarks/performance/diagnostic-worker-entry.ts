import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { executeDiagnosticPerformanceWorker } from './diagnostics/diagnostic-worker.js';
import { workerDiagnosticRequestSchema } from './worker-contracts.js';
import { diagnosticWorkerResultSchema, diagnosticWorkerScenarioSchema } from '../../../scripts/performance-diagnostics/diagnostic-worker-result-contract.mjs';

const RESULT_FILE_NAME = 'diagnostic-worker-result.json';
const MAX_REQUEST_BYTES = 64 * 1024;
export class DiagnosticWorkerEntryError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'DiagnosticWorkerEntryError';
    this.code = code;
  }
}

type DiagnosticWorkerExecution = Readonly<{
  scenario: unknown;
  observerFailure: boolean;
  traceIncomplete: boolean;
  diagnosticAdmissible: false;
}>;

type ExecuteDiagnosticWorker = (requestFile: string, diagnosticFile: string) => Promise<DiagnosticWorkerExecution>;

async function readDiagnosticRequest(path: string) {
  if (!isAbsolute(path) || process.platform !== 'linux' || process.getuid === undefined) {
    throw new DiagnosticWorkerEntryError('diagnostic_request_path_invalid');
  }
  let descriptor;
  try {
    if (await realpath(path) !== resolve(path)) throw new DiagnosticWorkerEntryError('diagnostic_request_invalid');
    descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const [info, canonical] = await Promise.all([
      descriptor.stat(),
      realpath(`/proc/self/fd/${descriptor.fd}`),
    ]);
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid()
      || canonical !== resolve(path) || info.size > MAX_REQUEST_BYTES) {
      throw new DiagnosticWorkerEntryError('diagnostic_request_invalid');
    }
    return workerDiagnosticRequestSchema.parse(JSON.parse(await descriptor.readFile('utf8')));
  } catch (error) {
    if (error instanceof DiagnosticWorkerEntryError) throw error;
    if (!(error instanceof Error)) throw error;
    throw new DiagnosticWorkerEntryError('diagnostic_request_invalid');
  } finally {
    await descriptor?.close();
  }
}

async function writePrivateResult(runDirectory: string, result: unknown): Promise<string> {
  if (process.platform !== 'linux' || process.getuid === undefined || await realpath(runDirectory) !== resolve(runDirectory)) {
    throw new DiagnosticWorkerEntryError('diagnostic_run_directory_invalid');
  }
  const directory = await open(runDirectory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const info = await directory.stat();
    if (!info.isDirectory() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid()
      || await realpath(`/proc/self/fd/${directory.fd}`) !== resolve(runDirectory)) {
      throw new DiagnosticWorkerEntryError('diagnostic_run_directory_invalid');
    }
  } finally {
    await directory.close();
  }

  const resultFile = join(runDirectory, RESULT_FILE_NAME);
  let descriptor;
  try {
    descriptor = await open(resultFile,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const info = await descriptor.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid()
      || await realpath(`/proc/self/fd/${descriptor.fd}`) !== resolve(resultFile)) {
      throw new DiagnosticWorkerEntryError('diagnostic_output_ownership_invalid');
    }
    await descriptor.writeFile(`${JSON.stringify(result)}\n`, 'utf8');
    await descriptor.sync();
  } catch (error) {
    if (error instanceof DiagnosticWorkerEntryError) throw error;
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new DiagnosticWorkerEntryError('diagnostic_output_path_exists');
    }
    if (!(error instanceof Error)) throw error;
    throw new DiagnosticWorkerEntryError('diagnostic_output_write_failed');
  } finally {
    await descriptor?.close();
  }
  return resultFile;
}

export async function runDiagnosticWorkerEntry(
  environment: Record<string, string | undefined>,
  executeWorker: ExecuteDiagnosticWorker = executeDiagnosticPerformanceWorker,
) {
  const requestFile = environment.NEXUS_PERF_REQUEST_FILE;
  const diagnosticFile = environment.NEXUS_PERF_WORKER_DIAGNOSTIC_REQUEST_FILE;
  if (requestFile === undefined || diagnosticFile === undefined || !isAbsolute(requestFile) || !isAbsolute(diagnosticFile)) {
    throw new DiagnosticWorkerEntryError('diagnostic_control_path_missing');
  }
  const diagnosticRequest = await readDiagnosticRequest(diagnosticFile);
  const execution = await executeWorker(requestFile, diagnosticFile);
  const scenario = diagnosticWorkerScenarioSchema.safeParse(execution.scenario);
  const scenarioSucceeded = scenario.success && scenario.data.records.every((record) => record.status === 'valid')
    && !execution.observerFailure && !execution.traceIncomplete;
  const status = scenarioSucceeded ? 'completed' : 'failed';
  const result = diagnosticWorkerResultSchema.parse({
    schemaVersion: 1,
    diagnosticOnly: true,
    runId: diagnosticRequest.runId,
    jobId: diagnosticRequest.jobId,
    recipeDigest: diagnosticRequest.recipeDigest,
    sourceFingerprint: diagnosticRequest.sourceFingerprint,
    status,
    exitCode: scenarioSucceeded ? 0 : 1,
    diagnosticAdmissible: false,
    observerFailure: execution.observerFailure,
    traceIncomplete: execution.traceIncomplete,
    scenario: execution.scenario,
  });
  const resultFile = await writePrivateResult(diagnosticRequest.runDirectory, result);
  return Object.freeze({ resultFile, status: result.status, exitCode: result.exitCode, runId: result.runId });
}
