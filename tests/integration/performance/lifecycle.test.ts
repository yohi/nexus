import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureReadiness } from '../../benchmarks/performance/readiness.js';
import * as audits from '../../benchmarks/performance/audit.js';
import * as probes from '../../benchmarks/performance/readiness-probe.js';
import * as settlement from '../../benchmarks/performance/readiness-settlement.js';
import { systemClock } from '../../benchmarks/performance/clock.js';
import { ControlledClock, createLifecycleFixture } from './lifecycle-fixture.js';

const fixtures: Awaited<ReturnType<typeof createLifecycleFixture>>[] = [];
async function fixture() {
  const value = await createLifecycleFixture();
  fixtures.push(value);
  return value;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const value of fixtures.splice(0)) await value.dispose();
});
const signal = (): AbortSignal => new AbortController().signal;

describe('runtime construction to audited readiness', () => {
  it('captures actual cold and reopened no-op warm startup from fresh uninvoked factories', async () => {
    const current = await fixture();
    const cold = await captureReadiness(current.factory, current.collector, current.manifest, systemClock, signal());
    expect(cold.status).toBe('valid');
    if (cold.status !== 'valid') throw new Error('cold readiness required');
    expect(cold.record.cacheAccounting.outcomes.miss).toBeGreaterThan(0);
    await cold.assembly.runtime.close();
    const warm = await captureReadiness(current.factory, current.collector, current.manifest, systemClock, signal());
    expect(warm.status).toBe('valid');
    if (warm.status === 'valid') expect(warm.record.cacheAccounting.providerCalls).toBe(0);
  });

  it('includes construction37 + initialize23 + settlement11 while audit5 and probe3 remain separate', async () => {
    const current = await fixture();
    const clock = new ControlledClock();
    const audit = audits.auditRuntime;
    const probe = probes.probeReadiness;
    const settle = settlement.settleReadiness;
    vi.spyOn(audits, 'auditRuntime').mockImplementation(async (...args) => {
      const result = await audit(...args); clock.advance(5); return result;
    });
    vi.spyOn(probes, 'probeReadiness').mockImplementation(async (...args) => {
      const result = await probe(...args); clock.advance(3); return result;
    });
    vi.spyOn(settlement, 'settleReadiness').mockImplementation(async (...args) => {
      await settle(...args); clock.advance(11);
    });
    const calls: number[] = [];
    const factory = async (signal: AbortSignal) => {
      calls.push(clock.now()); clock.advance(37);
      const assembly = await current.factory(signal);
      const initialize = assembly.runtime.initialize.bind(assembly.runtime);
      let initialized = false;
      assembly.runtime.initialize = async () => {
        await initialize();
        if (!initialized) { clock.advance(23); initialized = true; }
      };
      return assembly;
    };
    expect(calls).toEqual([]);
    const captured = await captureReadiness(factory, current.collector, current.manifest, clock, signal());
    expect(captured.status).toBe('valid');
    expect(calls).toEqual([0]);
    if (captured.status === 'valid') expect(captured.record.endpoints).toMatchObject({
      runtime_ready_ms: 71, audit_validation_ms: 5, retrieval_probe_ms: 3, audited_ready_ms: 79,
    });
  });

  it('records constructor rejection as invalid construction evidence without an assembly', async () => {
    const current = await fixture();
    const clock = new ControlledClock();
    const factory = () => { clock.advance(37); return Promise.reject(new Error('/private/constructor-failed')); };
    const captured = await captureReadiness(factory, current.collector, current.manifest, clock, signal());
    expect(captured).toMatchObject({ status: 'invalid', record: { phase: 'construction', elapsedMs: 37 } });
    expect(captured).not.toHaveProperty('assembly');
    expect(JSON.stringify(captured)).not.toContain('/private');
  });

  it('changes runtime readiness only for construction delays, not audit or probe delays', async () => {
    const audit = audits.auditRuntime;
    const probe = probes.probeReadiness;
    const readyTimes: number[] = [];
    const auditedTimes: number[] = [];
    for (const delays of [{ construction: 37, audit: 0, probe: 0 },
      { construction: 37, audit: 50, probe: 30 }, { construction: 74, audit: 0, probe: 0 }]) {
      const current = await fixture();
      const clock = new ControlledClock();
      vi.spyOn(audits, 'auditRuntime').mockImplementation(async (...args) => {
        const result = await audit(...args); clock.advance(delays.audit); return result;
      });
      vi.spyOn(probes, 'probeReadiness').mockImplementation(async (...args) => {
        const result = await probe(...args); clock.advance(delays.probe); return result;
      });
      const factory = (signal: AbortSignal) => { clock.advance(delays.construction); return current.factory(signal); };
      const captured = await captureReadiness(factory, current.collector, current.manifest, clock, signal());
      expect(captured.status).toBe('valid');
      if (captured.status === 'valid') {
        readyTimes.push(captured.record.endpoints.runtime_ready_ms);
        auditedTimes.push(captured.record.endpoints.audited_ready_ms);
      }
    }
    expect(readyTimes).toEqual([37, 37, 74]);
    expect(auditedTimes).toEqual([37, 117, 74]);
  });

  it.each(['audit', 'probe'] as const)('invalidates candidate timings and closes resources on %s failure', async (phase) => {
    const current = await fixture();
    if (phase === 'audit') vi.spyOn(audits, 'auditRuntime').mockRejectedValueOnce(new Error(current.root));
    else vi.spyOn(probes, 'probeReadiness').mockRejectedValueOnce(new Error(current.root));
    const captured = await captureReadiness(current.factory, current.collector, current.manifest, systemClock, signal());
    expect(captured).toMatchObject({ status: 'invalid', record: { phase } });
    expect(captured).not.toHaveProperty('assembly');
    expect(JSON.stringify(captured)).not.toContain(current.root);
    const reopened = await current.factory(signal());
    await reopened.runtime.close();
  });

  it('rejects a manifest missing an indexed file rather than trusting a successful probe', async () => {
    const current = await fixture();
    const manifest = { ...current.manifest, files: current.manifest.files.slice(1) };
    const captured = await captureReadiness(current.factory, current.collector, manifest, systemClock, signal());
    expect(captured.status).toBe('invalid');
  });

  it('rejects state mutation after candidate completion even if the file audit itself succeeds', async () => {
    const current = await fixture();
    const probe = probes.probeReadiness;
    vi.spyOn(probes, 'probeReadiness').mockImplementationOnce(async (assembly, ...args) => {
      const result = await probe(assembly, ...args);
      assembly.options.eventQueue?.enterPostScanMode();
      return result;
    });
    const captured = await captureReadiness(current.factory, current.collector, current.manifest, systemClock, signal());
    expect(captured.status).toBe('invalid');
  });
});
