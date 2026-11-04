import { createRequire } from 'node:module';
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  bootstrapStatusSchema,
  DiagnosticBootstrapError,
  diagnosticRequestSchema,
  ensurePathAbsent,
  inside,
  profileRequestPath,
  profilerRequestSchema,
  quoteNodeOption,
  readPrivateJson,
  scenarioRequestSchema,
  verifyOwnedDirectory,
  writePrivateJson,
} from './diagnostic-vitest-bootstrap-control.mjs';
import { readProcessIdentity } from './process-identity.mjs';
export { DiagnosticBootstrapError } from './diagnostic-vitest-bootstrap-control.mjs';

const supervisorStartMessageSchema = z.object({
  type: z.literal('supervisor_start'),
  runId: z.string().uuid(),
  pid: z.number().int().positive(),
  startTicks: z.string().regex(/^[1-9][0-9]*$/),
  ppid: z.number().int().nonnegative(),
  pgid: z.number().int().positive(),
  sid: z.number().int().positive(),
}).strict();

function waitForSupervisorStartMessage() {
  return new Promise((resolveMessage, rejectMessage) => {
    const onMessage = (message) => {
      clearTimeout(timeout);
      process.removeListener('disconnect', onDisconnect);
      resolveMessage(message);
    };
    const onDisconnect = () => {
      clearTimeout(timeout);
      process.removeListener('message', onMessage);
      rejectMessage(new DiagnosticBootstrapError('supervisor_start_disconnected'));
    };
    const timeout = setTimeout(() => {
      process.removeListener('message', onMessage);
      process.removeListener('disconnect', onDisconnect);
      rejectMessage(new DiagnosticBootstrapError('supervisor_start_timeout'));
    }, 2_000);
    process.once('message', onMessage);
    process.once('disconnect', onDisconnect);
  });
}

const supervisorStartMessage = process.env.NEXUS_PERF_SUPERVISOR_START_REQUIRED === '1'
  ? waitForSupervisorStartMessage()
  : undefined;

async function verifySupervisorStart(environment, runId, pid, services) {
  if (environment.NEXUS_PERF_SUPERVISOR_START_REQUIRED !== '1') return;
  const messageValue = services.waitForSupervisorStart === undefined
    ? await supervisorStartMessage
    : await services.waitForSupervisorStart();
  const message = supervisorStartMessageSchema.safeParse(messageValue);
  if (!message.success || message.data.runId !== runId || message.data.pid !== pid) {
    throw new DiagnosticBootstrapError('supervisor_start_identity_invalid');
  }
  const readIdentity = services.readProcessIdentity ?? readProcessIdentity;
  const current = await readIdentity(pid);
  if (current.status !== 'observed' || current.identity.pid !== message.data.pid
    || current.identity.startTicks !== message.data.startTicks || current.identity.ppid !== message.data.ppid
    || current.identity.pgid !== message.data.pgid || current.identity.sid !== message.data.sid) {
    throw new DiagnosticBootstrapError('supervisor_start_identity_invalid');
  }
}

