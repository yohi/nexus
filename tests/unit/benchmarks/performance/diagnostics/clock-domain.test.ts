import { describe, expect, it } from 'vitest';

import { calibrateClockMapping, parseClockPingWindow, type ClockPing } from '../../../../benchmarks/performance/diagnostics/clock-domain.js';

function pings(offsetNs: bigint, rttNs: bigint): readonly ClockPing[] {
  return [1n, 2n, 3n].map((sample) => {
    const childNs = sample * 1_000n;
    const parentSendNs = childNs + offsetNs;
    return { parentSendNs, childMonotonicNs: childNs, parentReceiveNs: parentSendNs + rttNs };
  });
}

function window(bootId: string, samples: readonly ClockPing[], parentClockSource = 'time.clock_gettime_ns:CLOCK_MONOTONIC') {
  return {
    bootId,
    parentClockSource,
    parentResolutionNs: 1n,
    childClockSource: 'process.hrtime.bigint',
    childResolutionNs: 1n,
    pings: samples,
  };
}

describe('clock domain calibration', () => {
  it('parses decimal clock samples at the process boundary into bigint values', () => {
    const parsed = parseClockPingWindow({
      bootId: 'boot-a',
      parentClockSource: 'time.clock_gettime_ns:CLOCK_MONOTONIC',
      parentResolutionNs: '1',
      childClockSource: 'process.hrtime.bigint',
      childResolutionNs: '1',
      pings: [{ parentSendNs: '100', childMonotonicNs: '90', parentReceiveNs: '120' },
        { parentSendNs: '200', childMonotonicNs: '190', parentReceiveNs: '220' },
        { parentSendNs: '300', childMonotonicNs: '290', parentReceiveNs: '320' }],
    });
    expect(parsed.pings[0]?.childMonotonicNs).toBe(90n);
    expect(() => parseClockPingWindow({ bootId: 'boot-a', pings: [] })).toThrow();
  });

  it('aligns start and end intervals when they overlap within the uncertainty budget', () => {
    const result = calibrateClockMapping({
      start: window('boot-a', pings(100n, 1_000n)),
      end: window('boot-a', pings(101n, 1_000n)),
      parentClockDomain: 'linux_clock_monotonic_ns',
      childClockDomain: 'process_local_monotonic',
    });

    expect(result.status).toBe('aligned');
    if (result.status === 'aligned') expect(result.offsetConvention).toBe('parent_minus_child');
  });

  it('accepts the exact combined 10 ms uncertainty boundary', () => {
    const result = calibrateClockMapping({
      start: window('boot-a', pings(0n, 4_999_999n)),
      end: window('boot-a', pings(0n, 4_999_999n)),
      parentClockDomain: 'linux_clock_monotonic_ns',
      childClockDomain: 'process_local_monotonic',
    });

    expect(result.status).toBe('aligned');
    if (result.status === 'aligned') expect(result.combinedUncertaintyNs).toBe('10000000');
  });

  it('rejects combined uncertainty above 10 ms', () => {
    const result = calibrateClockMapping({
      start: window('boot-a', pings(0n, 5_000_001n)),
      end: window('boot-a', pings(0n, 5_000_001n)),
      parentClockDomain: 'linux_clock_monotonic_ns',
      childClockDomain: 'process_local_monotonic',
    });

    expect(result).toMatchObject({ status: 'not_correlatable', reasonCode: 'uncertainty_exceeded' });
  });

  it('rejects start and end offset intervals that do not overlap', () => {
    const result = calibrateClockMapping({
      start: window('boot-a', pings(0n, 1_000n)),
      end: window('boot-a', pings(10_000n, 1_000n)),
      parentClockDomain: 'linux_clock_monotonic_ns',
      childClockDomain: 'process_local_monotonic',
    });

    expect(result).toMatchObject({ status: 'not_correlatable', reasonCode: 'offset_intervals_do_not_overlap' });
  });

  it('rejects clock-domain mismatch and host boot changes', () => {
    const domainMismatch = calibrateClockMapping({
      start: window('boot-a', pings(0n, 1_000n)),
      end: window('boot-a', pings(0n, 1_000n)),
      parentClockDomain: 'process_local_monotonic',
      childClockDomain: 'process_local_monotonic',
    });
    const bootMismatch = calibrateClockMapping({
      start: window('boot-a', pings(0n, 1_000n)),
      end: window('boot-b', pings(0n, 1_000n)),
      parentClockDomain: 'linux_clock_monotonic_ns',
      childClockDomain: 'process_local_monotonic',
    });

    expect(domainMismatch).toMatchObject({ status: 'not_correlatable', reasonCode: 'clock_domain_mismatch' });
    expect(bootMismatch).toMatchObject({ status: 'not_correlatable', reasonCode: 'boot_id_changed' });
  });

  it('rejects invalid and non-overlapping minimum-RTT ping evidence', () => {
    const invalid = calibrateClockMapping({
      start: window('boot-a', [{ parentSendNs: 2n, childMonotonicNs: 1n, parentReceiveNs: 0n }]),
      end: window('boot-a', pings(0n, 1_000n)),
      parentClockDomain: 'linux_clock_monotonic_ns',
      childClockDomain: 'process_local_monotonic',
    });
    const noMinimumIntersection = calibrateClockMapping({
      start: window('boot-a', [
        { parentSendNs: 0n, childMonotonicNs: 0n, parentReceiveNs: 1n },
        { parentSendNs: 10n, childMonotonicNs: 0n, parentReceiveNs: 11n },
        { parentSendNs: 20n, childMonotonicNs: 0n, parentReceiveNs: 30n },
      ]),
      end: window('boot-a', pings(0n, 1_000n)),
      parentClockDomain: 'linux_clock_monotonic_ns',
      childClockDomain: 'process_local_monotonic',
    });

    expect(invalid).toMatchObject({ status: 'not_correlatable', reasonCode: 'invalid_ping' });
    expect(noMinimumIntersection).toMatchObject({ status: 'not_correlatable', reasonCode: 'offset_intervals_do_not_overlap' });
  });

  it('rejects changed clock source metadata between calibration windows', () => {
    const result = calibrateClockMapping({
      start: window('boot-a', pings(0n, 1_000n)),
      end: window('boot-a', pings(0n, 1_000n), 'time.clock_gettime_ns:CLOCK_BOOTTIME'),
      parentClockDomain: 'linux_clock_monotonic_ns',
      childClockDomain: 'process_local_monotonic',
    });
    expect(result).toMatchObject({ status: 'not_correlatable', reasonCode: 'clock_source_changed' });
  });
});
