// Vitest setup (Nexus #297): every in-process runtime admission in tests uses a disposable coordination root under
// the OS temp directory instead of the real account home. The override is an in-process global only (never config
// or environment), read lazily by the process-wide admission service.
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll } from 'vitest';
import { TEST_COORDINATION_ROOT_KEY } from '../../src/server/storage-ownership/admission.js';

let base: string | undefined;

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'nexus-test-coord-')));
  (globalThis as Record<symbol, unknown>)[TEST_COORDINATION_ROOT_KEY] = join(base, 'coord');
});

afterAll(async () => {
  delete (globalThis as Record<symbol, unknown>)[TEST_COORDINATION_ROOT_KEY];
  if (base !== undefined) await rm(base, { recursive: true, force: true });
});

/** The coordination root used by the process-wide admission service in the current test file. */
export function testCoordinationRoot(): string {
  const root = (globalThis as Record<symbol, unknown>)[TEST_COORDINATION_ROOT_KEY];
  if (typeof root !== 'string') throw new Error('test coordination root is not configured');
  return root;
}
