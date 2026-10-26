import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getObservationContext } from '../../../src/observability/runtime-observer.js';
import type { GrepMultisetProof, QueryCase, RetrievalValidation } from './contracts.js';
import { validRetrievalValidationSchema } from './contracts.js';
import type { FixturePathNormalizer } from './logical-path.js';
import { GrepEvidenceStore, validateGrepEvidence } from './grep-evidence.js';
import type { RetrievalOutcomeContext } from './validation-context.js';
import { RetrievalError } from './validation-context.js';
import { grepMatchSchema, searchResultSchema } from './validation-shapes.js';
import { expectedSymbolId, physicalFixturePath } from './audit-manifest.js';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
type Identity = z.infer<typeof validRetrievalValidationSchema>['identities'][number];

async function logicalSearchPath(raw: string, outcomes: RetrievalOutcomeContext, normalize: FixturePathNormalizer): Promise<string> {
  const physical = outcomes.manifest.files.find((file) => physicalFixturePath(file.path) === raw);
  try { return await normalize(physical?.path ?? raw); }
  catch { throw new RetrievalError('invalid_result_path'); }
}

async function publicGrepProof(query: QueryCase, payload: unknown, normalize: FixturePathNormalizer) {
  const data = z.object({ matches: z.array(grepMatchSchema) }).parse(payload);
  const context = getObservationContext();
  if (context === undefined) throw new RetrievalError('execution_failed');
  const store = new GrepEvidenceStore();
  const reference = store.capture(context, data.matches);
  const proof = await validateGrepEvidence(reference, query, normalize);
  if (proof.status !== 'valid') throw new RetrievalError('grep_multiset_mismatch');
  const identities: Identity[] = [];
  for (const match of data.matches.slice(0, 20)) {
    const path = await normalize(match.filePath);
    identities.push({ path, line: match.lineNumber, origin: 'grep', stage: 'grep',
      identityDigest: sha(JSON.stringify([path, match.lineNumber, match.submatches.map((item) => [item.start, item.end, sha(item.match)])])) });
  }
  return { proof, identities, count: data.matches.length };
}

export async function validateSearchResponse(query: QueryCase, payload: unknown,
  context: Readonly<{ outcomes: RetrievalOutcomeContext; normalize: FixturePathNormalizer }>): Promise<RetrievalValidation> {
  const { outcomes, normalize } = context;
  const evidence = query.tool === 'grep_search' ? outcomes.execution.grepEvidence?.direct : outcomes.execution.grepEvidence?.hybrid;
  let grepProof: GrepMultisetProof | undefined;
  if (query.tool === 'grep_search' || query.tool === 'hybrid_search') {
    if (evidence === undefined) throw new RetrievalError('missing_grep_evidence');
    grepProof = await validateGrepEvidence(evidence, query, normalize);
    if (grepProof.status !== 'valid') throw new RetrievalError('grep_multiset_mismatch');
  }
  if (query.tool === 'grep_search') {
    const direct = await publicGrepProof(query, payload, normalize);
    return validRetrievalValidationSchema.parse({ status: 'valid', resultCount: direct.count,
      identities: direct.identities, grepProof });
  }
  const data = z.object({ results: z.array(searchResultSchema) }).parse(payload);
  const maximum = query.args.topK;
  if (typeof maximum !== 'number' || data.results.length > maximum || data.results.length === 0 ||
    (query.tool === 'hybrid_search' && data.results.length !== maximum)) throw new RetrievalError('effective_limit_mismatch');
  const identities: Identity[] = [];
  const seen = new Set<string>();
  for (const result of data.results) {
    outcomes.signal.throwIfAborted();
    const path = await logicalSearchPath(result.chunk.filePath, outcomes, normalize);
    const file = outcomes.manifest.files.find((item) => item.path === path);
    if (file === undefined) throw new RetrievalError('unknown_fixture_result');
    let stage: 'legacy' | 'structured' | 'grep' | undefined;
    let logicalKey: string | undefined;
    if (result.source === 'semantic' || result.source === 'hybrid') {
      for (const view of ['legacy', 'structured'] as const) {
        const rows = view === 'legacy' ? file.legacyRows : file.structuredRows;
        const row = rows.find((item) => result.chunk.id === `${physicalFixturePath(file.path)}:${item.startLine}-${item.endLine}:${item.name}` &&
          result.chunk.hash === item.contentHash && result.chunk.startLine === item.startLine && result.chunk.endLine === item.endLine &&
          result.chunk.symbolName === item.name && result.chunk.symbolKind === item.kind && sha(result.chunk.content) === item.sourceHash);
        if (row !== undefined && (view === 'legacy' ||
          ((result.chunk.generationId === undefined || result.chunk.generationId === file.sourceHash) &&
            result.chunk.symbolId === expectedSymbolId(file, row.name)))) {
          stage = view; logicalKey = `${path}:${row.startLine}-${row.endLine}:${row.name}`; break;
        }
      }
    }
    if (stage === undefined && (result.source === 'grep' || result.source === 'hybrid')) {
      const row = query.expectedMatches.find((item) => item.path === path && item.line === result.chunk.startLine &&
        result.chunk.endLine === item.line && item.lineDigest === sha(result.chunk.content));
      if (row !== undefined) { stage = 'grep'; logicalKey = `${path}:${row.line}`; }
    }
    if (stage === undefined || logicalKey === undefined) throw new RetrievalError('unknown_fixture_result');
    const key = sha(JSON.stringify([result.source, stage, logicalKey]));
    if (seen.has(key)) throw new RetrievalError('duplicate_result');
    seen.add(key);
    identities.push({ path, name: result.chunk.symbolName, line: result.chunk.startLine, origin: result.source, stage, identityDigest: key });
  }
  return validRetrievalValidationSchema.parse({ status: 'valid', resultCount: data.results.length, identities,
    ...(grepProof === undefined ? {} : { grepProof }) });
}
