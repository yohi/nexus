import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { cleanupWorkerArtifacts } from '../../../../benchmarks/performance/worker-cleanup.js';
import { createRuntimeDiagnosticContext } from '../../../../benchmarks/performance/diagnostics/worker-stage-context.js';
import { withRuntimeDiagnosticContext } from '../../../../../src/observability/diagnostic-stage-trace.js';
import { createDiagnosticTestContext } from './diagnostic-test-helpers.js';

describe('worker cleanup diagnostic stages', () => {
  it('records owned scratch cleanup as an S12 terminal span without paths', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'nexus-worker-cleanup-'));
    const context = createDiagnosticTestContext();

    await withRuntimeDiagnosticContext(createRuntimeDiagnosticContext(context), () =>
      cleanupWorkerArtifacts({ removeWorkspace: () => rm(scratch, { recursive: true, force: true }) }));

    const trace = context.recorder.snapshot().events;
    expect(trace.some((event) =>
      event.event === 'span_finished' && event.stageId === 'S12_resource_cleanup' && event.status === 'completed')).toBe(true);
    expect(JSON.stringify(trace)).not.toContain(scratch);
  });
});
