import { spawn } from 'node:child_process';

export async function runPerformanceProcess(job, options) {
  const started = performance.now();
  if (options.signal?.aborted) return { jobId: job.id, kind: job.kind, repeat: job.repeat, resultFile: options.resultFile,
    phaseFile: options.phaseFile, exitCode: null, signal: null, spawnFailed: false, timedOut: false,
    aborted: true, oom: false, cleanupFailed: false, elapsedMs: 0 };
  if (process.platform === 'win32') {
    options.diagnostic(job.id, 'unsupported_process_group_cleanup');
    return { jobId: job.id, kind: job.kind, repeat: job.repeat, resultFile: options.resultFile, phaseFile: options.phaseFile,
      exitCode: null, signal: null, spawnFailed: true, timedOut: false, aborted: false, oom: false, cleanupFailed: true, elapsedMs: 0 };
  }
  let timedOut = false;
  let aborted = false;
  let oom = false;
  let trailing = '';
  let cleanupFailed = false;
  let stdoutSeen = false;
  let stderrSeen = false;
  let grace;
  let terminationStarted;
  const child = spawn(process.execPath, options.args, { cwd: options.cwd, env: options.env,
    detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  const signalGroup = (signal) => {
    if (child.pid === undefined) return;
    try {
      if (process.platform === 'win32') child.kill(signal);
      else process.kill(-child.pid, signal);
    } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) cleanupFailed = true; }
  };
  const terminate = () => {
    terminationStarted ??= performance.now();
    signalGroup('SIGTERM');
    grace ??= setTimeout(() => signalGroup('SIGKILL'), 5_000);
  };
  const timer = setTimeout(() => { timedOut = true; options.diagnostic(job.id, 'deadline'); terminate(); }, options.timeoutMs);
  const abort = () => { aborted = true; terminate(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  child.stdout.on('data', () => {
    if (!stdoutSeen) { stdoutSeen = true; options.diagnostic(job.id, 'stdout_redacted'); }
  });
  child.stderr.on('data', (data) => {
    if (!stderrSeen) { stderrSeen = true; options.diagnostic(job.id, 'stderr_redacted'); }
    trailing = `${trailing}${data.toString()}`.slice(-4_096);
    if (/heap out of memory|Reached heap limit|Allocation failed/i.test(trailing)) oom = true;
  });
  const result = await new Promise((resolve) => {
    child.once('error', () => resolve({ exitCode: null, signal: null, spawnFailed: true }));
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal, spawnFailed: false }));
  });
  clearTimeout(timer);
  if (grace !== undefined) clearTimeout(grace);
  options.signal?.removeEventListener('abort', abort);
  if (process.platform !== 'win32' && child.pid !== undefined) {
    const alive = () => {
      try { process.kill(-child.pid, 0); return true; }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) cleanupFailed = true;
        return false;
      }
    };
    const waitForGroup = async (milliseconds) => {
      const deadline = performance.now() + milliseconds;
      while (alive() && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      return !alive();
    };
    if (alive()) {
      terminationStarted ??= performance.now();
      signalGroup('SIGTERM');
      if (!await waitForGroup(Math.max(0, 5_000 - (performance.now() - terminationStarted)))) {
        signalGroup('SIGKILL');
        if (!await waitForGroup(1_000)) cleanupFailed = true;
      }
    }
  }
  return { jobId: job.id, kind: job.kind, repeat: job.repeat, resultFile: options.resultFile,
    phaseFile: options.phaseFile, ...result, timedOut, aborted, oom, cleanupFailed,
    elapsedMs: performance.now() - started };
}
