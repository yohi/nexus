import { readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import picomatch from 'picomatch';
import { normalizeIgnorePaths } from '../../utils/path-normalization.js';
import type { IndexEvent } from '../../types/index.js';
import { currentRuntimeDiagnosticContext, recordRuntimeDiagnosticProgress, runRuntimeDiagnosticStage } from '../../observability/diagnostic-stage-trace.js';

type ScanCounters = { entriesSeen: number; entriesIgnored: number; entriesEligible: number; filesExpected: number; filesEmitted: number; directoriesVisited: number };

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
    if (currentRuntimeDiagnosticContext() === undefined) {
      return await this.scanUnobserved(dir, projectRoot, ignorePaths, onProgress, isIgnored);
    }
    const counters: ScanCounters = { entriesSeen: 0, entriesIgnored: 0, entriesEligible: 0, filesExpected: 0, filesEmitted: 0, directoriesVisited: 0 };
    return await runRuntimeDiagnosticStage('S05_directory_scan', async () => {
      try {
        return await this.scanObserved(dir, projectRoot, ignorePaths, onProgress, isIgnored, counters);
      } finally {
        recordRuntimeDiagnosticProgress({ counterId: 'scan.entries_seen', value: counters.entriesSeen, unit: 'entries', semantics: 'visited', sampleReason: 'stage_end' });
        recordRuntimeDiagnosticProgress({ counterId: 'scan.entries_ignored', value: counters.entriesIgnored, unit: 'entries', semantics: 'classified', sampleReason: 'stage_end' });
        recordRuntimeDiagnosticProgress({ counterId: 'scan.entries_eligible', value: counters.entriesEligible, unit: 'entries', semantics: 'classified', sampleReason: 'stage_end' });
        recordRuntimeDiagnosticProgress({ counterId: 'scan.files_expected', value: counters.filesExpected, unit: 'files', semantics: 'classified', sampleReason: 'stage_end' });
        recordRuntimeDiagnosticProgress({ counterId: 'scan.files_emitted', value: counters.filesEmitted, unit: 'files', semantics: 'returned', sampleReason: 'stage_end' });
        recordRuntimeDiagnosticProgress({ counterId: 'scan.directories_visited', value: counters.directoriesVisited, unit: 'directories', semantics: 'visited', sampleReason: 'stage_end' });
      }
    });
  }

  private static async scanUnobserved(dir: string, projectRoot: string, ignorePaths: string[],
    onProgress: ((msg: string) => void) | undefined, isIgnored: ((path: string) => boolean) | undefined): Promise<IndexEvent[]> {
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
        events.push(...(await this.scanUnobserved(fullPath, projectRoot, ignorePaths, onProgress, isIgnored)));
      } else if (entry.isFile()) {
        events.push({ type: 'added', filePath: relPath, detectedAt: new Date().toISOString() });
      }
    }
    return events;
  }

  private static async scanObserved(dir: string, projectRoot: string, ignorePaths: string[],
    onProgress: ((msg: string) => void) | undefined, isIgnored: ((path: string) => boolean) | undefined,
    counters: ScanCounters): Promise<IndexEvent[]> {
    counters.directoriesVisited += 1;
    const entries = await readdir(resolve(dir), { withFileTypes: true });
    const events: IndexEvent[] = [];
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = relative(projectRoot, fullPath);
      const relPathForMatch = relPath.split(sep).join('/');
      counters.entriesSeen += 1;
      if (isIgnored?.(relPathForMatch)) {
        counters.entriesIgnored += 1;
        continue;
      }
      counters.entriesEligible += 1;
      this.scanCounter += 1;
      if (onProgress && this.scanCounter % this.LOG_THROTTLE_THRESHOLD === 0) {
        onProgress(`Scanning progress: ${this.scanCounter} entries reached (currently at ${relPath})`);
      }
      if (entry.isDirectory()) {
        events.push(...(await this.scanObserved(fullPath, projectRoot, ignorePaths, onProgress, isIgnored, counters)));
      } else if (entry.isFile()) {
        counters.filesExpected += 1;
        events.push({ type: 'added', filePath: relPath, detectedAt: new Date().toISOString() });
        counters.filesEmitted += 1;
      }
    }
    return events;
  }
}
