import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';

const repository = join(dirname(fileURLToPath(import.meta.url)), '../..');
const decimalSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const clockWindowSchema = z.object({
  bootId: z.string().min(1).max(64),
  parentClockSource: z.string().min(1).max(128),
  parentResolutionNs: z.string().regex(/^[1-9][0-9]*$/),
  childClockSource: z.string().min(1).max(128),
  childResolutionNs: z.string().regex(/^[1-9][0-9]*$/),
  pings: z.array(z.object({
    parentSendNs: decimalSchema,
    childMonotonicNs: decimalSchema,
    parentReceiveNs: decimalSchema,
  }).strict()).min(3).max(64),
}).strict();

export const clockProbeResultSchema = z.object({
  phase: z.enum(['start', 'end']),
  probePid: z.number().int().positive(),
  probeStartTicks: z.string().regex(/^[1-9][0-9]*$/),
  clockWindow: clockWindowSchema,
}).strict();

function clockProbeEnvironment() {
  const environment = {};
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

export async function runClockConformanceProbe(phase, options = {}) {
  const probePhase = z.enum(['start', 'end']).parse(phase);
  const command = options.pythonExecutable ?? process.env.NEXUS_PERF_PYTHON ?? 'python3';
  const script = join(repository, 'scripts/performance-diagnostics/v4/clock_conformance.py');
  const output = await new Promise((resolveOutput, rejectOutput) => {
    execFile(command, [script, process.execPath, probePhase], {
      cwd: repository,
      env: clockProbeEnvironment(),
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 60_000,
    }, (error, stdout) => {
      if (error !== null) {
        rejectOutput(new Error('clock_probe_failed'));
        return;
      }
      try {
        resolveOutput(clockProbeResultSchema.parse(JSON.parse(stdout)));
      } catch (parseError) {
        if (!(parseError instanceof Error)) throw parseError;
        rejectOutput(new Error('clock_probe_invalid'));
      }
    });
  });
  return clockProbeResultSchema.parse(output);
}

export async function calibrateClockProbeResults(startValue, endValue) {
  const start = clockProbeResultSchema.parse(startValue);
  const end = clockProbeResultSchema.parse(endValue);
  if (start.phase !== 'start' || end.phase !== 'end') return Object.freeze({
    status: 'not_correlatable',
    reasonCode: 'invalid_clock_phase',
  });
  const clockDomainModule = await import(pathToFileURL(join(
    repository,
    'tests/benchmarks/performance/diagnostics/clock-domain.ts',
  )).href);
  return clockDomainModule.calibrateClockMapping({
    start: clockDomainModule.parseClockPingWindow(start.clockWindow),
    end: clockDomainModule.parseClockPingWindow(end.clockWindow),
    parentClockDomain: 'linux_clock_monotonic_ns',
    childClockDomain: 'process_local_monotonic',
  });
}
