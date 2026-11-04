import { expect, it } from 'vitest';
import { loadHostGate, mediumFixtureSize, smallReport, snapshot, validSnapshots } from './host-gate-fixtures.js';
import type { HostSnapshot } from './host-gate-fixtures.js';

async function evaluate(snapshots: readonly HostSnapshot[]) {
  const hostGate = await loadHostGate();
  return hostGate.evaluateHostGate(snapshots, smallReport, mediumFixtureSize);
}

it('stops_when_host_or_cgroup_cpu_psi_exceeds_the_proposed_ceiling', async () => {
  const snapshots = validSnapshots().map((sample, index) => index >= 1
    ? { ...sample, cpuPressure: { ...sample.cpuPressure, host: { someAvg60: 1.01, fullAvg60: 0 } } }
    : sample);

  const result = await evaluate(snapshots);

  expect(result.status).toBe('HOST_BUSY_STOP');
  expect(result.reasonCodes).toContain('cpu_pressure');
});

it('stops_when_cpu_full_psi_exceeds_one_tenth_percent', async () => {
  const snapshots = validSnapshots().map((sample, index) => index === 1
    ? { ...sample, cpuPressure: { ...sample.cpuPressure, cgroup: { someAvg60: 0, fullAvg60: 0.11 } } }
    : sample);

  const result = await evaluate(snapshots);

  expect(result.status).toBe('HOST_BUSY_STOP');
  expect(result.reasonCodes).toContain('cpu_pressure');
});

it('stops_when_effective_cpu_capacity_is_below_four', async () => {
  const snapshots = validSnapshots().map((sample, index) => index === 1
    ? { ...sample, affinityCpuCount: 3 }
    : sample);

  const result = await evaluate(snapshots);

  expect(result.status).toBe('HOST_BUSY_STOP');
  expect(result.reasonCodes).toContain('cpu_capacity_low');
});

it('stops_when_finite_cpu_quota_is_below_four', async () => {
  const snapshots = validSnapshots().map((sample, index) => index === 1
    ? { ...sample, quotaCpuCapacity: 3.5 }
    : sample);

  const result = await evaluate(snapshots);

  expect(result.status).toBe('HOST_BUSY_STOP');
  expect(result.reasonCodes).toContain('cpu_capacity_low');
});

it('stops_when_cgroup_cpu_throttling_or_memory_events_increase', async () => {
  const snapshots = validSnapshots().map((sample, index) => index >= 1
    ? { ...sample, throttledPeriods: 1, memoryEvents: { ...sample.memoryEvents, high: 1 } }
    : sample);

  const result = await evaluate(snapshots);

  expect(result.status).toBe('HOST_BUSY_STOP');
  expect(result.reasonCodes).toContain('cpu_throttled');
  expect(result.reasonCodes).toContain('memory_event_increased');
});

it.each(['high', 'max', 'oom', 'oomKill'] as const)(
  'stops_when_the_cgroup_memory_%s_counter_increases', async (counter) => {
    const snapshots = validSnapshots().map((sample, index) => index >= 1
      ? { ...sample, memoryEvents: { ...sample.memoryEvents, [counter]: 1 } }
      : sample);

    const result = await evaluate(snapshots);

    expect(result.status).toBe('HOST_BUSY_STOP');
    expect(result.reasonCodes).toContain('memory_event_increased');
  },
);

it('stops_when_host_or_finite_cgroup_memory_headroom_is_below_four_gibibytes', async () => {
  const snapshots = validSnapshots().map((sample, index) => index === 1
    ? {
      ...sample,
      memoryAvailableBytes: 3 * 1_073_741_824,
      cgroupMemoryCurrentBytes: 5 * 1_073_741_824,
      cgroupMemoryMaxBytes: 8 * 1_073_741_824,
    }
    : sample);

  const result = await evaluate(snapshots);

  expect(result.status).toBe('HOST_BUSY_STOP');
  expect(result.reasonCodes).toContain('host_memory_low');
  expect(result.reasonCodes).toContain('cgroup_memory_low');
});

it('stops_when_host_or_cgroup_swap_growth_exceeds_the_approved_limit', async () => {
  const snapshots = validSnapshots().map((sample, index) => index === 2
    ? { ...sample, swapUsedBytes: sample.swapUsedBytes + 256 * 1_048_576 + 1 }
    : sample);

  const result = await evaluate(snapshots);

  expect(result.status).toBe('HOST_BUSY_STOP');
  expect(result.reasonCodes).toContain('swap_growth');
});

it('stops_when_cgroup_swap_grows_above_the_approved_limit', async () => {
  const snapshots = validSnapshots().map((sample, index) => index === 2
    ? { ...sample, cgroupSwapCurrentBytes: 256 * 1_048_576 + 1 }
    : sample);

  const result = await evaluate(snapshots);

  expect(result.status).toBe('HOST_BUSY_STOP');
  expect(result.reasonCodes).toContain('swap_growth');
});

it('treats_decreasing_swap_usage_gauges_as_zero_growth', async () => {
  const snapshots = validSnapshots().map((sample, index) => ({
    ...sample,
    swapUsedBytes: sample.swapUsedBytes - index * 1_048_576,
    cgroupSwapCurrentBytes: 3 * 1_048_576 - index * 1_048_576,
  }));

  const result = await evaluate(snapshots);

  expect(result.status).toBe('PASS');
  expect(result.reasonCodes).not.toContain('swap_growth');
});

it('stops_on_peak_swap_growth_even_when_usage_falls_before_the_last_snapshot', async () => {
  const snapshots = validSnapshots().map((sample, index) => index === 1
    ? { ...sample, swapUsedBytes: sample.swapUsedBytes + 300 * 1_048_576 }
    : sample);

  const result = await evaluate(snapshots);

  expect(result.status).toBe('HOST_BUSY_STOP');
  expect(result.reasonCodes).toContain('swap_growth');
});

