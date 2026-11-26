import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createQualityFixture } from '../../../../tests/benchmarks/quality/fixtures.js';
import { canonicalJson } from '../../../../tests/benchmarks/quality/canonical-json.js';
import {
  collectQualityRouteCoverage,
  getLineSubmatches,
} from '../../../../tests/benchmarks/quality/runner.js';

const sha256 = (content: string | Uint8Array): string =>
  createHash('sha256').update(content).digest('hex');

describe('quality route coverage', () => {
  it('rejects empty line-search needles while preserving non-empty matching', () => {
    expect(getLineSubmatches('', 'answer')).toEqual([]);
    expect(getLineSubmatches('wer', 'answer')).toEqual([
      { start: 3, end: 6, match: 'wer' },
    ]);
  });

  it('records a trace for each invoked Q01 probe with its sequence and normalized public arguments', async () => {
    const fixture = await createQualityFixture(['Q01@quality-v1'], new AbortController().signal);
    try {
      const task = fixture.oracleCases[0];
      if (task === undefined) throw new Error('Q01 fixture missing');

      const [route] = await collectQualityRouteCoverage(task, fixture, {
        signal: new AbortController().signal,
      });

      expect(route?.status).toBe('COVERED');
      expect(route?.probes.map(({ traceSequence }) => traceSequence)).toEqual([1, 2]);
      expect(route?.probeTrace.map(({ sequence }) => sequence)).toEqual([1, 2]);
      expect(route?.probeTrace.map(({ resultStatus }) => resultStatus)).toEqual(
        route?.probes.map(({ observedStatus }) => observedStatus),
      );
      expect(route?.probes[1]?.publicArgsDigest).toBe(
        sha256(canonicalJson({ maxResults: 20 })),
      );
    } finally {
      await fixture.dispose();
    }
  });

  it.each(['Q07@quality-v1', 'Q08@quality-v1', 'Q10@quality-v1'])(
    'covers fixture-backed search/source routes for %s',
    async (scenarioId) => {
      const fixture = await createQualityFixture([scenarioId], new AbortController().signal);
      try {
        const task = fixture.oracleCases[0];
        if (task === undefined) throw new Error(`${scenarioId} fixture missing`);

        const [route] = await collectQualityRouteCoverage(task, fixture, {
          signal: new AbortController().signal,
        });

        expect(route?.status).toBe('COVERED');
        expect(route?.probes.every(({ status }) => status === 'COVERED')).toBe(true);
        expect(route?.probeTrace).toHaveLength(route?.probes.length ?? 0);
      } finally {
        await fixture.dispose();
      }
    },
  );

  it('rejects Q03 old identity and reads the renamed declaration with its current identity', async () => {
    const fixture = await createQualityFixture(['Q03@quality-v1'], new AbortController().signal);
    try {
      const task = fixture.oracleCases[0];
      if (task === undefined) throw new Error('Q03 fixture missing');

      const [route] = await collectQualityRouteCoverage(task, fixture, {
        signal: new AbortController().signal,
      });

      const oldIdentity = route?.probes.find(({ expectedAction }) => expectedAction === 'safe_refusal');
      const currentIdentity = route?.probes.find(({ expectedAction }) => expectedAction === 'current_source');
      expect(oldIdentity?.observedStatus).toBe('stale_identity');
      expect(oldIdentity?.reasonCode).toBe('SYMBOL_RETIRED');
      expect(oldIdentity?.status).toBe('COVERED');
      expect(currentIdentity?.observedStatus).toBe('ok');
      expect(currentIdentity?.status).toBe('COVERED');
      expect(route?.status).toBe('COVERED');
    } finally {
      await fixture.dispose();
    }
  });

  it('does not invoke or trace any probe when already aborted', async () => {
    const fixture = await createQualityFixture(['Q01@quality-v1'], new AbortController().signal);
    try {
      const task = fixture.oracleCases[0];
      if (task === undefined) throw new Error('Q01 fixture missing');
      const controller = new AbortController();
      controller.abort();

      const [route] = await collectQualityRouteCoverage(task, fixture, { signal: controller.signal });

      expect(route?.probes.every(({ status }) => status === 'BLOCKED')).toBe(true);
      expect(route?.probes.every(({ traceSequence }) => traceSequence === null)).toBe(true);
      expect(route?.probeTrace).toEqual([]);
    } finally {
      await fixture.dispose();
    }
  });
});
