import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { reportSchema } from '../../benchmarks/performance/contracts.js';

const script = fileURLToPath(new URL('../../../scripts/run-performance.mjs', import.meta.url));
const repository = dirname(dirname(script));
const probe = fileURLToPath(new URL('../../fixtures/performance/runner-probe.mjs', import.meta.url));
const roots: string[] = [];
async function temporaryRoot() { const root = await mkdtemp(join(tmpdir(), 'nexus-perf runner-')); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
function invoke(args: readonly string[], options: Readonly<{ npm?: boolean; probe?: boolean; cwd?: string; env?: NodeJS.ProcessEnv }> = {}) {
  const command = options.npm ? (process.platform === 'win32' ? 'npm.cmd' : 'npm') : process.execPath;
  const commandArgs = options.npm ? ['run', '--silent', 'test:perf', '--', ...args] : [options.probe ? probe : script, ...args];
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(command, commandArgs, { cwd: options.cwd ?? repository, env: { ...process.env, ...options.env },
      encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, stdout, stderr });
    });
  });
}

describe('isolated performance CLI', () => {
  it.each([['--profile', 'unknown'], ['--timeout-ms', '0'], ['--memory-limit-mb', '-1']])(
    'returns one invalid JSON report for malformed options %j', async (...args) => {
      const result = await invoke(args);
      expect(result.code).not.toBe(0);
      const report = reportSchema.parse(JSON.parse(result.stdout));
      expect(report.status).toBe('incomplete');
      expect(report.diagnostics.length).toBeGreaterThan(0);
      expect(result.stdout).not.toContain('RUN v');
    }, 30_000,
  );

  it('returns one complete smoke JSON document with no worker stdout pollution', async () => {
    const result = await invoke(['--profile', 'smoke']);
    expect(result.code, result.stderr).toBe(0);
    const report = reportSchema.parse(JSON.parse(result.stdout));
    expect(report.status).toBe('complete');
    expect(report.scenarios).toHaveLength(27);
    expect(report.scenarios.every((record) => record.status === 'valid')).toBe(true);
    expect(report.warnings).toContain('smoke_not_baseline');
    expect(result.stdout).not.toContain(repository);
    expect(result.stdout).not.toContain('nexus-performance-');
  }, 180_000);

  it('writes only the requested path with spaces through silent npm and leaves stdout empty', async () => {
    const root = await temporaryRoot();
    const path = join(root, 'nested reports', 'smoke result.json');
    const result = await invoke(['--profile', 'smoke', '--output', path], { npm: true });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe('');
    const report = reportSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    expect(report.status).toBe('complete');
  }, 180_000);

  it.each(['noise', 'invalid-json', 'killed', 'runtime-failure', 'batch-two', 'over-limit', 'oom'] as const)(
    'keeps %s worker failures machine-readable and source-free', async (behavior) => {
      const result = await invoke(['--profile', 'smoke'], { probe: true, env: { NEXUS_PERF_PROBE_BEHAVIOR: behavior } });
      expect(result.code).not.toBe(0);
      const report = reportSchema.parse(JSON.parse(result.stdout));
      expect(report.status).toBe('incomplete');
      expect(report.scenarios).toHaveLength(27);
      expect(report.scenarios.every((record) => record.status === 'invalid')).toBe(true);
      expect(result.stdout).not.toContain('UNTRUSTED');
      expect(result.stderr).not.toContain('UNTRUSTED');
      expect(result.stdout).not.toContain('/private');
      expect(result.stderr).not.toContain('sk-test-secret');
      if (behavior === 'batch-two') expect(report.scenarios.every((record) => record.status === 'invalid' && record.phase === 'setup')).toBe(true);
      if (behavior === 'over-limit' || behavior === 'oom') expect(report.scenarios.some((record) => record.status === 'invalid' &&
        record.failures.some((failure) => failure.code === (behavior === 'oom' ? 'worker_oom' : 'heap_limit_exceeded')))).toBe(true);
    }, 30_000,
  );

  it('applies the CLI heap ceiling to scenario and aggregation workers over inherited conflicts', async () => {
    const result = await invoke(['--profile', 'smoke', '--memory-limit-mb', '512'],
      { probe: true, env: { NODE_OPTIONS: '--max-old-space-size=64', NEXUS_PERF_PROBE_BEHAVIOR: 'noise' } });
    const report = reportSchema.parse(JSON.parse(result.stdout));
    expect(report.environment.aggregationLimits?.receivedMemoryLimitMb).toBe(512);
    expect(report.scenarios.every((record) => record.worker?.receivedMemoryLimitMb === 512)).toBe(true);
  }, 30_000);

  it('expires setup before t0 and removes owned partial cache directories after timeout', async () => {
    const root = await temporaryRoot();
    const log = join(root, 'owned-roots.txt');
    const result = await invoke(['--profile', 'smoke', '--timeout-ms', '300'],
      { probe: true, env: { NEXUS_PERF_PROBE_BEHAVIOR: 'setup-deadline', NEXUS_PERF_PROBE_ROOTS_FILE: log } });
    const report = reportSchema.parse(JSON.parse(result.stdout));
    expect(report.status).toBe('incomplete');
    expect(report.scenarios.every((record) => record.status === 'invalid' && record.phase === 'setup')).toBe(true);
    expect(report.scenarios.every((record) => !('rawSamples' in record))).toBe(true);
    const paths = (await readFile(log, 'utf8')).trim().split('\n');
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) await expect(access(path)).rejects.toThrow();
  }, 30_000);

  it('allows descendant cleanup within the five-second grace before forcing process-group termination', async () => {
    const root = await temporaryRoot();
    const marker = join(root, 'descendant-cleaned');
    const result = await invoke(['--profile', 'smoke'], { probe: true,
      env: { NEXUS_PERF_PROBE_BEHAVIOR: 'grace', NEXUS_PERF_PROBE_GRACE_FILE: marker } });
    expect(result.code).not.toBe(0);
    expect(await readFile(marker, 'utf8')).toBe('cleaned');
  }, 30_000);

  it('keeps output-mode stdout empty when the requested destination is unwritable', async () => {
    const root = await temporaryRoot();
    const result = await invoke(['--profile', 'unknown', '--output', root]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('output_unwritable');
  }, 30_000);

  it('resolves the worker/config from the script URL rather than a caller directory with spaces', async () => {
    const cwd = await temporaryRoot();
    const result = await invoke(['--profile', 'unknown'], { cwd });
    const report = reportSchema.parse(JSON.parse(result.stdout));
    expect(report.status).toBe('incomplete');
    expect(report.environment.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
  }, 30_000);
});
