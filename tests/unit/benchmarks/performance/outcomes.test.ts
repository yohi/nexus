import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { OutcomeCollector } from '../../../benchmarks/performance/outcomes.js';
import { validateGrepEvidence } from '../../../benchmarks/performance/grep-evidence.js';
import { queryCaseSchema } from '../../../benchmarks/performance/contracts.js';
import { observeReindex, observeRuntimeWork, captureObservedGrep } from '../../../../src/observability/runtime-work.js';
import type { RuntimeEvent } from '../../../../src/observability/runtime-observer.js';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const query = queryCaseSchema.parse({
  id: 'grep-test', tool: 'grep_search', args: { pattern: 'needle', maxResults: 100 }, requestedMaximum: 100,
  limits: [{ stage: 'grep', behavior: 'uncapped' }],
  expectedMatches: [{ path: 'src/a.ts', line: 1, lineDigest: sha('needle\n'),
    submatches: [{ start: 0, end: 6, contentDigest: sha('needle') }] }],
});
const match = { filePath: 'src/a.ts', lineNumber: 1, lineText: 'needle\n', submatches: [{ start: 0, end: 6, match: 'needle' }] };
const normalize = (path: string): Promise<string> => Promise.resolve(path);

describe('request-scoped outcome admission', () => {
  it('preserves successful work despite a throwing observer', async () => {
    const observer = { onEvent: () => { throw new Error('observer_failure'); } };
    await expect(observeRuntimeWork(observer, 'semantic', () => Promise.resolve(42))).resolves.toBe(42);
  });

  it('retains rejection instead of converting it into successful terminal evidence', async () => {
    const collector = new OutcomeCollector();
    await collector.run('request', async () => {
      await expect(observeRuntimeWork(collector, 'semantic', () => Promise.reject(new Error('branch_failure')))).rejects.toThrow('branch_failure');
      expect((await collector.seal('request')).status).toBe('invalid');
    });
  });

  it('rejects missing terminal events without assuming empty work succeeded', async () => {
    const signal = AbortSignal.abort();
    const collector = new OutcomeCollector(signal);
    await collector.run('request', async () => {
      collector.onEvent({ kind: 'work_started', work: 'grep', workId: 'missing', time: 1,
        context: { requestId: 'request', phaseId: 'request' } });
      expect((await collector.seal('request')).status).toBe('invalid');
    });
  });

  it('waits for a late child close and rejects abnormal completion', async () => {
    const collector = new OutcomeCollector();
    await collector.run('request', async () => {
      const identity = { workId: 'child', time: 1, context: { requestId: 'request', phaseId: 'request' } };
      collector.onEvent({ ...identity, kind: 'work_started', work: 'grep_spawn' });
      queueMicrotask(() => {
        collector.onEvent({ ...identity, kind: 'grep_child_finished', outcome: { status: 'aborted' } });
        collector.onEvent({ ...identity, kind: 'work_finished', work: 'grep_spawn', outcome: 'aborted' });
      });
      expect((await collector.seal('request')).status).toBe('invalid');
    });
  });

  it('rejects duplicated terminal observations', async () => {
    const collector = new OutcomeCollector();
    await collector.run('request', async () => {
      const events: RuntimeEvent[] = [];
      const observer = { onEvent: (event: RuntimeEvent) => { events.push(event); collector.onEvent(event); } };
      await observeRuntimeWork(observer, 'semantic', () => Promise.resolve([]));
      const terminal = events.find((event) => event.kind === 'work_finished');
      if (terminal === undefined) throw new Error('terminal required');
      collector.onEvent(terminal);
      expect((await collector.seal('request')).status).toBe('invalid');
    });
  });

  it('validates private snapshots after capture and releases their source data', async () => {
    const collector = new OutcomeCollector();
    await collector.run('request', async () => {
      const evidence = captureObservedGrep(collector, [match], 'direct');
      if (evidence === undefined) throw new Error('capture required');
      const proof = await validateGrepEvidence(evidence, query, normalize);
      expect(proof).toMatchObject({ status: 'valid', lineMatchCount: 1, submatchCount: 1 });
      expect(collector.pendingEvidenceCount).toBe(0);
      expect(JSON.stringify(proof)).not.toContain('needle');
    });
  });

  it.each(['missing', 'extra', 'duplicate', 'submatch', 'line'] as const)(
    'invalidates %s result corruption even when the public response is unchanged', async (kind) => {
      const collector = new OutcomeCollector();
      await collector.run('request', async () => {
        const rows = kind === 'missing' ? [] : kind === 'extra' || kind === 'duplicate' ? [match, match]
          : kind === 'submatch' ? [{ ...match, submatches: [] }] : [{ ...match, lineText: 'altered\n' }];
        const evidence = captureObservedGrep(collector, rows, 'direct');
        if (evidence === undefined) throw new Error('capture required');
        expect((await validateGrepEvidence(evidence, query, normalize)).status).toBe('invalid');
        expect(collector.pendingEvidenceCount).toBe(0);
      });
    },
  );

  it('rejects a token captured by another request', async () => {
    const collector = new OutcomeCollector();
    const evidence = await collector.run('first', () => Promise.resolve(captureObservedGrep(collector, [match], 'direct')));
    if (evidence === undefined) throw new Error('capture required');
    await collector.run('second', async () => {
      expect((await validateGrepEvidence(evidence, query, normalize)).status).toBe('invalid');
    });
    expect(collector.pendingEvidenceCount).toBe(0);
  });

  it('accepts successful empty grep evidence rather than a missing capture', async () => {
    const collector = new OutcomeCollector();
    await collector.run('request', async () => {
      const evidence = captureObservedGrep(collector, [], 'direct');
      if (evidence === undefined) throw new Error('capture required');
      expect(await validateGrepEvidence(evidence, { ...query, expectedMatches: [] }, normalize))
        .toMatchObject({ status: 'valid', lineMatchCount: 0, submatchCount: 0 });
    });
  });

  it('fails admission when an observer cannot capture fulfilled grep results', async () => {
    const collector = new OutcomeCollector();
    const observer = {
      onEvent: (event: RuntimeEvent) => collector.onEvent(event),
      captureGrepResults: () => { throw new Error('capture_failed'); },
    };
    await collector.run('request', async () => {
      await observeRuntimeWork(observer, 'grep', () => {
        expect(captureObservedGrep(observer, [match], 'direct')).toBeUndefined();
        return Promise.resolve([match]);
      });
      expect((await collector.seal('request')).failures).toContain('missing_evidence');
    });
  });

  it('captures an immutable snapshot rather than a later-mutated input', async () => {
    const collector = new OutcomeCollector();
    await collector.run('request', async () => {
      const input = { ...match, submatches: match.submatches.map((item) => ({ ...item })) };
      const evidence = captureObservedGrep(collector, [input], 'direct');
      input.lineText = 'changed after capture';
      input.submatches.length = 0;
      if (evidence === undefined) throw new Error('capture required');
      expect((await validateGrepEvidence(evidence, query, normalize)).status).toBe('valid');
      expect(collector.pendingEvidenceCount).toBe(0);
    });
  });

  it('releases a rejected path snapshot without retaining the unsafe path or source', async () => {
    const collector = new OutcomeCollector();
    await collector.run('request', async () => {
      const evidence = captureObservedGrep(collector, [{ ...match, filePath: '/private/unsafe.ts' }], 'direct');
      if (evidence === undefined) throw new Error('capture required');
      const result = await validateGrepEvidence(evidence, query, () => Promise.reject(new Error('/private/unsafe.ts')));
      expect(result).toMatchObject({ status: 'invalid', reason: 'invalid_result_path' });
      expect(JSON.stringify(result)).not.toContain('/private');
      expect(collector.pendingEvidenceCount).toBe(0);
    });
  });

  it('preserves exact expected multiplicity instead of deduplicating normalized identities', async () => {
    const collector = new OutcomeCollector();
    await collector.run('request', async () => {
      const evidence = captureObservedGrep(collector, [match, match], 'direct');
      if (evidence === undefined) throw new Error('capture required');
      expect(await validateGrepEvidence(evidence, { ...query, expectedMatches: [...query.expectedMatches, ...query.expectedMatches] }, normalize))
        .toMatchObject({ status: 'valid', lineMatchCount: 2, submatchCount: 2 });
    });
  });

  it('rejects missing child evidence even when a grep work promise fulfilled', async () => {
    const collector = new OutcomeCollector();
    await collector.run('request', async () => {
      await observeRuntimeWork(collector, 'grep', () => {
        captureObservedGrep(collector, [], 'direct');
        return Promise.resolve([]);
      });
      expect((await collector.seal('request')).failures).toContain('missing_grep_child');
    });
  });

  it('rejects a missing raw Reindex outcome even after generic successful completion', async () => {
    const collector = new OutcomeCollector();
    await collector.run('request', async () => {
      await observeRuntimeWork(collector, 'reindex', () => Promise.resolve(undefined));
      expect((await collector.seal('request')).failures).toContain('missing_reindex_outcome');
    });
  });

  it('requires the actual successful owner of already-running Reindex work', async () => {
    const collector = new OutcomeCollector();
    const owner = {};
    const result = { startedAt: '2026-10-24T00:00:00.000Z', finishedAt: '2026-10-24T00:00:00.001Z',
      durationMs: 1, reconciliation: { added: 1, modified: 0, deleted: 0, unchanged: 0 }, chunksIndexed: 1 };
    let finish = () => {};
    const pending = new Promise<typeof result>((resolve) => { finish = () => resolve(result); });
    const first = collector.run('owner', () => observeReindex(collector, owner, () => pending));
    await collector.run('borrower', async () => {
      await observeReindex(collector, owner, () => Promise.resolve({ status: 'already_running' }));
      finish();
      await first;
      expect((await collector.seal('borrower')).status).toBe('valid');
    });
  });

  it.each(['already_running', 'incomplete'] as const)('rejects unowned or incomplete Reindex status %s', async (status) => {
    const collector = new OutcomeCollector();
    await collector.run('request', async () => {
      await observeReindex(collector, {}, () => Promise.resolve({ status }));
      expect((await collector.seal('request')).status).toBe('invalid');
    });
  });

  it('rejects corruption outside the final twenty without using final fusion as evidence', async () => {
    const collector = new OutcomeCollector();
    const rows = Array.from({ length: 125 }, (_, index) => ({ ...match, lineNumber: index + 1 }));
    const expectedMatches = Array.from({ length: 125 }, (_, index) => ({ path: 'src/a.ts', line: index + 1,
      lineDigest: sha('needle\n'), submatches: [{ start: 0, end: 6, contentDigest: sha('needle') }] }));
    await collector.run('request', async () => {
      const altered = rows.slice(0, 124);
      expect(altered.slice(0, 20)).toEqual(rows.slice(0, 20));
      const evidence = captureObservedGrep(collector, altered, 'hybrid');
      if (evidence === undefined) throw new Error('capture required');
      expect((await validateGrepEvidence(evidence, { ...query, expectedMatches }, normalize)).status).toBe('invalid');
    });
  });

  it('ignores return ordering while retaining submatch and row multiplicity', async () => {
    const collector = new OutcomeCollector();
    const rows = [match, { ...match, lineNumber: 2 }];
    const expectedMatches = [...query.expectedMatches, ...query.expectedMatches.map((row) => ({ ...row, line: 2 }))];
    const digests: string[] = [];
    for (const [index, matches] of [rows, rows.toReversed()].entries()) {
      await collector.run(`order-${index}`, async () => {
        const evidence = captureObservedGrep(collector, matches, 'direct');
        if (evidence === undefined) throw new Error('capture required');
        const proof = await validateGrepEvidence(evidence, { ...query, expectedMatches }, normalize);
        expect(proof.status).toBe('valid');
        if (proof.digest === undefined) throw new Error('digest required');
        digests.push(proof.digest);
      });
    }
    expect(digests[0]).toBe(digests[1]);
  });

  it('does not admit settled work after its scenario deadline has aborted', async () => {
    const collector = new OutcomeCollector(AbortSignal.abort());
    await collector.run('request', async () => {
      await observeRuntimeWork(collector, 'semantic', () => Promise.resolve([]));
      expect((await collector.seal('request')).failures).toContain('request_aborted');
    });
  });

  it('releases private evidence immediately on scenario cancellation', async () => {
    const controller = new AbortController();
    const collector = new OutcomeCollector(controller.signal);
    await collector.run('request', () => {
      captureObservedGrep(collector, [match], 'direct');
      expect(collector.pendingEvidenceCount).toBe(1);
      controller.abort();
      expect(collector.pendingEvidenceCount).toBe(0);
      expect(captureObservedGrep(collector, [match], 'direct')).toBeUndefined();
      return Promise.resolve();
    });
  });
});
