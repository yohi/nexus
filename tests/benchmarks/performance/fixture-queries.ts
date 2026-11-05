import { createSymbolId } from '../../../src/structured/identity.js';
import type { ExpectedMatch, FixtureFile, QueryCase } from './contracts.js';
import { queryCaseSchema } from './contracts.js';
import { createRecipe, sha256 } from './fixture-recipe.js';

const patterns = [
  ['grep-selective', 'case00000_0-initial'],
  ['grep-broad', 'perf_broad'],
  ['grep-no-match', 'perf_absent_marker'],
  ['grep-early', 'perf_early'],
  ['grep-late', 'perf_late'],
  ['hybrid-pre-fusion-125', 'perf_hybrid_125'],
] as const;

export function fixtureQueries(files: readonly FixtureFile[], originalFileCount: number,
  declarationsPerFile: number): readonly QueryCase[] {
  const cases = patterns.map(([id, pattern]): QueryCase => {
    const expectedMatches: ExpectedMatch[] = [];
    for (const file of files) {
      const { text } = createRecipe(file.recipeIndex, originalFileCount, declarationsPerFile, file.variant);
      const lines = text.split('\n');
      for (const [index, line] of lines.entries()) {
        const bytes = Buffer.from(`${line}\n`);
        const needle = Buffer.from(pattern);
        const submatches: { start: number; end: number; contentDigest: string }[] = [];
        for (let start = bytes.indexOf(needle); start >= 0; start = bytes.indexOf(needle, start + needle.length)) {
          submatches.push({ start, end: start + needle.length, contentDigest: sha256(needle) });
        }
        if (submatches.length > 0) expectedMatches.push({
          path: file.path, line: index + 1, lineDigest: sha256(bytes), submatches,
        });
      }
    }
    const hybrid = id === 'hybrid-pre-fusion-125';
    return queryCaseSchema.parse({
      id, tool: hybrid ? 'hybrid_search' : 'grep_search',
      args: hybrid ? { query: pattern, grepPattern: pattern, topK: 20, includeSnippet: false }
        : { pattern, caseSensitive: true, maxResults: 100 },
      expectedMatches, requestedMaximum: hybrid ? 20 : 100,
      limits: hybrid ? [{ stage: 'grep', behavior: 'uncapped' }, { stage: 'fusion', behavior: 'top_k', maximum: 20 }]
        : [{ stage: 'grep', behavior: 'uncapped' }],
    });
  });
  const first = files[0];
  const declaration = first?.declarations[0];
  if (first === undefined || declaration === undefined) throw new RangeError('empty_fixture');
  const symbolId = createSymbolId({ filePath: first.path, qualifiedName: declaration.name,
    kind: 'function', signatureDiscriminator: declaration.signature, occurrence: 0 });
  return [...cases, ...[
    { id: 'semantic-selective', tool: 'semantic_search', args: { query: declaration.name, topK: 20 },
      requestedMaximum: 20, limits: [{ stage: 'semantic', behavior: 'top_k', maximum: 20 }] },
    { id: 'structured-outline', tool: 'get_file_outline', args: { filePath: first.path },
      requestedMaximum: declarationsPerFile, limits: [] },
    { id: 'structured-source', tool: 'get_symbol_source', args: { symbolId },
      requestedMaximum: 1, limits: [] },
    { id: 'structured-context', tool: 'get_symbol_context', args: { symbolId, tokenBudget: 1_000 },
      requestedMaximum: 1_000, limits: [{ stage: 'context', behavior: 'token_budget', maximum: 1_000 }] },
  ].map((item) => queryCaseSchema.parse({ ...item, expectedMatches: [] }))];
}
