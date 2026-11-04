import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const profileLifecycleEvents = new Set([
  'profile_segment_started',
  'profile_segment_stop_requested',
  'profile_segment_stopped',
  'profile_write_completed',
  'profile_write_failed',
  'profile_segment_start_failed',
  'profile_segment_stop_failed',
]);

export async function correlateDiagnosticProfileEvidence(input) {
  const cpuSamples = input.workerEvents.filter((event) => event.event === 'resource_sample' && event.sampleScope === 'worker_process')
    .map((event) => ({
      user: event.cpuUserUs?.status === 'observed' ? event.cpuUserUs.value : undefined,
      system: event.cpuSystemUs?.status === 'observed' ? event.cpuSystemUs.value : undefined,
    }))
    .filter((sample) => sample.user !== undefined && sample.system !== undefined);
  const firstCpu = cpuSamples[0];
  const lastCpu = cpuSamples.at(-1);
  const cpuDeltaUs = firstCpu === undefined || lastCpu === undefined ? 0
    : lastCpu.user + lastCpu.system - firstCpu.user - firstCpu.system;
  const profileSegments = input.segments.map((segment) => Object.freeze({
    events: Object.freeze(input.events.filter((event) => profileLifecycleEvents.has(event.event)
      && event.segmentId === segment.segmentId && event.pid === input.workerIdentity.pid
      && event.processStartTicks === input.workerIdentity.startTicks)),
    profileValid: segment.profileValid,
  }));
  const supervisorSample = input.supervisorProcessSamples?.find((sample) => sample.pid === input.workerIdentity.pid
    && sample.startTicks === input.workerIdentity.startTicks && sample.ppid === input.workerIdentity.parentPid);
  const processSamples = cpuSamples.length < 2 || supervisorSample === undefined ? [] : [Object.freeze({
    runId: input.runId,
    pid: input.workerIdentity.pid,
    processStartTicks: input.workerIdentity.startTicks,
    ppid: input.workerIdentity.parentPid,
    cpuDeltaUs,
    cpuTicksDelta: supervisorSample.cpuTicksDelta,
  })];
  const correlationModule = await import(pathToFileURL(
    join(repository, 'scripts/performance-diagnostics/profile-correlation.mjs'),
  ).href);
  const correlation = correlationModule.correlateProfileEvidence({
    runId: input.runId,
    parentPid: input.parentPid,
    clockAlignment: input.clockMapping,
    processSamples,
    preloadMarkers: input.workerMarkers,
    segments: profileSegments,
    stageEvents: input.workerEvents.filter((event) => event.event === 'span_started' || event.event === 'span_finished'),
  });
  return Object.freeze({ cpuDeltaUs, correlation });
}
