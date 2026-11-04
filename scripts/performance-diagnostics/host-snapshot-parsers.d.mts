export type PressureSample = Readonly<{ someAvg60: number; fullAvg60: number }>;
export type ProcessStat = Readonly<{
  state: string;
  ppid: number;
  pgid: number;
  sid: number;
  cpuTicks: number;
  startTicks: string;
}>;
export type ProcessCgroupClass = 'user_session' | 'service' | 'root' | 'unknown';

export function parseProcStat(contents: string): ProcessStat;
export function parseAggregateCpuStat(contents: string): Readonly<{ logicalCpuCount: number; aggregateCpuTicks: number }>;
export function parseCpuSet(contents: string): number;
export function parseCpuMax(contents: string): number | null;
export function parseCpuThrottledPeriods(contents: string): number;
export function parseMemoryValue(contents: string, code: string): number | null;
export function parseMemInfo(contents: string, key: 'MemAvailable' | 'SwapTotal' | 'SwapFree'): number;
export function parseMemoryEvents(contents: string): Readonly<{ high: number; max: number; oom: number; oomKill: number }>;
export function parsePressure(contents: string): PressureSample;
export function parseIoStats(contents: string): Readonly<{ readBytes: number; writeBytes: number }>;
export function parseUnifiedCgroupPath(contents: string): string;
export function classifyCgroup(cgroupPath: string): ProcessCgroupClass;
export function parseUid(contents: string): number;
export function sanitizeExecutable(contents: string): string;
