import type { ProcessCgroupClass, PressureSample } from './host-snapshot-parsers.mjs';

export type HostProcessSample = Readonly<{
  pid: number;
  startTicks: string;
  ppid: number;
  pgid: number;
  sid: number;
  cpuTicks: number;
  uid: number;
  executable: string;
  cgroupClass: ProcessCgroupClass;
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
  cpuPressure: Readonly<{ host: PressureSample; cgroup: PressureSample }>;
  memoryPressure: Readonly<{ host: PressureSample; cgroup: PressureSample }>;
  ioPressure: Readonly<{ host: PressureSample; cgroup: PressureSample }>;
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

export type HostSnapshotOptions = Readonly<{
  procRoot: string;
  sysRoot: string;
  scratchPath: string;
  selfPid?: number;
}>;

export type HostSnapshotServices = Readonly<{
  selfPid?: number;
  now?: () => Readonly<{ capturedAtUtc: string; monotonicNs: string }>;
  readText?: (path: string) => Promise<string>;
  readDirectory?: (path: string) => Promise<readonly string[]>;
  availableBytes?: (path: string) => Promise<number>;
}>;

export class HostSnapshotUnavailableError extends Error {
  readonly code: 'host_snapshot_unavailable';
  readonly inputId: string;
  constructor(inputId: string);
}

export function collectHostSnapshot(
  options: HostSnapshotOptions,
  services?: HostSnapshotServices,
): Promise<HostSnapshot>;
