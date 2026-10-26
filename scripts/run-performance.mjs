import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePerformanceOptions, performanceJobs, workerNodeOptions } from './performance-options.mjs';
import { runPerformanceProcess } from './performance-process.mjs';
import { performanceSourceMetadata } from './performance-source.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const installedVitest = fileURLToPath(import.meta.resolve('vitest/vitest.mjs'));

function failureReport(runId, environment, code) {
  return { schemaVersion: 1, recipeVersion: 'retrieval-performance-v1', status: 'incomplete', runId,
    fixtureDigest: null, workload: null, environment, options: null, scenarios: [], summaries: [],
    warnings: ['report_validation_unavailable'], diagnostics: [{ code, count: 1, examples: [] }],
    coverage: { expectedIds: [], missingIds: [], validRecords: 0, invalidRecords: 0, skippedRecords: 0, blockedRecords: 0 } };
}

export async function runPerformance(args = process.argv.slice(2), services = {}) {
  const cli = parsePerformanceOptions(args);
  const runId = randomUUID();
  const source = await performanceSourceMetadata(repository);
  const options = cli.valid ? { profile: cli.profile, outputMode: cli.output === undefined ? 'stdout' : 'file',
    revision: source.revision, timeoutMs: cli.timeoutMs, auditPageSize: 512, cacheSeedBatchSize: 512,
    memoryLimitMb: cli.memoryLimitMb, sampleMode: cli.profile === 'smoke' ? 'smoke' : 'full' } : null;
  const diagnostic = services.diagnostic ?? ((job, code) => process.stderr.write(`[performance:${job}] ${code}\n`));
  const owner = await mkdtemp(join(tmpdir(), 'nexus-performance-run-'));
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGTERM', abort); process.once('SIGINT', abort);
  let report;
  let code = 1;
  try {
    const transports = [];
    const diagnostics = cli.valid ? [] : [{ code: cli.error ?? 'invalid_options', count: 1, examples: [] }];
    if (options !== null) {
      for (const job of performanceJobs(options.sampleMode)) {
        const root = join(owner, job.id); await mkdir(root);
        const resultFile = join(root, 'result.json'); const phaseFile = join(root, 'phase.json');
        const requestFile = join(root, 'request.json');
        const request = { schemaVersion: 1, mode: 'scenario', runId, ownerRoot: root, resultFile, phaseFile,
          deadlineEpochMs: Date.now() + cli.timeoutMs, memoryLimitMb: cli.memoryLimitMb, timeoutMs: cli.timeoutMs, options, job };
        await writeFile(requestFile, JSON.stringify(request), { encoding: 'utf8', mode: 0o600 });
        diagnostic(job.id, 'start');
        transports.push(await runPerformanceProcess(job, { args: [services.scenarioVitestEntry ?? installedVitest, 'run',
          '--config', join(repository, 'vitest.performance.config.ts'), '--reporter=dot'], cwd: repository,
          env: { ...process.env, NODE_OPTIONS: workerNodeOptions(process.env.NODE_OPTIONS, cli.memoryLimitMb),
            NEXUS_PERF_REQUEST_FILE: requestFile, TMPDIR: root, TMP: root, TEMP: root },
          timeoutMs: cli.timeoutMs, resultFile, phaseFile, signal: controller.signal, diagnostic }));
      }
    }
    const root = join(owner, 'aggregation'); await mkdir(root);
    const resultFile = join(root, 'report.json'); const phaseFile = join(root, 'phase.json'); const requestFile = join(root, 'request.json');
    await writeFile(requestFile, JSON.stringify({ schemaVersion: 1, mode: 'aggregate', runId, ownerRoot: root,
      resultFile, phaseFile, deadlineEpochMs: Date.now() + Math.max(cli.timeoutMs, 10_000), memoryLimitMb: cli.memoryLimitMb,
      timeoutMs: cli.timeoutMs, options, environment: source.environment, transports, diagnostics }), { encoding: 'utf8', mode: 0o600 });
    const aggregated = await runPerformanceProcess({ id: 'aggregate', kind: 'aggregate', repeat: 0 }, {
      args: [installedVitest, 'run', '--config', join(repository, 'vitest.performance.config.ts'), '--reporter=dot'], cwd: repository,
      env: { ...process.env, NODE_OPTIONS: workerNodeOptions(process.env.NODE_OPTIONS, cli.memoryLimitMb),
        NEXUS_PERF_REQUEST_FILE: requestFile, TMPDIR: root, TMP: root, TEMP: root }, timeoutMs: Math.max(cli.timeoutMs, 10_000),
      resultFile, phaseFile, diagnostic });
    if (aggregated.exitCode !== 0 || aggregated.timedOut || aggregated.oom || aggregated.cleanupFailed) throw new Error('aggregation_failed');
    const text = await readFile(resultFile, 'utf8');
    report = JSON.parse(text);
    if (report.schemaVersion !== 1 || report.recipeVersion !== 'retrieval-performance-v1' || report.runId !== runId ||
      !['complete', 'incomplete'].includes(report.status) || (options !== null && report.options?.profile !== options.profile)) {
      throw new Error('invalid_aggregation_envelope');
    }
    code = report.status === 'complete' ? 0 : 1;
  } catch { report = failureReport(runId, source.environment, 'aggregation_failed'); }
  finally {
    process.removeListener('SIGTERM', abort); process.removeListener('SIGINT', abort);
    try { await rm(owner, { recursive: true, force: true }); }
    catch { report = failureReport(runId, source.environment, 'parent_cleanup_failed'); code = 1; }
  }
  const text = `${JSON.stringify(report)}\n`;
  if (cli.output === undefined) process.stdout.write(text);
  else {
    try {
      const path = resolve(cli.output); await mkdir(dirname(path), { recursive: true });
      try { if ((await lstat(path)).isDirectory()) throw new Error('output_unwritable'); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
      await writeFile(path, text, 'utf8');
    } catch { diagnostic('output', 'output_unwritable'); code = 1; }
  }
  return code;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPerformance();
}
