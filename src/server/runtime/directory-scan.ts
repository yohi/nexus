import { readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import picomatch from 'picomatch';
import { normalizeIgnorePaths } from '../../utils/path-normalization.js';
import type { IndexEvent } from '../../types/index.js';

export class DirectoryScanner {
  private static scanCounter = 0;
  private static readonly LOG_THROTTLE_THRESHOLD = 100;

  static async scan(dir: string, projectRoot: string, ignorePaths: string[],
    onProgress?: (msg: string) => void, isInitial = true,
    isIgnored?: (path: string) => boolean): Promise<IndexEvent[]> {
    if (isInitial) {
      this.scanCounter = 0;
      const patterns = normalizeIgnorePaths(ignorePaths);
      isIgnored = picomatch(patterns, { windows: true });
    }
    const entries = await readdir(resolve(dir), { withFileTypes: true });
    const events: IndexEvent[] = [];
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(projectRoot, fullPath);
      const relPathForMatch = relPath.split(sep).join('/');
      if (isIgnored?.(relPathForMatch)) continue;
      this.scanCounter += 1;
      if (onProgress && this.scanCounter % this.LOG_THROTTLE_THRESHOLD === 0) {
        onProgress(`Scanning progress: ${this.scanCounter} entries reached (currently at ${relPath})`);
      }
      if (entry.isDirectory()) {
        events.push(...(await this.scan(fullPath, projectRoot, ignorePaths, onProgress, false, isIgnored)));
      } else if (entry.isFile()) {
        events.push({ type: 'added', filePath: relPath, detectedAt: new Date().toISOString() });
      }
    }
    return events;
  }
}
