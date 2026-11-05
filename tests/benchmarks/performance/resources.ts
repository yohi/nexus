import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { artifactBytesSchema, resourcesSchema } from './contracts.js';

type CpuScope = 'runtime_to_completion' | 'operation_to_completion' | 'handler_group' | 'setup_to_completion' | 'worker_lifetime';
export function captureResources(start: NodeJS.CpuUsage = { user: 0, system: 0 }, cpuScope: CpuScope = 'worker_lifetime') {
  const cpu = process.cpuUsage(start);
  const memory = process.memoryUsage();
  const usage = process.resourceUsage();
  return resourcesSchema.parse({ node_worker: { cpuUserUs: cpu.user, cpuSystemUs: cpu.system,
    heapUsedBytes: memory.heapUsed, rssBytes: memory.rss, lifetimePeakRssBytes: usage.maxRSS * 1024,
    cpuScope, heapScope: 'end_snapshot', peakRssScope: 'worker_lifetime' },
    external_ripgrep: { status: 'not_collected' }, process_tree: { status: 'not_collected' } });
}

export class ArtifactMeasurementError extends Error {
  constructor(readonly code: 'artifact_symlink' | 'artifact_unavailable') { super(code); this.name = 'ArtifactMeasurementError'; }
}

async function fileBytes(path: string, signal: AbortSignal): Promise<number> {
  signal.throwIfAborted();
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) throw new ArtifactMeasurementError('artifact_symlink');
  if (metadata.isFile()) return metadata.size;
  let total = 0;
  for (const entry of await readdir(path)) total += await fileBytes(join(path, entry), signal);
  return total;
}

export async function measureIndexArtifacts(roots: Readonly<{ metadataDbPath: string; vectorDbPath: string }>, signal: AbortSignal) {
  try {
    let metadataBytes = await fileBytes(roots.metadataDbPath, signal);
    for (const suffix of ['-wal', '-shm']) {
      try { metadataBytes += await fileBytes(`${roots.metadataDbPath}${suffix}`, signal); }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
    }
    const vectorBytes = await fileBytes(roots.vectorDbPath, signal);
    signal.throwIfAborted();
    return artifactBytesSchema.parse({ metadataBytes, vectorBytes, totalBytes: metadataBytes + vectorBytes,
      measurement: 'apparent_bytes', phase: 'settled' });
  } catch (error) {
    if (signal.aborted || error instanceof ArtifactMeasurementError) throw error;
    throw new ArtifactMeasurementError('artifact_unavailable');
  }
}