it('stops_when_scratch_free_space_is_one_byte_below_the_estimate', async () => {
  const snapshots = validSnapshots().map((sample, index) => index === 2
    ? { ...sample, scratchFreeBytes: 1_298_600_343 }
    : sample);

  const result = await evaluate(snapshots);

  expect(result.status).toBe('HOST_BUSY_STOP');
  expect(result.reasonCodes).toContain('scratch_low');
});

it('requires_two_consecutive_intervals_for_the_single_process_cpu_stop', async () => {
  const snapshots = [
    snapshot('0'),
    snapshot('30000000000', { processes: [
      { pid: 100, startTicks: '1000', ppid: 1, pgid: 100, sid: 100, cpuTicks: 2_200, uid: 1000, executable: 'editor', cgroupClass: 'user_session' },
      { pid: 900, startTicks: '9000', ppid: 1, pgid: 900, sid: 900, cpuTicks: 100, uid: 1000, executable: 'host-gate', cgroupClass: 'user_session' },
    ] }),
    snapshot('60000000000', { processes: [
      { pid: 100, startTicks: '1000', ppid: 1, pgid: 100, sid: 100, cpuTicks: 2_300, uid: 1000, executable: 'editor', cgroupClass: 'user_session' },
      { pid: 900, startTicks: '9000', ppid: 1, pgid: 900, sid: 900, cpuTicks: 100, uid: 1000, executable: 'host-gate', cgroupClass: 'user_session' },
    ] }),
  ];

  const result = await evaluate(snapshots);

  expect(result.status).toBe('PASS');
  expect(result.reasonCodes).not.toContain('process_cpu_busy');
});

it('stops_when_unrelated_process_cpu_averages_above_one_core', async () => {
  const snapshots = [
    snapshot('0', { processes: [
      { pid: 100, startTicks: '1000', ppid: 1, pgid: 100, sid: 100, cpuTicks: 100, uid: 1000, executable: 'editor-a', cgroupClass: 'user_session' },
      { pid: 200, startTicks: '2000', ppid: 1, pgid: 200, sid: 200, cpuTicks: 100, uid: 1000, executable: 'editor-b', cgroupClass: 'user_session' },
      { pid: 900, startTicks: '9000', ppid: 1, pgid: 900, sid: 900, cpuTicks: 100, uid: 1000, executable: 'host-gate', cgroupClass: 'user_session' },
    ] }),
    snapshot('30000000000', { processes: [
      { pid: 100, startTicks: '1000', ppid: 1, pgid: 100, sid: 100, cpuTicks: 1_900, uid: 1000, executable: 'editor-a', cgroupClass: 'user_session' },
      { pid: 200, startTicks: '2000', ppid: 1, pgid: 200, sid: 200, cpuTicks: 1_900, uid: 1000, executable: 'editor-b', cgroupClass: 'user_session' },
      { pid: 900, startTicks: '9000', ppid: 1, pgid: 900, sid: 900, cpuTicks: 100, uid: 1000, executable: 'host-gate', cgroupClass: 'user_session' },
    ] }),
    snapshot('60000000000', { processes: [
      { pid: 100, startTicks: '1000', ppid: 1, pgid: 100, sid: 100, cpuTicks: 3_700, uid: 1000, executable: 'editor-a', cgroupClass: 'user_session' },
      { pid: 200, startTicks: '2000', ppid: 1, pgid: 200, sid: 200, cpuTicks: 3_700, uid: 1000, executable: 'editor-b', cgroupClass: 'user_session' },
      { pid: 900, startTicks: '9000', ppid: 1, pgid: 900, sid: 900, cpuTicks: 100, uid: 1000, executable: 'host-gate', cgroupClass: 'user_session' },
    ] }),
  ];

  const result = await evaluate(snapshots);

  expect(result.status).toBe('HOST_BUSY_STOP');
  expect(result.reasonCodes).toContain('aggregate_process_cpu_busy');
});

it('does_not_attribute_cpu_delta_across_pid_reuse_to_the_previous_process', async () => {
  const snapshots = [
    snapshot('0'),
    snapshot('30000000000', { processes: [
      { pid: 100, startTicks: '2000', ppid: 1, pgid: 100, sid: 100, cpuTicks: 2_200, uid: 1000, executable: 'new-editor', cgroupClass: 'user_session' },
      { pid: 900, startTicks: '9000', ppid: 1, pgid: 900, sid: 900, cpuTicks: 100, uid: 1000, executable: 'host-gate', cgroupClass: 'user_session' },
    ] }),
    snapshot('60000000000', { processes: [
      { pid: 100, startTicks: '2000', ppid: 1, pgid: 100, sid: 100, cpuTicks: 2_300, uid: 1000, executable: 'new-editor', cgroupClass: 'user_session' },
      { pid: 900, startTicks: '9000', ppid: 1, pgid: 900, sid: 900, cpuTicks: 100, uid: 1000, executable: 'host-gate', cgroupClass: 'user_session' },
    ] }),
  ];

  const result = await evaluate(snapshots);

  expect(result.status).toBe('PASS');
  expect(result.reasonCodes).not.toContain('process_cpu_busy');
});

it('returns_indeterminate_when_aggregate_cpu_ticks_regress', async () => {
  const snapshots = validSnapshots().map((sample, index) => index === 2
    ? { ...sample, aggregateCpuTicks: 1 }
    : sample);

  const result = await evaluate(snapshots);

  expect(result.status).toBe('HOST_GATE_INDETERMINATE');
  expect(result.reasonCodes).toContain('process_cpu_counter_regressed');
});
