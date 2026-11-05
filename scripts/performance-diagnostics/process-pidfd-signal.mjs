import { execFile } from 'node:child_process';

const PIDFD_HELPER = `
import os, signal, sys

def read_identity(pid):
    with open(f"/proc/{pid}/stat", "r", encoding="utf-8") as stream:
        fields = stream.read().rsplit(")", 1)[1].split()
    if len(fields) < 20:
        return None
    return (int(fields[2]), int(fields[3]), fields[19])

try:
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        sys.exit(13)
    if sys.argv[1] == "probe":
        descriptor = os.pidfd_open(os.getpid(), 0)
        try:
            signal.pidfd_send_signal(descriptor, 0)
        finally:
            os.close(descriptor)
        sys.exit(0)
    pid = int(sys.argv[2])
    expected = (int(sys.argv[4]), int(sys.argv[5]), sys.argv[3])
    descriptor = os.pidfd_open(pid, 0)
    try:
        if read_identity(pid) != expected:
            sys.exit(11)
        signal.pidfd_send_signal(descriptor, getattr(signal, sys.argv[6]))
    finally:
        os.close(descriptor)
except (ProcessLookupError, FileNotFoundError):
    sys.exit(10)
except PermissionError:
    sys.exit(12)
except (AttributeError, OSError):
    sys.exit(13)
`;

const HELPER_TIMEOUT_MS = 2_000;
const PYTHON_EXECUTABLE = '/usr/bin/python3';

export class PidfdSignalError extends Error {
  constructor(code) {
    super(code);
    this.name = 'PidfdSignalError';
    this.code = code;
  }
}

function helperError(error) {
  if (error instanceof Error && 'code' in error) {
    switch (error.code) {
      case 10:
        return new PidfdSignalError('ESRCH');
      case 11:
        return new PidfdSignalError('PIDFD_IDENTITY_MISMATCH');
      case 12:
        return new PidfdSignalError('EPERM');
      case 13:
        return new PidfdSignalError('PIDFD_UNAVAILABLE');
      default:
        return new PidfdSignalError('PIDFD_HELPER_FAILED');
    }
  }
  return new PidfdSignalError('PIDFD_HELPER_FAILED');
}

function runPidfdHelper(args) {
  return new Promise((resolve, reject) => {
    execFile(PYTHON_EXECUTABLE, ['-I', '-c', PIDFD_HELPER, ...args], {
      env: { PATH: '/usr/bin:/bin' },
      encoding: 'utf8',
      maxBuffer: 1_024,
      timeout: HELPER_TIMEOUT_MS,
    }, (error) => {
      if (error === null) resolve();
      else reject(helperError(error));
    });
  });
}

export async function checkPidfdSignalSupport() {
  try {
    await runPidfdHelper(['probe']);
    return true;
  } catch (error) {
    if (error instanceof PidfdSignalError) return false;
    throw error;
  }
}

export async function sendProcessSignalWithPidfd(identity, signal) {
  await runPidfdHelper([
    'signal',
    String(identity.pid),
    identity.startTicks,
    String(identity.pgid),
    String(identity.sid),
    signal,
  ]);
}
