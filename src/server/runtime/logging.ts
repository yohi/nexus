import { createWriteStream } from 'node:fs';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';

export function createRuntimeLogging(storageRoot: string) {
  const LOG_MAX_BYTES = 10 * 1024 * 1024;
  const LOG_MAX_FILES = 5;
  const logFilePath = join(storageRoot, 'indexer.log');
  let logStream = createWriteStream(logFilePath, { flags: 'w' });
  logStream.on('error', (error) => { console.error('[Nexus] Log stream error:', error); });
  let isBackedUp = false;
  let drainListener: (() => void) | null = null;
  const logQueue: string[] = [];
  let isRotating = false;
  let writtenBytes = 0;

  const rotateLog = async () => {
    if (isRotating) return;
    isRotating = true;
    if (drainListener) { logStream.off('drain', drainListener); drainListener = null; }
    logStream.end();
    await finished(logStream).catch(() => {});
    for (let index = LOG_MAX_FILES - 1; index >= 1; index--) {
      const oldPath = join(storageRoot, `indexer.log.${index}`);
      const newPath = join(storageRoot, `indexer.log.${index + 1}`);
      try { await rename(oldPath, newPath); } catch { /* Existing rotation ignores absent files. */ }
    }
    try { await rename(logFilePath, join(storageRoot, 'indexer.log.1')); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') {
        console.error('[Nexus] Failed to rotate log:', error);
      }
    }
    logStream = createWriteStream(logFilePath, { flags: 'w' });
    logStream.on('error', (error) => { console.error('[Nexus] Log stream error:', error); });
    writtenBytes = 0;
    isBackedUp = false;
    isRotating = false;
    flushLogQueue();
  };

  const flushLogQueue = () => {
    while (logQueue.length > 0 && !isBackedUp && !isRotating) {
      const line = logQueue.shift();
      if (line === undefined) break;
      const byteLength = Buffer.byteLength(line, 'utf8');
      if (!logStream.write(line)) {
        isBackedUp = true;
        drainListener = () => { isBackedUp = false; drainListener = null; flushLogQueue(); };
        logStream.once('drain', drainListener);
      }
      writtenBytes += byteLength;
      if (writtenBytes >= LOG_MAX_BYTES) void rotateLog();
    }
  };

  const onLog = (msg: string) => {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}\n`;
    try {
      if (writtenBytes >= LOG_MAX_BYTES) void rotateLog();
      if (isRotating || isBackedUp) { logQueue.push(line); return; }
      const byteLength = Buffer.byteLength(line, 'utf8');
      if (!logStream.write(line)) {
        isBackedUp = true;
        drainListener = () => { isBackedUp = false; drainListener = null; flushLogQueue(); };
        logStream.once('drain', drainListener);
      }
      writtenBytes += byteLength;
      if (writtenBytes >= LOG_MAX_BYTES) void rotateLog();
    } catch (error) {
      console.error(`[Indexer Log Error] Failed to write to ${logFilePath}:`, error);
      console.error(`Original message: ${msg}`);
    }
  };

  const close = async () => {
    if (drainListener) { logStream.off('drain', drainListener); drainListener = null; }
    logStream.end();
    await finished(logStream);
  };
  return { onLog, close };
}
