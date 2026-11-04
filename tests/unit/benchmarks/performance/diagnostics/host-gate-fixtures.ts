import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect } from 'vitest';
import { z } from 'zod';

export type HostProcessSample = Readonly<{
  pid: number;
  startTicks: string;
  ppid: number;
  pgid: number;
  sid: number;
  cpuTicks: number;
  uid: number;
  executable: string;
  cgroupClass: 'user_session' | 'service' | 'root' | 'unknown';
}>;

export type HostSnapshot = Readonly<{
  capturedAtUtc: string;
  monotonicNs: string;
  selfPid: number;
  logicalCpuCount: number;
  affinityCpuCount: number;
  cpusetCpuCount: number;
  quotaCpuCapacity: number | null;
  aggregateCpuTicks: number;
  throttledPeriods: number;
  cpuPressure: Readonly<{
    host: Readonly<{ someAvg60: number; fullAvg60: number }>;
    cgroup: Readonly<{ someAvg60: number; fullAvg60: number }>;
  }>;
  memoryPressure: Readonly<{
    host: Readonly<{ someAvg60: number; fullAvg60: number }>;
    cgroup: Readonly<{ someAvg60: number; fullAvg60: number }>;
  }>;
  ioPressure: Readonly<{
    host: Readonly<{ someAvg60: number; fullAvg60: number }>;
    cgroup: Readonly<{ someAvg60: number; fullAvg60: number }>;
  }>;
  memoryAvailableBytes: number;
  swapUsedBytes: number;
  cgroupMemoryCurrentBytes: number;
  cgroupMemoryMaxBytes: number | null;
  cgroupMemoryHighBytes: number | null;
  memoryEvents: Readonly<{ high: number; max: number; oom: number; oomKill: number }>;
  cgroupSwapCurrentBytes: number;
  ioReadBytes: number;
  ioWriteBytes: number;
  scratchFreeBytes: number;
  processEnumerationComplete: boolean;
  processes: readonly HostProcessSample[];
}>;

export type FixtureSize = Readonly<{
  files: number;
  utf8Bytes: number;
  declarations: number;
  imports: number;
  legacyRows: number;
  structuredRows: number;
}>;

export type HostGateResult = Readonly<{
  status: 'PASS' | 'HOST_BUSY_STOP' | 'HOST_GATE_INDETERMINATE';
  reasonCodes: readonly string[];
  missingInputs?: readonly string[];
  requiredScratchBytes?: number;
  scratchFreeBytes?: number;
  effectiveCpuCapacity?: number;
}>;

export type HostGateModule = Readonly<{
  evaluateHostGate: (
    snapshots: unknown,
    smallReport: unknown,
    mediumFixtureSize: unknown,
    currentMonotonicNs?: string,
  ) => HostGateResult;
}>;

export const GiB = 1_073_741_824;
export const smallDigest = 'e'.repeat(64);
export const mediumFixtureSize: FixtureSize = {
  files: 1_000,
  utf8Bytes: 1_084_640,
  declarations: 10_000,
  imports: 1_000,
  legacyRows: 11_000,
  structuredRows: 10_000,
};
export const smallReport = {
  status: 'complete',
  options: { profile: 'small' },
  workload: {
    recipeVersion: 'retrieval-performance-v1', digest: smallDigest,
    files: 100, utf8Bytes: 111_740, declarations: 1_000, imports: 100,
    legacyRows: 1_100, structuredRows: 1_000, provider: 'test',
    model: 'nexus-synthetic-sha256-v1', dimensions: 128, maxChunkChars: 4096,
    storage: { metadata: 'sqlite', vectors: 'lancedb', isolation: 'owned_state_outside_source', locations: 'redacted' },
  },
  scenarios: [{
    id: 'cold_initial_index', status: 'valid', fixtureDigest: smallDigest,
    artifactBytes: { totalBytes: 11_134_462, measurement: 'apparent_bytes', phase: 'settled' },
  }],
};

function isHostGateModule(value: unknown): value is HostGateModule {
  return typeof value === 'object' && value !== null
    && 'evaluateHostGate' in value && typeof value.evaluateHostGate === 'function';
}

export async function loadHostGate(): Promise<HostGateModule> {
  const moduleUrl = pathToFileURL(resolve(process.cwd(), 'scripts/performance-diagnostics/host-gate.mjs')).href;
  let loaded: unknown;
  try {
    loaded = await import(moduleUrl);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    loaded = undefined;
  }
  expect(isHostGateModule(loaded)).toBe(true);
  if (!isHostGateModule(loaded)) throw new Error('host_gate_module_missing');
  return loaded;
}

export function snapshot(monotonicNs: string, overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    capturedAtUtc: '2026-01-01T00:00:00.000Z',
    monotonicNs,
    selfPid: 900,
    logicalCpuCount: 16,
    affinityCpuCount: 8,
    cpusetCpuCount: 8,
    quotaCpuCapacity: null,
    aggregateCpuTicks: Number((BigInt(monotonicNs) / 30_000_000_000n) * 48_000n),
    throttledPeriods: 0,
    cpuPressure: {
      host: { someAvg60: 0.5, fullAvg60: 0.01 },
      cgroup: { someAvg60: 0.5, fullAvg60: 0.01 },
    },
    memoryPressure: {
      host: { someAvg60: 0, fullAvg60: 0 },
      cgroup: { someAvg60: 0, fullAvg60: 0 },
    },
    ioPressure: {
      host: { someAvg60: 0, fullAvg60: 0 },
      cgroup: { someAvg60: 0, fullAvg60: 0 },
    },
    memoryAvailableBytes: 8 * GiB,
    swapUsedBytes: GiB,
    cgroupMemoryCurrentBytes: GiB,
    cgroupMemoryMaxBytes: null,
    cgroupMemoryHighBytes: null,
    memoryEvents: { high: 0, max: 0, oom: 0, oomKill: 0 },
    cgroupSwapCurrentBytes: 0,
    ioReadBytes: 1_024,
    ioWriteBytes: 2_048,
    scratchFreeBytes: 1_298_600_344,
    processEnumerationComplete: true,
    processes: [
      { pid: 100, startTicks: '1000', ppid: 1, pgid: 100, sid: 100, cpuTicks: 100, uid: 1000, executable: 'editor', cgroupClass: 'user_session' },
      { pid: 900, startTicks: '9000', ppid: 1, pgid: 900, sid: 900, cpuTicks: 100, uid: 1000, executable: 'host-gate', cgroupClass: 'user_session' },
    ],
    ...overrides,
  };
}

export const validSnapshots = (): readonly HostSnapshot[] => [
  snapshot('0'), snapshot('30000000000'), snapshot('60000000000'),
];

export const resultSchema = z.object({
  status: z.enum(['PASS', 'HOST_BUSY_STOP', 'HOST_GATE_INDETERMINATE']),
  reasonCodes: z.array(z.string()),
  missingInputs: z.array(z.string()).optional(),
  requiredScratchBytes: z.number().optional(),
  scratchFreeBytes: z.number().optional(),
  effectiveCpuCapacity: z.number().optional(),
}).strict();
