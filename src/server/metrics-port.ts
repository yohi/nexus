import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';

export const METRICS_PORT_FILENAME = 'metrics.port';

/**
 * Writes the resolved metrics port to `${storageDir}/metrics.port`.
 * Called after the MetricsHttpServer successfully binds.
 */
export async function writeMetricsPort(storageDir: string, port: number): Promise<void> {
  const filePath = path.join(storageDir, METRICS_PORT_FILENAME);
  await writeFile(filePath, `${port}\n`, 'utf8');
}

/**
 * Reads the metrics port from `${storageDir}/metrics.port`.
 * Returns undefined if the file does not exist or is invalid.
 */
export async function readMetricsPort(storageDir: string): Promise<number | undefined> {
  const filePath = path.join(storageDir, METRICS_PORT_FILENAME);
  try {
    const content = await readFile(filePath, 'utf8');
    const port = Number.parseInt(content.trim(), 10);
    if (Number.isInteger(port) && port > 0 && port <= 65535) {
      return port;
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      throw error;
    }
  }
  return undefined;
}

/**
 * Removes the metrics port file on server shutdown.
 * Safe to call even if the file does not exist (idempotent).
 */
export async function removeMetricsPort(storageDir: string): Promise<void> {
  const filePath = path.join(storageDir, METRICS_PORT_FILENAME);
  try {
    await unlink(filePath);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      throw error;
    }
  }
}
