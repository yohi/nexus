import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2];

function exitAfterObservation(exitCode) {
  const acknowledgementFile = process.env.SUPERVISOR_TEST_ACK_FILE;
  if (acknowledgementFile === undefined) {
    setTimeout(() => process.exit(exitCode), 300);
    return;
  }
  const deadline = Date.now() + 8_000;
  const waitForObservation = () => {
    if (existsSync(acknowledgementFile)) {
      process.exit(exitCode);
      return;
    }
    if (Date.now() >= deadline) {
      process.exit(2);
      return;
    }
    setTimeout(waitForObservation, 10);
  };
  waitForObservation();
}

if (mode === 'spawn-ignore-term') {
  spawn(process.execPath, [fileURLToPath(import.meta.url), 'ignore-term'], { stdio: 'ignore' });
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1_000);
} else if (mode === 'spawn-detached-child') {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'ignore-term'], { detached: true, stdio: 'ignore' });
  const pidFile = process.env.SUPERVISOR_TEST_PID_FILE;
  if (pidFile !== undefined && child.pid !== undefined) writeFileSync(pidFile, String(child.pid), { mode: 0o600 });
  process.on('SIGTERM', () => {});
  exitAfterObservation(0);
} else if (mode === 'exit-with-child' || mode === 'crash-with-child') {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'ignore-term'], { stdio: 'ignore' });
  const pidFile = process.env.SUPERVISOR_TEST_PID_FILE;
  if (pidFile !== undefined && child.pid !== undefined) writeFileSync(pidFile, String(child.pid), { mode: 0o600 });
  exitAfterObservation(mode === 'crash-with-child' ? 1 : 0);
} else if (mode === 'ignore-term') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1_000);
} else {
  setTimeout(() => process.exit(0), 25);
}
