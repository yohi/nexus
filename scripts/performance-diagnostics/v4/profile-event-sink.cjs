'use strict';

const fs = require('node:fs');
const { loadDiagnosticRequest, openProfileFiles } = require('./profile-event-storage.cjs');
const { withProfileRunBudget } = require('./profile-run-budget.cjs');

const MAX_EVENTS = 4096;
const MAX_TRACE_BYTES = 8 * 1024 * 1024;
const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;
const MAX_PROCESS_PROFILE_BYTES = 512 * 1024 * 1024;
const REASONS = Object.freeze([
  'clock_failure', 'clock_regressed', 'clock_unavailable', 'counter_contract_violation',
  'event_validation_failed', 'progress_outside_stage', 'sequence_exhausted',
  'event_cap_exceeded', 'byte_cap_exceeded', 'write_error', 'record_after_finalization',
  'finalization_with_active_spans', 'finalization_unverified', 'missing_profile_count_overflow',
]);

function writeComplete(fd, text) {
  const bytes = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (!Number.isSafeInteger(count) || count <= 0) throw new Error('diagnostic_write_incomplete');
    offset += count;
  }
}

function createProfileEventSink(rawRequest) {
  const { request, ticks, runDirectoryFd, profileDirectoryFd, eventFd } = openProfileFiles(rawRequest);

  const role = /^\d+$/.test(process.env.VITEST_WORKER_ID ?? '')
    ? 'vitest_worker'
    : process.pid === request.parentPid ? 'vitest_parent' : 'unknown_node';
  const identity = Object.freeze({
    runId: request.runId,
    jobId: request.jobId,
    recipeDigest: request.recipeDigest,
    sourceFingerprint: request.sourceFingerprint,
    pid: process.pid,
    processStartTicks: ticks,
    ppid: process.ppid,
    processRole: role,
    clockDomain: 'process_local_monotonic',
    schemaVersion: 1,
  });
  const reasons = new Set();
  let sequence = 0;
  let eventCount = 0;
  let writtenBytes = 0;
  let eventsDropped = 0;
  let bytesDropped = 0;
  const missingSegments = new Set();
  let profilesMissingExact = true;
  let profileBytes = 0;
  let failed = false;
  let closed = false;

  const statusEvent = () => ({
    ...identity,
    seq: sequence + 1,
    monotonicNs: process.hrtime.bigint().toString(),
    event: 'trace_status',
    finalizationState: 'provisional',
    traceIncomplete: true,
    traceTruncated: eventsDropped > 0 || bytesDropped > 0,
    samplingIncomplete: true,
    diagnosticAdmissible: false,
    eventsDropped,
    bytesDropped,
    profilesMissing: missingSegments.size,
    profilesMissingExact,
    stateIntegrity: 'unknown',
    reasonCode: 'finalization_unverified',
    reasonCodes: [...new Set([...reasons, 'finalization_unverified'])].filter((reason) => REASONS.includes(reason)),
  });
  const terminalReserve = Buffer.byteLength(`${JSON.stringify({
    ...identity,
    seq: Number.MAX_SAFE_INTEGER,
    monotonicNs: '9'.repeat(40),
    event: 'trace_status',
    finalizationState: 'provisional',
    traceIncomplete: true,
    traceTruncated: true,
    samplingIncomplete: true,
    diagnosticAdmissible: false,
    eventsDropped: Number.MAX_SAFE_INTEGER,
    bytesDropped: Number.MAX_SAFE_INTEGER,
    profilesMissing: Number.MAX_SAFE_INTEGER,
    profilesMissingExact: false,
    stateIntegrity: 'backup_cleanup_failed',
    reasonCode: 'finalization_unverified',
    reasonCodes: REASONS,
  })}\n`);

  function markMissing(segmentId) {
    if (missingSegments.has(segmentId)) return;
    if (missingSegments.size >= MAX_EVENTS) {
      profilesMissingExact = false;
      reasons.add('missing_profile_count_overflow');
      return;
    }
    missingSegments.add(segmentId);
  }

  function append(payload) {
    if (failed || closed) return false;
    if (payload.event === 'profile_segment_start_failed' || payload.event === 'profile_segment_stop_failed') markMissing(payload.segmentId);
    const event = { ...identity, seq: sequence + 1, monotonicNs: process.hrtime.bigint().toString(), ...payload };
    const line = `${JSON.stringify(event)}\n`;
    const size = Buffer.byteLength(line);
    if (eventCount >= MAX_EVENTS - 1 || writtenBytes + size + terminalReserve > MAX_TRACE_BYTES) {
      eventsDropped += 1;
      bytesDropped += size;
      reasons.add(eventCount >= MAX_EVENTS - 1 ? 'event_cap_exceeded' : 'byte_cap_exceeded');
      return false;
    }
    try {
      writeComplete(eventFd, line);
      sequence += 1;
      eventCount += 1;
      writtenBytes += size;
      return true;
    } catch (error) {
      failed = true;
      reasons.add('write_error');
      return false;
    }
  }

  function writeProfile(segmentId, profileJson, sampleCount) {
    const profileBuffer = Buffer.from(profileJson, 'utf8');
    if (profileBuffer.byteLength > MAX_SEGMENT_BYTES || profileBytes + profileBuffer.byteLength > MAX_PROCESS_PROFILE_BYTES) {
      markMissing(segmentId);
      reasons.add('byte_cap_exceeded');
      append({
        event: 'profile_write_failed', segmentId,
        sampleCount: { status: 'observed', value: sampleCount },
        fileBytes: { status: 'not_collected', reasonCode: 'profile_missing' },
        errorCategory: 'io_error',
      });
      return false;
    }
    const fileName = `profile-${process.pid}-${ticks}-${segmentId}.cpuprofile`;
    const profilePath = `/proc/self/fd/${profileDirectoryFd}/${fileName}`;
    let profileFd;
    try {
      const written = withProfileRunBudget(runDirectoryFd, profileDirectoryFd, profileBuffer.byteLength, () => {
        profileFd = fs.openSync(profilePath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(profileFd, profileBuffer);
        fs.fsyncSync(profileFd);
        fs.closeSync(profileFd);
        profileFd = undefined;
      });
      if (!written) {
        markMissing(segmentId);
        reasons.add('byte_cap_exceeded');
        append({
          event: 'profile_write_failed', segmentId,
          sampleCount: { status: 'observed', value: sampleCount },
          fileBytes: { status: 'not_collected', reasonCode: 'profile_missing' },
          errorCategory: 'io_error',
        });
        return false;
      }
      profileBytes += profileBuffer.byteLength;
      append({
        event: 'profile_write_completed', segmentId,
        sampleCount: { status: 'observed', value: sampleCount },
        fileBytes: { status: 'observed', value: profileBuffer.byteLength },
      });
      return true;
    } catch (error) {
      if (profileFd !== undefined) {
        try {
          profileBytes += fs.fstatSync(profileFd).size;
        } catch (statError) {
          if (!(statError instanceof Error)) throw statError;
          profileBytes = MAX_PROCESS_PROFILE_BYTES;
          reasons.add('write_error');
        }
        fs.closeSync(profileFd);
      }
      markMissing(segmentId);
      reasons.add('write_error');
      append({
        event: 'profile_write_failed', segmentId,
        sampleCount: { status: 'observed', value: sampleCount },
        fileBytes: { status: 'not_collected', reasonCode: 'profile_missing' },
        errorCategory: 'io_error',
      });
      return false;
    }
  }

  function finalize() {
    if (closed) return;
    closed = true;
    if (!failed) {
      try {
        const line = `${JSON.stringify(statusEvent())}\n`;
        if (eventCount < MAX_EVENTS && writtenBytes + Buffer.byteLength(line) <= MAX_TRACE_BYTES) writeComplete(eventFd, line);
      } catch (error) {
        failed = true;
      }
    }
    fs.closeSync(eventFd);
    fs.closeSync(profileDirectoryFd);
    fs.closeSync(runDirectoryFd);
  }

  return Object.freeze({ append, writeProfile, finalize, identity });
}

module.exports = { createProfileEventSink, loadDiagnosticRequest };
