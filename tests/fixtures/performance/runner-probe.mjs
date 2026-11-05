import { fileURLToPath } from 'node:url';
import { runPerformance } from '../../../scripts/run-performance.mjs';

process.exitCode = await runPerformance(process.argv.slice(2), {
  scenarioVitestEntry: fileURLToPath(new URL('./fake-vitest.mjs', import.meta.url)),
});
