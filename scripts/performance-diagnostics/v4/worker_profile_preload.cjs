'use strict';

const inspector = require('node:inspector');
const { createProfileEventSink, loadDiagnosticRequest } = require('./profile-event-sink.cjs');

function startDiagnosticProfiler(request) {
  let sink;
  try {
    sink = createProfileEventSink(request);
  } catch (error) {
    if (!(error instanceof Error)) return;
    return;
  }
  sink.append({ event: 'preload_started' });

  const session = new inspector.Session();
  let profileTimer;
  let segmentNumber = 0;
  let active = false;
  let closing = false;
  let closed = false;

  const nextSegmentId = () => `seg_${String(++segmentNumber).padStart(6, '0')}`;
  const reportFailure = (segmentId, event) => sink.append({
    event, segmentId,
    sampleCount: { status: 'not_collected', reasonCode: 'profile_missing' },
    fileBytes: { status: 'not_collected', reasonCode: 'not_yet_written' },
    errorCategory: 'observer_error',
  });
  const beginSegment = () => {
    const segmentId = nextSegmentId();
    try {
      session.post('Profiler.start', (error) => {
        if (error !== undefined && error !== null) {
          reportFailure(segmentId, 'profile_segment_start_failed');
          finish();
          return;
        }
        if (closing || closed) return;
        active = true;
        sink.append({
          event: 'profile_segment_started', segmentId,
          sampleCount: { status: 'not_collected', reasonCode: 'not_yet_sampled' },
          fileBytes: { status: 'not_collected', reasonCode: 'not_yet_written' },
        });
        if (!closing) scheduleStop();
      });
    } catch (error) {
      if (!(error instanceof Error)) return;
      reportFailure(segmentId, 'profile_segment_start_failed');
    }
  };
  const finish = () => {
    if (closed) return;
    closed = true;
    try {
      session.disconnect();
    } catch (error) {
      if (!(error instanceof Error)) return;
    } finally {
      sink.finalize();
    }
  };
  const stopSegment = (isFinal) => {
    if (!active) {
      if (isFinal) finish();
      return;
    }
    active = false;
    if (profileTimer !== undefined) clearTimeout(profileTimer);
    const segmentId = `seg_${String(segmentNumber).padStart(6, '0')}`;
    sink.append({
      event: 'profile_segment_stop_requested', segmentId,
      sampleCount: { status: 'not_collected', reasonCode: 'not_yet_sampled' },
      fileBytes: { status: 'not_collected', reasonCode: 'not_yet_written' },
    });
    try {
      session.post('Profiler.stop', (error, response) => {
        const profile = response?.profile;
        const samples = profile?.samples;
        if ((error !== undefined && error !== null) || !profile || !Array.isArray(samples)) {
          reportFailure(segmentId, 'profile_segment_stop_failed');
          finish();
          return;
        } else {
          sink.append({
            event: 'profile_segment_stopped', segmentId,
            sampleCount: { status: 'observed', value: samples.length },
            fileBytes: { status: 'not_collected', reasonCode: 'not_yet_written' },
          });
          sink.writeProfile(segmentId, JSON.stringify(profile), samples.length);
        }
        if (isFinal || closing) finish();
        else beginSegment();
      });
    } catch (error) {
      if (!(error instanceof Error)) {
        finish();
        return;
      }
      reportFailure(segmentId, 'profile_segment_stop_failed');
      if (isFinal || closing) finish();
      else beginSegment();
    }
  };
  function scheduleStop() {
    profileTimer = setTimeout(() => stopSegment(false), 20_000);
    profileTimer.unref();
  }

  process.once('beforeExit', () => {
    closing = true;
    stopSegment(true);
  });
  process.once('exit', finish);
  try {
    session.connect();
      session.post('Profiler.enable', (enableError) => {
        if (enableError !== undefined && enableError !== null) {
        reportFailure(nextSegmentId(), 'profile_segment_start_failed');
          finish();
          return;
        }
        session.post('Profiler.setSamplingInterval', { interval: 10_000 }, (intervalError) => {
          if (intervalError !== undefined && intervalError !== null) {
          reportFailure(nextSegmentId(), 'profile_segment_start_failed');
            finish();
            return;
        }
        beginSegment();
      });
    });
  } catch (error) {
    if (!(error instanceof Error)) return;
    reportFailure(nextSegmentId(), 'profile_segment_start_failed');
    finish();
  }
}

try {
  const request = loadDiagnosticRequest();
  if (request !== undefined) startDiagnosticProfiler(request);
} catch (error) {
  if (!(error instanceof Error)) throw error;
}
