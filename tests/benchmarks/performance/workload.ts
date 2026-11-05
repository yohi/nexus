import { z } from 'zod';
import type { FixtureManifest } from './contracts.js';

const count = z.number().int().nonnegative();
export const workloadSchema = z.object({ recipeVersion: z.literal('retrieval-performance-v1'),
  digest: z.string().regex(/^[a-f0-9]{64}$/), files: count, utf8Bytes: count, declarations: count, imports: count,
  legacyRows: count, structuredRows: count, provider: z.literal('test'), model: z.literal('nexus-synthetic-sha256-v1'),
  dimensions: z.literal(128), maxChunkChars: z.literal(4096),
  storage: z.object({ metadata: z.literal('sqlite'), vectors: z.literal('lancedb'),
    isolation: z.literal('owned_state_outside_source'), locations: z.literal('redacted') }).strict().readonly().default({
    metadata: 'sqlite', vectors: 'lancedb', isolation: 'owned_state_outside_source', locations: 'redacted' }),
}).strict().readonly();
export type WorkloadSummary = z.infer<typeof workloadSchema>;

export function summarizeFixture(manifest: FixtureManifest): WorkloadSummary {
  return workloadSchema.parse({ recipeVersion: manifest.version, digest: manifest.digest,
    files: manifest.files.length, utf8Bytes: manifest.bytes,
    declarations: manifest.files.reduce((total, file) => total + file.declarations.length, 0),
    imports: manifest.files.reduce((total, file) => total + file.imports.length, 0),
    legacyRows: manifest.files.reduce((total, file) => total + file.legacyRows.length, 0),
    structuredRows: manifest.files.reduce((total, file) => total + file.structuredRows.length, 0),
    provider: manifest.provider, model: manifest.model, dimensions: manifest.dimensions, maxChunkChars: manifest.maxChunkChars });
}
