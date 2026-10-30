import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RuntimeAssembly } from '../../../src/server/runtime/assembly-types.js';
import { buildToolHandlers } from '../../../src/server/tools/tool-support.js';
import type { FixtureManifest } from './contracts.js';
import { readinessProbeInfoSchema, validRetrievalValidationSchema } from './contracts.js';
import { expectedSymbolId } from './audit-manifest.js';
import type { OutcomeCollector } from './outcomes.js';
import { ReadinessError } from './readiness-error.js';
import { runRuntimeDiagnosticStage } from '../../../src/observability/diagnostic-stage-trace.js';

let probeSequence = 0;
const probeResponseSchema = z.object({ status: z.literal('ok'), freshness: z.literal('fresh'),
  reindexRequired: z.literal(false), source: z.string() });
export function probeReadiness(assembly: RuntimeAssembly, manifest: FixtureManifest,
  collector: OutcomeCollector, signal: AbortSignal): ReturnType<typeof probeReadinessUnstaged> {
  return runRuntimeDiagnosticStage('S11_readiness_probe', () => probeReadinessUnstaged(assembly, manifest, collector, signal));
}

async function probeReadinessUnstaged(assembly: RuntimeAssembly, manifest: FixtureManifest,
  collector: OutcomeCollector, signal: AbortSignal) {
  const file = manifest.files.at(-1);
  const declaration = file?.declarations.at(-1);
  if (file === undefined || declaration === undefined) throw new ReadinessError('probe_invalid');
  const symbolId = expectedSymbolId(file, declaration.name);
  if (symbolId === undefined) throw new ReadinessError('probe_invalid');
  const handlers = buildToolHandlers(assembly.options, assembly.runtime.initialize.bind(assembly.runtime));
  const requestId = `readiness-probe-${++probeSequence}`;
  try {
    return await collector.run(requestId, async () => {
      signal.throwIfAborted();
      const envelope = await handlers.get_symbol_source({ symbolId }, { signal });
      if (envelope.isError) throw new ReadinessError('probe_invalid');
      const response = probeResponseSchema.safeParse(envelope.structuredContent);
      if (!response.success || createHash('sha256').update(response.data.source).digest('hex') !== declaration.sourceHash ||
        (await collector.seal(requestId)).status !== 'valid') throw new ReadinessError('probe_invalid');
      signal.throwIfAborted();
      return {
        validation: validRetrievalValidationSchema.parse({ status: 'valid', resultCount: 1,
          identities: [{ path: file.path, name: declaration.name, origin: 'structured' }] }),
        info: readinessProbeInfoSchema.parse({ tool: 'get_symbol_source', identity: { path: file.path, name: declaration.name }, warmedDependencies: [
          'sqlite_catalog', 'filesystem_read', 'safe_path_resolution', 'source_hash_verification', 'runtime_initialization_barrier',
        ] }),
      };
    });
  } finally { collector.release(requestId); }
}
