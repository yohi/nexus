import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { z } from 'zod';

type SnapshotServices = Readonly<{
  now: () => Readonly<{ capturedAtUtc: string; monotonicNs: string }>;
  readText: (path: string) => Promise<string>;
  readDirectory: (path: string) => Promise<readonly string[]>;
  availableBytes: (path: string) => Promise<number>;
}>;
type SnapshotOptions = Readonly<{ procRoot: string; sysRoot: string; scratchPath: string; selfPid: number }>;
type SnapshotModule = Readonly<{
  collectHostSnapshot: (options: SnapshotOptions, services: SnapshotServices) => Promise<unknown>;
  HostSnapshotUnavailableError: new (inputId: string) => Error & Readonly<{ code: string; inputId: string }>;
}>;

function isSnapshotModule(value: unknown): value is SnapshotModule {
  return typeof value === 'object' && value !== null
    && 'collectHostSnapshot' in value && typeof value.collectHostSnapshot === 'function'
    && 'HostSnapshotUnavailableError' in value && typeof value.HostSnapshotUnavailableError === 'function';
}

async function loadSnapshotModule(): Promise<SnapshotModule> {
  const moduleUrl = pathToFileURL(`${process.cwd()}/scripts/performance-diagnostics/host-snapshot.mjs`).href;
  let loaded: unknown;
  try {
    loaded = await import(moduleUrl);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    loaded = undefined;
  }
  expect(isSnapshotModule(loaded)).toBe(true);
  if (!isSnapshotModule(loaded)) throw new Error('host_snapshot_module_missing');
  return loaded;
}

function procStatLine(pid: number, comm: string, startTicks: number, cpuTicks: number): string {
  const fields = Array.from({ length: 20 }, () => '0');
  fields[0] = 'S';
  fields[1] = '1';
  fields[2] = String(pid);
  fields[3] = String(pid);
  fields[11] = String(cpuTicks);
  fields[12] = '0';
  fields[19] = String(startTicks);
  return `${pid} (${comm}) ${fields.join(' ')}`;
}

