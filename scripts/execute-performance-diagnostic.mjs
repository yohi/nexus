import { constants } from 'node:fs';
import { open, readFile, realpath, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { evaluateHostGate } from './performance-diagnostics/host-gate.mjs';
import { collectHostSnapshot } from './performance-diagnostics/host-snapshot.mjs';
import {
  DiagnosticBootstrapError,
  diagnosticRequestSchema,
  inside,
  readPrivateJson,
  scenarioRequestSchema,
  verifyOwnedDirectory,
} from './performance-diagnostics/diagnostic-vitest-bootstrap-control.mjs';
import { measureFixtureSize } from './performance-diagnostics/fixture-size.mjs';
import { diagnosticSourceFingerprint } from './performance-diagnostics/source-fingerprint.mjs';
import { executeDiagnosticRun } from './performance-diagnostics/process-supervisor.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_EVIDENCE_BYTES = 8 * 1024 * 1024;
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sourcePinSchema = z.object({ schemaVersion: z.literal(1), digest: digestSchema }).passthrough();

function parseArgs(args) {
  let runDirectory;
  let mode = 'preflight';
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--run-directory' && args[index + 1] !== undefined) {
      runDirectory = resolve(args[index + 1]);
      index += 1;
    } else if (argument === '--capture-host' || argument === '--execute') {
      if (mode !== 'preflight') throw new Error('diagnostic_arguments_invalid');
      mode = argument === '--capture-host' ? 'capture' : 'execute';
    } else {
      throw new Error('diagnostic_arguments_invalid');
    }
  }
  if (runDirectory === undefined || !isAbsolute(runDirectory)) throw new Error('diagnostic_run_directory_required');
  return Object.freeze({ runDirectory, mode });
}

async function readPrivateEvidence(path, ownerRoot) {
  if (!inside(ownerRoot, resolve(path)) || await realpath(path) !== resolve(path)) {
    throw new DiagnosticBootstrapError('diagnostic_evidence_invalid');
  }
  let descriptor;
  try {
    descriptor = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const [info, canonical] = await Promise.all([
      descriptor.stat(),
      realpath(`/proc/self/fd/${descriptor.fd}`),
    ]);
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid()
      || canonical !== resolve(path) || info.size > MAX_EVIDENCE_BYTES) {
      throw new DiagnosticBootstrapError('diagnostic_evidence_invalid');
    }
    return JSON.parse(await descriptor.readFile('utf8'));
  } catch (error) {
    if (error instanceof DiagnosticBootstrapError) throw error;
    if (!(error instanceof Error)) throw error;
    throw new DiagnosticBootstrapError('diagnostic_evidence_invalid');
  } finally {
    await descriptor?.close();
  }
}

async function writePrivateEvidence(path, ownerRoot, value) {
  if (!inside(ownerRoot, resolve(path))) throw new DiagnosticBootstrapError('diagnostic_evidence_path_invalid');
  const content = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(content, 'utf8') > MAX_EVIDENCE_BYTES) throw new DiagnosticBootstrapError('diagnostic_evidence_too_large');
  let descriptor;
  try {
    descriptor = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const info = await descriptor.stat();
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid()
      || await realpath(`/proc/self/fd/${descriptor.fd}`) !== resolve(path)) {
      throw new DiagnosticBootstrapError('diagnostic_evidence_ownership_invalid');
    }
    await descriptor.writeFile(content, 'utf8');
    await descriptor.sync();
  } catch (error) {
    if (error instanceof DiagnosticBootstrapError) throw error;
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new DiagnosticBootstrapError('diagnostic_evidence_exists');
    }
    if (!(error instanceof Error)) throw error;
    throw new DiagnosticBootstrapError('diagnostic_evidence_write_failed');
  } finally {
    await descriptor?.close();
  }
}