export async function runDiagnosticVitestBootstrap(input, services = {}) {
  const { environment, repository, pid, preloadPath, configPath, testEntryPath } = input;
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' || !Number.isSafeInteger(pid) || pid < 1) {
    throw new DiagnosticBootstrapError('diagnostic_platform_or_pid_invalid');
  }
  if (environment.NODE_OPTIONS !== undefined && environment.NODE_OPTIONS.trim() !== '') {
    throw new DiagnosticBootstrapError('diagnostic_node_options_collision');
  }
  const repositoryRoot = resolve(repository);
  if (await realpath(repositoryRoot) !== repositoryRoot) throw new DiagnosticBootstrapError('diagnostic_repository_not_canonical');
  const preload = resolve(preloadPath);
  if (await realpath(preload) !== preload || !inside(repositoryRoot, preload)) {
    throw new DiagnosticBootstrapError('diagnostic_preload_path_invalid');
  }
  const config = resolve(configPath);
  const testEntry = resolve(testEntryPath);
  if (!inside(repositoryRoot, config) || !inside(repositoryRoot, testEntry)) {
    throw new DiagnosticBootstrapError('diagnostic_vitest_path_invalid');
  }

  const scenarioPath = environment.NEXUS_PERF_REQUEST_FILE;
  const diagnosticPath = environment.NEXUS_PERF_WORKER_DIAGNOSTIC_REQUEST_FILE;
  if (scenarioPath === undefined || diagnosticPath === undefined || !isAbsolute(scenarioPath) || !isAbsolute(diagnosticPath)) {
    throw new DiagnosticBootstrapError('diagnostic_control_path_missing');
  }
  const scenarioCandidate = resolve(scenarioPath);
  const ownerRoot = resolve(dirname(scenarioCandidate));
  await verifyOwnedDirectory(ownerRoot);
  const scenarioRequest = scenarioRequestSchema.parse(await readPrivateJson(scenarioCandidate, ownerRoot));
  if (scenarioRequest.ownerRoot !== ownerRoot || basename(ownerRoot) !== scenarioRequest.runId) {
    throw new DiagnosticBootstrapError('diagnostic_request_mismatch');
  }
  const diagnosticRequest = diagnosticRequestSchema.parse(await readPrivateJson(diagnosticPath, ownerRoot));
  if (scenarioRequest.runId !== diagnosticRequest.runId || scenarioRequest.job.kind !== diagnosticRequest.jobId
    || !inside(ownerRoot, resolve(scenarioRequest.resultFile)) || !inside(ownerRoot, resolve(scenarioRequest.phaseFile))) {
    throw new DiagnosticBootstrapError('diagnostic_request_mismatch');
  }
  const diagnosticRunDirectory = resolve(diagnosticRequest.runDirectory);
  if (!inside(ownerRoot, diagnosticRunDirectory)) throw new DiagnosticBootstrapError('diagnostic_request_mismatch');
  await verifyOwnedDirectory(diagnosticRunDirectory);

  const profilerRequestFile = profileRequestPath(environment);
  if (!inside(diagnosticRunDirectory, profilerRequestFile)) {
    throw new DiagnosticBootstrapError('diagnostic_profile_request_path_invalid');
  }
  const profilerRequest = {
    schemaVersion: 1,
    diagnosticOnly: true,
    runId: diagnosticRequest.runId,
    jobId: diagnosticRequest.jobId,
    recipeDigest: diagnosticRequest.recipeDigest,
    sourceFingerprint: diagnosticRequest.sourceFingerprint,
    runDirectory: diagnosticRunDirectory,
    parentPid: pid,
  };
  const parsedProfilerRequest = profilerRequestSchema.parse(profilerRequest);
  const statusFile = join(ownerRoot, 'diagnostic-status.json');
  await ensurePathAbsent(profilerRequestFile);
  await ensurePathAbsent(statusFile);
  await writePrivateJson(profilerRequestFile, diagnosticRunDirectory, parsedProfilerRequest);

  await verifySupervisorStart(environment, diagnosticRequest.runId, pid, services);
  environment.NODE_OPTIONS = `--max-old-space-size=2048 --require ${quoteNodeOption(preload)}`;
  const loadProfiler = services.loadProfiler ?? ((path) => createRequire(import.meta.url)(path));
  await loadProfiler(preload);
  const startVitest = services.startVitest ?? (async (mode, filters, options) => {
    const { startVitest: start } = await import('vitest/node');
    return await start(mode, filters, options);
  });
  let vitestFailed = false;
  try {
    await startVitest('test', [testEntry], {
      run: true,
      config,
      pool: 'forks',
      fileParallelism: false,
      maxWorkers: 1,
      minWorkers: 1,
      isolate: true,
      coverage: { enabled: false },
    });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    vitestFailed = true;
  }
  const exitCode = services.getExitCode?.() ?? process.exitCode ?? (vitestFailed ? 1 : 0);
  const failed = vitestFailed || exitCode !== 0;
  const result = bootstrapStatusSchema.parse({
    schemaVersion: 1,
    diagnosticOnly: true,
    runId: diagnosticRequest.runId,
    jobId: diagnosticRequest.jobId,
    status: failed ? 'failed' : 'completed',
    exitCode,
    diagnosticAdmissible: false,
    ...(failed ? { reasonCode: 'vitest_failed' } : {}),
  });
  await writePrivateJson(statusFile, ownerRoot, result);
  return Object.freeze({
    status: result.status,
    runId: diagnosticRequest.runId,
    profileRequestFile: profilerRequestFile,
    statusFile,
    exitCode,
  });
}

async function main() {
  try {
    const currentFile = fileURLToPath(import.meta.url);
    const repository = resolve(dirname(currentFile), '../..');
    const result = await runDiagnosticVitestBootstrap({
      environment: process.env,
      repository,
      pid: process.pid,
      preloadPath: join(dirname(currentFile), 'v4/worker_profile_preload.cjs'),
      configPath: join(repository, 'vitest.diagnostic-performance.config.ts'),
      testEntryPath: join(repository, 'tests/benchmarks/performance/runtime.diagnostic.perf.ts'),
    });
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
  } catch (error) {
    const code = error instanceof DiagnosticBootstrapError ? error.code : 'diagnostic_bootstrap_failed';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
