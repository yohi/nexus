// TEST-ONLY transparent recording proxy for the opt-in real-server integration suite.
//
// The Owner-approved test executable is a temporary wrapper that imports this module; it
// spawns an explicitly prepared, version-checked `typescript-language-server` (from the
// config file, never from PATH), forwards stdio byte-for-byte and records every framed
// message in both directions (client->server "c2s", server->client "s2c") to a JSON-lines
// log. The child receives exactly the environment Nexus gave this proxy. Never imported by
// production code.
//
// Usage: node recording-proxy.mjs --stdio --config <absolute config path>
// Config: { logPath: string, target: string (absolute), targetArgs: string[] }

import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';

const configIndex = process.argv.indexOf('--config');
const configPath = configIndex >= 0 ? process.argv[configIndex + 1] : undefined;
if (configPath === undefined) {
  process.stderr.write('recording-proxy: missing --config\n');
  process.exit(2);
}
const config = JSON.parse(readFileSync(configPath, 'utf8'));

const SEPARATOR = Buffer.from('\r\n\r\n', 'ascii');
let sequence = 0;

const recorder = (direction) => {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const headerEnd = buffer.indexOf(SEPARATOR);
      if (headerEnd < 0) return;
      const match = /Content-Length: (\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'));
      if (match === null) return;
      const bodyStart = headerEnd + SEPARATOR.length;
      const length = Number(match[1]);
      if (buffer.length < bodyStart + length) return;
      const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      buffer = buffer.subarray(bodyStart + length);
      let message;
      try {
        message = JSON.parse(body);
      } catch {
        message = { unparsable: true };
      }
      appendFileSync(config.logPath, `${JSON.stringify({ pid: process.pid, seq: sequence, direction, message })}\n`);
      sequence += 1;
    }
  };
};

const child = spawn(config.target, config.targetArgs, {
  cwd: process.cwd(),
  env: process.env,
  shell: false,
  stdio: ['pipe', 'pipe', 'inherit'],
});
const recordClient = recorder('c2s');
const recordServer = recorder('s2c');
process.stdin.on('data', (chunk) => {
  recordClient(chunk);
  child.stdin.write(chunk);
});
process.stdin.on('end', () => child.stdin.end());
child.stdout.on('data', (chunk) => {
  recordServer(chunk);
  process.stdout.write(chunk);
});
child.on('exit', (code) => process.exit(code ?? 0));
const forward = (signal) => () => child.kill(signal);
process.on('SIGTERM', forward('SIGTERM'));
process.on('SIGINT', forward('SIGINT'));
