// Test-only child process for real multi-process storage-ownership admission tests (Nexus #297).
// Usage: node --import ./ts-resolve-hooks.mjs admission-child.mjs '<json spec>'
// Prints one JSON line per event on stdout. In `hold` mode the writer lease is kept until "release\n" on stdin.
import { createInterface } from 'node:readline';

const spec = JSON.parse(process.argv[2]);
const { createStorageOwnershipAdmissionService } = await import('../../../src/server/storage-ownership/admission.js');
const service = createStorageOwnershipAdmissionService({ coordinationRoot: spec.coordinationRoot, lockWaitMs: spec.lockWaitMs ?? 5000 });
const emit = (event) => process.stdout.write(`${JSON.stringify({ pid: process.pid, ...event })}\n`);
const config = { projectRoot: spec.projectRoot,
  storage: { rootDir: spec.rootDir, metadataDbPath: spec.metadataDbPath, vectorDbPath: spec.vectorDbPath } };
let handle;
try {
  handle = await service.admitStorageWriter(await service.resolveStorageOwnershipTargets(config));
} catch (error) {
  emit({ event: 'refused', code: error.code ?? 'unexpected', message: String(error.message) });
  process.exit(0);
}
emit({ event: 'admitted' });
if (!spec.hold) { await handle.release(); emit({ event: 'released' }); process.exit(0); }
const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (line.trim() !== 'release') return;
  await handle.release();
  emit({ event: 'released' });
  process.exit(0);
});
