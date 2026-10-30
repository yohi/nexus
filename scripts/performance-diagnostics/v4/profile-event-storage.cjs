'use strict';

const fs = require('node:fs');
const path = require('node:path');

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function processStartTicks() {
  const stat = fs.readFileSync('/proc/self/stat', 'utf8');
  const tail = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
  const ticks = tail[19];
  if (ticks === undefined || !/^[1-9][0-9]*$/.test(ticks)) fail('process_identity_unavailable');
  return ticks;
}

function validateRequest(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('invalid_request');
  const keys = [
    'schemaVersion', 'diagnosticOnly', 'runId', 'jobId', 'recipeDigest', 'sourceFingerprint',
    'runDirectory', 'parentPid',
  ];
  if (Object.keys(value).some((key) => !keys.includes(key)) || keys.some((key) => !(key in value))) fail('invalid_request');
  if (value.schemaVersion !== 1 || value.diagnosticOnly !== true || value.jobId !== 'cold_initial_index') fail('invalid_request');
  if (typeof value.runId !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value.runId)) fail('invalid_request');
  if (typeof value.recipeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.recipeDigest)) fail('invalid_request');
  if (typeof value.sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceFingerprint)) fail('invalid_request');
  if (typeof value.runDirectory !== 'string' || !path.isAbsolute(value.runDirectory)) fail('invalid_request');
  if (!Number.isSafeInteger(value.parentPid) || value.parentPid < 1) fail('invalid_request');
  return value;
}

function openOwnedDirectory(directory) {
  if (process.platform !== 'linux') fail('unsupported_platform');
  const canonical = path.resolve(directory);
  if (fs.realpathSync(directory) !== canonical) fail('noncanonical_run_directory');
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const stat = fs.fstatSync(descriptor);
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    || fs.realpathSync(`/proc/self/fd/${descriptor}`) !== canonical) {
    fs.closeSync(descriptor);
    fail('unowned_run_directory');
  }
  return descriptor;
}

function openProfileDirectory(runDirectoryFd, runDirectory) {
  const expectedPath = path.join(runDirectory, 'profiles');
  const descriptorPath = `/proc/self/fd/${runDirectoryFd}/profiles`;
  try {
    fs.mkdirSync(descriptorPath, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error) || error.code !== 'EEXIST') throw error;
  }
  const descriptor = fs.openSync(descriptorPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const stat = fs.fstatSync(descriptor);
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
    || fs.realpathSync(`/proc/self/fd/${descriptor}`) !== expectedPath) {
    fs.closeSync(descriptor);
    fail('unowned_profile_directory');
  }
  return descriptor;
}

function openProfileFiles(rawRequest) {
  const request = validateRequest(rawRequest);
  const ticks = processStartTicks();
  const runDirectoryFd = openOwnedDirectory(request.runDirectory);
  let profileDirectoryFd;
  let eventFd;
  try {
    profileDirectoryFd = openProfileDirectory(runDirectoryFd, path.resolve(request.runDirectory));
    const eventName = `profile-events-${process.pid}-${ticks}.jsonl`;
    eventFd = fs.openSync(`/proc/self/fd/${runDirectoryFd}/${eventName}`,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (profileDirectoryFd !== undefined) fs.closeSync(profileDirectoryFd);
    fs.closeSync(runDirectoryFd);
    throw error;
  }
  return { request, ticks, runDirectoryFd, profileDirectoryFd, eventFd };
}

function loadDiagnosticRequest() {
  const requestPath = process.env.NEXUS_PERF_DIAGNOSTIC_REQUEST_FILE;
  if (requestPath === undefined || requestPath.length === 0) return undefined;
  if (!path.isAbsolute(requestPath) || fs.realpathSync(requestPath) !== path.resolve(requestPath)) fail('invalid_request_file');
  const requestFd = fs.openSync(requestPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const requestStat = fs.fstatSync(requestFd);
    if (!requestStat.isFile() || (requestStat.mode & 0o777) !== 0o600
      || (typeof process.getuid === 'function' && requestStat.uid !== process.getuid())
      || fs.realpathSync(`/proc/self/fd/${requestFd}`) !== path.resolve(requestPath)) fail('invalid_request_file');
    return validateRequest(JSON.parse(fs.readFileSync(requestFd, 'utf8')));
  } finally {
    fs.closeSync(requestFd);
  }
}

module.exports = { loadDiagnosticRequest, openProfileFiles };
