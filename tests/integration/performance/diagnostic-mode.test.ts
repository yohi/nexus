import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { diagnosticRequestMatchesWorker, workerDiagnosticRequestSchema, workerRequestSchema } from '../../benchmarks/performance/worker-contracts.js';

const runId = '00000000-0000-4000-8000-000000000001';
const sourceFingerprint = 'a'.repeat(64);
const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-diagnostic-mode-'));
  roots.push(root);
  return root;
}

async function loadLauncher() {
  const launcher = await import('../../../scripts/run-performance-diagnostic.mjs').catch(() => undefined);
  expect(launcher?.prepareDiagnosticRun).toBeTypeOf('function');
  if (launcher === undefined) throw new Error('diagnostic_launcher_not_available');
  return launcher;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('diagnostic-only performance launcher', () => {
  it('prepares a private medium cold-start request without launching a worker', async () => {
    const launcher = await loadLauncher();
    const diagnosticsRoot = join(await temporaryRoot(), 'diagnostics');
    const prepared = await launcher.prepareDiagnosticRun({ diagnosticsRoot }, {
      repository: '/repo',
      runId,
      sourceMetadata: () => Promise.resolve({
        revision: { commit: 'f'.repeat(40), dirty: true },
        environment: { sourceFingerprint },
      }),
    });

    const request = workerRequestSchema.parse(JSON.parse(await readFile(prepared.workerRequestFile, 'utf8')));
    const diagnostic = workerDiagnosticRequestSchema.parse(JSON.parse(await readFile(prepared.workerDiagnosticRequestFile, 'utf8')));
    if (request.mode !== 'scenario') throw new Error('expected_diagnostic_scenario_request');
    expect(request).toMatchObject({
      mode: 'scenario',
      runId,
      timeoutMs: 600_000,
      memoryLimitMb: 2_048,
      options: { profile: 'medium', timeoutMs: 600_000, memoryLimitMb: 2_048, auditPageSize: 512, cacheSeedBatchSize: 512 },
      job: { kind: 'cold_initial_index', repeat: 0 },
    });
    expect(workerRequestSchema.safeParse({ ...request, diagnosticOnly: true }).success).toBe(false);
    expect(diagnostic).toMatchObject({ diagnosticOnly: true, runId, jobId: 'cold_initial_index', sourceFingerprint });
    expect(diagnosticRequestMatchesWorker(request, diagnostic)).toBe(true);
    expect((await stat(prepared.runDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(prepared.traceDirectory)).mode & 0o777).toBe(0o700);
    expect((await stat(prepared.workerRequestFile)).mode & 0o777).toBe(0o600);
    expect((await stat(prepared.workerDiagnosticRequestFile)).mode & 0o777).toBe(0o600);
    await expect(stat(join(prepared.traceDirectory, 'profiles'))).rejects.toThrow();
    await expect(stat(prepared.resultFile)).rejects.toThrow();
  });

  it('rejects a run ID whose private directory already exists without overwriting it', async () => {
    const launcher = await loadLauncher();
    const diagnosticsRoot = join(await temporaryRoot(), 'diagnostics');
    const prepared = await launcher.prepareDiagnosticRun({ diagnosticsRoot }, {
      repository: '/repo',
      runId,
      sourceMetadata: () => Promise.resolve({
        revision: { commit: 'f'.repeat(40), dirty: true },
        environment: { sourceFingerprint },
      }),
    });

    await expect(launcher.prepareDiagnosticRun({ diagnosticsRoot }, {
      repository: '/repo',
      runId,
      sourceMetadata: () => Promise.resolve({
        revision: { commit: 'f'.repeat(40), dirty: true },
        environment: { sourceFingerprint },
      }),
    })).rejects.toThrow();
    expect(await readFile(prepared.workerRequestFile, 'utf8')).toContain(runId);
  });

  it('rejects missing source identity before creating a diagnostic run directory', async () => {
    const launcher = await loadLauncher();
    const diagnosticsRoot = join(await temporaryRoot(), 'diagnostics');

    await expect(launcher.prepareDiagnosticRun({ diagnosticsRoot }, {
      repository: '/repo',
      runId,
      sourceMetadata: () => Promise.resolve({
        revision: { commit: null, dirty: null },
        environment: {},
      }),
    })).rejects.toThrow();
    await expect(stat(diagnosticsRoot)).rejects.toThrow();
  });
});
