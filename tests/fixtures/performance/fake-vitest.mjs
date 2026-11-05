import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getHeapStatistics } from 'node:v8';
import { spawn } from 'node:child_process';

const request = JSON.parse(await readFile(process.env.NEXUS_PERF_REQUEST_FILE, 'utf8'));
const behavior = process.env.NEXUS_PERF_PROBE_BEHAVIOR ?? 'noise';
if (behavior === 'grace' && request.job.kind === 'cold_initial_index') {
  const marker = process.env.NEXUS_PERF_PROBE_GRACE_FILE;
  const child = spawn(process.execPath, ['-e', 'const fs=require("node:fs");process.on("SIGTERM",()=>setTimeout(()=>{fs.writeFileSync(process.argv[1],"cleaned");process.exit(0)},250));process.stdout.write("ready");setInterval(()=>{},1000)', marker],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  await new Promise((resolve) => child.stdout.once('data', resolve));
  child.stdout.destroy(); child.unref();
}
if (process.env.NEXUS_PERF_PROBE_ROOTS_FILE) await appendFile(process.env.NEXUS_PERF_PROBE_ROOTS_FILE, `${request.ownerRoot}\n`);
await writeFile(request.phaseFile, JSON.stringify({ phase: 'setup' }));
process.stdout.write('UNTRUSTED_STDOUT /private/fixture sk-test-secret\n');
process.stderr.write('UNTRUSTED_STDERR /private/fixture sk-test-secret\n');
if (behavior === 'timeout' || behavior === 'setup-deadline') {
  await mkdir(join(request.ownerRoot, 'partial-cache'));
  await writeFile(join(request.ownerRoot, 'partial-cache', 'partial-seed'), 'owned partial target');
  setInterval(() => {}, 1000);
  await new Promise(() => {});
} else if (behavior === 'killed') process.kill(process.pid, 'SIGKILL');
else if (behavior === 'oom') { process.stderr.write('FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\n'); process.exitCode = 134; }
else if (behavior === 'invalid-json') await writeFile(request.resultFile, '{');
else {
  const cases = ['grep-selective', 'grep-broad', 'grep-no-match', 'grep-early', 'grep-late', 'hybrid-pre-fusion-125',
    'semantic-selective', 'structured-outline', 'structured-source', 'structured-context'];
  const ids = request.job.kind === 'siblings' ? ['sibling_first', 'sibling_second']
    : request.job.kind === 'warm' || request.job.kind === 'first_call'
      ? cases.map((id) => `${request.job.kind === 'warm' ? 'warm' : 'first'}-${id}`) : [request.job.kind];
  const records = ids.map((id) => ({ id, status: 'invalid', revision: request.options.revision,
    boundary: 'handler-internal', cacheState: 'empty', sampleMode: request.options.sampleMode,
    memoryLimitMb: request.options.memoryLimitMb, phase: 'setup', elapsedMs: 1,
    failures: [{ code: behavior === 'batch-two' ? 'cache_seed_failed' : 'worker_runtime_failed', count: 1, examples: [] }],
    ...(behavior === 'batch-two' ? { cacheSeed: { status: 'invalid', phase: 'setup', code: 'cache_seed_failed',
      expectedKeyCount: 1025, verifiedKeyCount: 512, batchLimit: 512, maxRequestedBatchSize: 512, durationMs: 1 } } : {}) }));
  const flag = /--max-old-space-size=(\d+)/.exec(process.env.NODE_OPTIONS ?? '');
  await writeFile(request.resultFile, JSON.stringify({ schemaVersion: 1, jobId: request.job.id, options: request.options,
    records, fixtureDigest: null, workload: null, limits: {
      requestedMemoryLimitMb: request.memoryLimitMb, receivedMemoryLimitMb: Number(flag?.[1] ?? 0),
      vmHeapLimitBytes: getHeapStatistics().heap_size_limit,
      peakHeapUsedBytes: behavior === 'over-limit' ? request.memoryLimitMb * 1024 * 1024 + 1 : process.memoryUsage().heapUsed,
      lifetimePeakRssBytes: process.resourceUsage().maxRSS * 1024, pid: process.pid,
    } }));
}