async function preparedRunForDirectory(runDirectory) {
  await verifyOwnedDirectory(runDirectory);
  const workerRequestFile = join(runDirectory, 'worker-request.json');
  const workerDiagnosticRequestFile = join(runDirectory, 'worker-diagnostic-request.json');
  const [scenarioRequest, diagnosticRequest] = await Promise.all([
    readPrivateJson(workerRequestFile, runDirectory).then((value) => scenarioRequestSchema.parse(value)),
    readPrivateJson(workerDiagnosticRequestFile, runDirectory).then((value) => diagnosticRequestSchema.parse(value)),
  ]);
  if (scenarioRequest.runId !== diagnosticRequest.runId || scenarioRequest.ownerRoot !== runDirectory
    || diagnosticRequest.runDirectory !== join(runDirectory, 'trace')) {
    throw new DiagnosticBootstrapError('prepared_run_identity_mismatch');
  }
  return Object.freeze({
    runId: scenarioRequest.runId,
    diagnosticOnly: true,
    runDirectory,
    traceDirectory: diagnosticRequest.runDirectory,
    workerRequestFile,
    workerDiagnosticRequestFile,
  });
}

async function captureHostSnapshot(runDirectory) {
  const existing = new Set(await readdir(runDirectory));
  const index = [1, 2, 3].find((candidate) => !existing.has(`host-snapshot-${candidate}.json`));
  if (index === undefined) throw new DiagnosticBootstrapError('host_snapshot_limit_reached');
  const snapshot = await collectHostSnapshot({ procRoot: '/proc', sysRoot: '/sys', scratchPath: runDirectory });
  await writePrivateEvidence(join(runDirectory, `host-snapshot-${index}.json`), runDirectory, snapshot);
  return Object.freeze({ status: 'host_snapshot_captured', sequence: index });
}

async function sourceGateResult() {
  try {
    const pinValue = JSON.parse(await readFile(join(repository, 'scripts/performance-diagnostics/diagnostic-source-pin.json'), 'utf8'));
    const pin = sourcePinSchema.parse(pinValue);
    const current = await diagnosticSourceFingerprint(repository);
    return Object.freeze({
      status: current.digest === pin.digest ? 'PASS' : 'SOURCE_GATE_MISMATCH',
      digest: current.digest,
    });
  } catch (error) {
    if (error instanceof Error) return Object.freeze({ status: 'SOURCE_GATE_INDETERMINATE' });
    throw error;
  }
}

async function hostGateResult(runDirectory) {
  try {
    const snapshots = await Promise.all([1, 2, 3].map((index) =>
      readPrivateEvidence(join(runDirectory, `host-snapshot-${index}.json`), runDirectory)));
    const smallReport = JSON.parse(await readFile(join(repository, 'docs/observability/benchmarks/small.json'), 'utf8'));
    return Object.freeze({
      ...evaluateHostGate(snapshots, smallReport, measureFixtureSize('medium'), process.hrtime.bigint().toString()),
      snapshotCount: snapshots.length,
    });
  } catch (error) {
    if (error instanceof Error) {
      return Object.freeze({ status: 'HOST_GATE_INDETERMINATE', reasonCodes: Object.freeze(['host_evidence_unavailable']) });
    }
    throw error;
  }
}

async function main() {
  try {
    const argumentsValue = parseArgs(process.argv.slice(2));
    const prepared = await preparedRunForDirectory(argumentsValue.runDirectory);
    if (argumentsValue.mode === 'capture') {
      process.stdout.write(`${JSON.stringify(await captureHostSnapshot(argumentsValue.runDirectory))}\n`);
      return;
    }
    if (argumentsValue.mode === 'preflight') {
      process.stdout.write(`${JSON.stringify({ status: 'preflight_only', diagnosticOnly: true, runId: prepared.runId })}\n`);
      return;
    }
    const [source, host] = await Promise.all([
      sourceGateResult(),
      hostGateResult(argumentsValue.runDirectory),
    ]);
    const result = await executeDiagnosticRun(prepared, {
      executionMode: true,
      sourceGateResult: source,
      hostGateResult: host,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== 'completed' || result.diagnosticSummary?.admissible !== true) process.exitCode = 1;
  } catch (error) {
    const reasonCode = error instanceof DiagnosticBootstrapError ? error.code : 'diagnostic_supervisor_failed';
    process.stderr.write(`${reasonCode}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