function fixtureFilesystem() {
  const procRoot = '/fixture/proc';
  const sysRoot = '/fixture/sys';
  const scratchPath = '/fixture/scratch';
  const cgroupPath = '/user.slice/user-1000.slice/session-42.scope';
  const cgroupRoot = `${sysRoot}/fs/cgroup${cgroupPath}`;
  const contents = new Map<string, string>([
    [`${procRoot}/stat`, 'cpu 100 10 20 1000 5 2 3 4 0 0\ncpu0 50 5 10 500 2 1 1 2\ncpu1 50 5 10 500 3 1 2 2\n'],
    [`${procRoot}/meminfo`, 'MemAvailable: 8388608 kB\nSwapTotal: 1048576 kB\nSwapFree: 524288 kB\n'],
    [`${procRoot}/self/cgroup`, `0::${cgroupPath}\n`],
    [`${procRoot}/self/status`, 'Uid:\t1000\t1000\t1000\t1000\nCpus_allowed_list:\t0-1\n'],
    [`${procRoot}/100/stat`, procStatLine(100, 'editor (test)', 1234, 168)],
    [`${procRoot}/100/status`, 'Uid:\t1000\t1000\t1000\t1000\n'],
    [`${procRoot}/100/comm`, 'editor (test)\n'],
    [`${procRoot}/100/cgroup`, `0::${cgroupPath}\n`],
    [`${procRoot}/900/stat`, procStatLine(900, 'host-gate', 9876, 25)],
    [`${procRoot}/900/status`, 'Uid:\t1000\t1000\t1000\t1000\nCpus_allowed_list:\t0-1\n'],
    [`${procRoot}/900/comm`, 'host-gate\n'],
    [`${procRoot}/900/cgroup`, `0::${cgroupPath}\n`],
    [`${procRoot}/pressure/cpu`, 'some avg10=0.00 avg60=0.50 avg300=0.25 total=1000\nfull avg10=0.00 avg60=0.01 avg300=0.00 total=10\n'],
    [`${procRoot}/pressure/memory`, 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n'],
    [`${procRoot}/pressure/io`, 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n'],
    [`${cgroupRoot}/cpu.max`, 'max 100000\n'],
    [`${cgroupRoot}/cpu.stat`, 'usage_usec 100\nnr_periods 20\nnr_throttled 0\nthrottled_usec 0\n'],
    [`${cgroupRoot}/cpuset.cpus.effective`, '0-1\n'],
    [`${cgroupRoot}/memory.current`, '1073741824\n'],
    [`${cgroupRoot}/memory.max`, 'max\n'],
    [`${cgroupRoot}/memory.high`, 'max\n'],
    [`${cgroupRoot}/memory.events`, 'low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\n'],
    [`${cgroupRoot}/memory.swap.current`, '0\n'],
    [`${cgroupRoot}/cpu.pressure`, 'some avg10=0.00 avg60=0.50 avg300=0.25 total=1000\nfull avg10=0.00 avg60=0.01 avg300=0.00 total=10\n'],
    [`${cgroupRoot}/memory.pressure`, 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n'],
    [`${cgroupRoot}/io.pressure`, 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n'],
    [`${cgroupRoot}/io.stat`, '8:0 rbytes=1024 wbytes=2048 rios=1 wios=2\n'],
  ]);
  const directories = new Map<string, readonly string[]>([
    [procRoot, ['stat', 'meminfo', 'pressure', 'self', '100', '900']],
  ]);
  return {
    options: { procRoot, sysRoot, scratchPath, selfPid: 900 },
    services: {
      now: () => ({ capturedAtUtc: '2026-01-01T00:00:00.000Z', monotonicNs: '123456789' }),
      readText: (path: string) => {
        const value = contents.get(path);
        if (value === undefined) {
          const error = Object.assign(new Error('missing_fixture_file'), { code: 'ENOENT' });
          return Promise.reject(error);
        }
        return Promise.resolve(value);
      },
      readDirectory: (path: string) => Promise.resolve(directories.get(path) ?? []),
      availableBytes: () => Promise.resolve(8 * 1_073_741_824),
    },
    contents,
  };
}

const snapshotSchema = z.object({
  capturedAtUtc: z.string(),
  monotonicNs: z.string(),
  logicalCpuCount: z.number(),
  affinityCpuCount: z.number(),
  cpusetCpuCount: z.number(),
  quotaCpuCapacity: z.number().nullable(),
  aggregateCpuTicks: z.number(),
  throttledPeriods: z.number(),
  cpuPressure: z.object({ host: z.unknown(), cgroup: z.unknown() }).strict(),
  memoryPressure: z.object({ host: z.unknown(), cgroup: z.unknown() }).strict(),
  ioPressure: z.object({ host: z.unknown(), cgroup: z.unknown() }).strict(),
  memoryAvailableBytes: z.number(),
  swapUsedBytes: z.number(),
  cgroupMemoryCurrentBytes: z.number(),
  cgroupMemoryMaxBytes: z.number().nullable(),
  cgroupMemoryHighBytes: z.number().nullable(),
  memoryEvents: z.object({ high: z.number(), max: z.number(), oom: z.number(), oomKill: z.number() }).strict(),
  cgroupSwapCurrentBytes: z.number(),
  ioReadBytes: z.number(),
  ioWriteBytes: z.number(),
  scratchFreeBytes: z.number(),
  processEnumerationComplete: z.boolean(),
  processes: z.array(z.object({
    pid: z.number(), startTicks: z.string(), ppid: z.number(), pgid: z.number(), sid: z.number(),
    cpuTicks: z.number(), uid: z.number(), executable: z.string(), cgroupClass: z.string(),
  }).strict()),
}).passthrough();

it('collectHostSnapshot_parses_host_cgroup_and_process_metrics_without_paths', async () => {
  const loaded = await loadSnapshotModule();
  const fixture = fixtureFilesystem();

  const snapshot = snapshotSchema.parse(await loaded.collectHostSnapshot(fixture.options, fixture.services));

  expect(snapshot).toMatchObject({
    logicalCpuCount: 2,
    affinityCpuCount: 2,
    cpusetCpuCount: 2,
    quotaCpuCapacity: null,
    aggregateCpuTicks: 1_144,
    throttledPeriods: 0,
    memoryAvailableBytes: 8 * 1_073_741_824,
    swapUsedBytes: 512 * 1_048_576,
    cgroupMemoryCurrentBytes: 1_073_741_824,
    cgroupMemoryMaxBytes: null,
    cgroupMemoryHighBytes: null,
    cgroupSwapCurrentBytes: 0,
    ioReadBytes: 1_024,
    ioWriteBytes: 2_048,
    scratchFreeBytes: 8 * 1_073_741_824,
    processEnumerationComplete: true,
  });
  expect(snapshot.processes).toContainEqual(expect.objectContaining({
    pid: 100, startTicks: '1234', cpuTicks: 168, uid: 1000, executable: 'editor (test)', cgroupClass: 'user_session',
  }));
  expect(JSON.stringify(snapshot)).not.toContain('/fixture');
  expect(JSON.stringify(snapshot)).not.toContain('cmdline');
});

it('collectHostSnapshot_fails_closed_when_required_pressure_data_is_missing', async () => {
  const loaded = await loadSnapshotModule();
  const fixture = fixtureFilesystem();
  fixture.contents.delete('/fixture/proc/pressure/memory');

  await expect(loaded.collectHostSnapshot(fixture.options, fixture.services)).rejects.toMatchObject({
    name: 'HostSnapshotUnavailableError',
    code: 'host_snapshot_unavailable',
    inputId: 'host_memory_pressure',
  });
});

it('marks_process_enumeration_incomplete_when_a_proc_stat_record_is_malformed', async () => {
  const loaded = await loadSnapshotModule();
  const fixture = fixtureFilesystem();
  fixture.contents.set('/fixture/proc/100/stat', 'malformed');

  const snapshot = snapshotSchema.parse(await loaded.collectHostSnapshot(fixture.options, fixture.services));

  expect(snapshot.processEnumerationComplete).toBe(false);
  expect(snapshot.processes.some((process) => process.pid === 100)).toBe(false);
});

it('treats_a_process_disappearing_during_enumeration_as_a_normal_exit', async () => {
  const loaded = await loadSnapshotModule();
  const fixture = fixtureFilesystem();
  fixture.contents.delete('/fixture/proc/100/stat');

  const snapshot = snapshotSchema.parse(await loaded.collectHostSnapshot(fixture.options, fixture.services));

  expect(snapshot.processEnumerationComplete).toBe(true);
  expect(snapshot.processes.some((process) => process.pid === 100)).toBe(false);
});

it('returns_indeterminate_when_scratch_free_bytes_are_not_a_safe_nonnegative_integer', async () => {
  const loaded = await loadSnapshotModule();
  const fixture = fixtureFilesystem();

  await expect(loaded.collectHostSnapshot(fixture.options, {
    ...fixture.services,
    availableBytes: () => Promise.resolve(-1),
  })).rejects.toMatchObject({
    name: 'HostSnapshotUnavailableError',
    code: 'host_snapshot_unavailable',
    inputId: 'scratch_free_bytes',
  });
});
