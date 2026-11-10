// Test-only preload (Nexus #297) for real spawned Nexus CLI processes: points the process-wide storage-ownership
// coordination root at a disposable directory instead of the real OS-account home, through the same in-process
// global symbol the Vitest setup uses. Production code never reads NEXUS_TEST_COORDINATION_ROOT; only this fixture
// does. Usage: node --import <this file> dist/bin/nexus.js ...
// The Bridge forwards `process.execArgv` and its environment to the managed child, so the child inherits the preload.
// Refuses to run without the variable so a test can never silently fall back to the real account home.
import { isAbsolute } from 'node:path';

const root = process.env.NEXUS_TEST_COORDINATION_ROOT;
if (typeof root !== 'string' || !isAbsolute(root)) {
  throw new Error('coordination-root-preload: NEXUS_TEST_COORDINATION_ROOT must be an absolute path');
}
globalThis[Symbol.for('nexus.storageOwnership.testCoordinationRoot')] = root;
