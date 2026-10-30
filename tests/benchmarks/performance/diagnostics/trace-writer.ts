import { constants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { diagnosticTraceIdentitySchema, type DiagnosticTraceIdentity } from './contracts.js';

export function createTraceFileWriter(directory: string, identity: DiagnosticTraceIdentity): Readonly<{
  write: (content: string) => Promise<void>;
  close: () => Promise<void>;
}> {
  const parsed = diagnosticTraceIdentitySchema.parse(identity);
  const filename = `trace-${parsed.pid}-${parsed.processStartTicks}.jsonl`;
  let handle: FileHandle | undefined;
  let closed = false;
  return {
    async write(content: string): Promise<void> {
      if (closed) throw new Error('Diagnostic writer is closed');
      if (handle === undefined) {
        if (process.platform !== 'linux' || await realpath(directory) !== resolve(directory)) {
          throw new Error('Diagnostic directory is not canonical');
        }
        const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          const directoryStat = await directoryHandle.stat();
          if (!directoryStat.isDirectory() || (directoryStat.mode & 0o777) !== 0o700
            || (process.getuid !== undefined && directoryStat.uid !== process.getuid())
            || await realpath(`/proc/self/fd/${directoryHandle.fd}`) !== resolve(directory)) {
            throw new Error('Diagnostic directory is not private and owned');
          }
          handle = await open(join(`/proc/self/fd/${directoryHandle.fd}`, filename), 'wx', 0o600);
        } finally {
          await directoryHandle.close();
        }
      }
      await handle.writeFile(content);
    },
    async close(): Promise<void> {
      closed = true;
      if (handle !== undefined) await handle.close();
    },
  };
}
