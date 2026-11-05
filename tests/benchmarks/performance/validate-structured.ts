import { createHash } from 'node:crypto';
import { z } from 'zod';
import { tokenCounter } from '../../../src/structured/tokenizer.js';
import type { QueryCase, RetrievalValidation } from './contracts.js';
import { validRetrievalValidationSchema } from './contracts.js';
import type { FixturePathNormalizer } from './logical-path.js';
import type { RetrievalOutcomeContext } from './validation-context.js';
import { RetrievalError } from './validation-context.js';
import { structuredStatusSchema } from './validation-shapes.js';
import { expectedSymbolId } from './audit-manifest.js';
import { findFixtureSymbol } from './validation-symbols.js';
import { createRecipe } from './fixture-recipe.js';
import { profiles } from './profiles.js';

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const positionSchema = z.object({ startLine: z.number().int().positive(), endLine: z.number().int().positive(),
  startColumn: z.number().int().nonnegative(), endColumn: z.number().int().nonnegative() });

export async function validateStructuredResponse(query: QueryCase, payload: unknown,
  context: Readonly<{ outcomes: RetrievalOutcomeContext; normalize: FixturePathNormalizer }>): Promise<RetrievalValidation> {
  if (!structuredStatusSchema.safeParse(payload).success) throw new RetrievalError('structured_not_success');
  const { outcomes, normalize } = context;
  if (query.tool === 'get_file_outline') {
    const data = structuredStatusSchema.extend({ file: z.object({ filePath: z.string(), language: z.literal('typescript') }),
      symbols: z.array(z.object({ symbolId: z.string(), name: z.string(), qualifiedName: z.string(), kind: z.literal('function'),
        signatureDiscriminator: z.string(), position: positionSchema, isExact: z.literal(true), languageId: z.literal('typescript') })) }).parse(payload);
    const path = await normalize(data.file.filePath);
    const requested = query.args.filePath;
    if (typeof requested !== 'string' || path !== await normalize(requested)) throw new RetrievalError('unknown_fixture_result');
    const file = outcomes.manifest.files.find((item) => item.path === path);
    if (file === undefined || data.symbols.length !== file.declarations.length) throw new RetrievalError('unknown_fixture_result');
    const seen = new Set<string>();
    for (const symbol of data.symbols) {
      const expected = file.declarations.find((item) => expectedSymbolId(file, item.name) === symbol.symbolId);
      if (expected === undefined || seen.has(symbol.symbolId) || symbol.name !== expected.name || symbol.qualifiedName !== expected.name ||
        symbol.signatureDiscriminator !== expected.signature || symbol.position.startLine !== expected.startLine ||
        symbol.position.endLine !== expected.endLine || symbol.position.startColumn !== 0 || symbol.position.endColumn !== 1) {
        throw new RetrievalError('unknown_fixture_result');
      }
      seen.add(symbol.symbolId);
    }
    return validRetrievalValidationSchema.parse({ status: 'valid', resultCount: data.symbols.length,
      identities: data.symbols.map((symbol) => ({ path, name: symbol.name, line: symbol.position.startLine,
        origin: 'structured', stage: 'outline', identityDigest: sha(JSON.stringify([path, 'outline', symbol.name])) })) });
  }
  const requested = query.args.symbolId;
  const symbol = typeof requested === 'string' ? findFixtureSymbol(outcomes.manifest, requested) : undefined;
  if (symbol === undefined) throw new RetrievalError('unknown_fixture_result');
  const path = await normalize(symbol.file.path);
  const request = z.object({ request: z.object({ symbolId: z.string() }) }).parse(payload);
  if (request.request.symbolId !== requested) throw new RetrievalError('unknown_fixture_result');
  let stage: 'symbol' | 'context';
  switch (query.tool) {
    case 'get_symbol_source': {
      const data = z.object({ source: z.string() }).parse(payload);
      if (sha(data.source) !== symbol.declaration.sourceHash) throw new RetrievalError('structured_source_mismatch');
      stage = 'symbol'; break;
    }
    case 'get_symbol_context': {
      const data = z.object({ context: z.string(), filePath: z.string(),
        imports: z.array(z.object({ id: z.string(), moduleSpecifier: z.string().optional(), startByte: z.number().int(), endByte: z.number().int().optional() })),
        budget: z.object({ requested: z.number().int().positive(), actual: z.number().int().nonnegative(), exceeded: z.boolean() }) }).parse(payload);
      const recipe = createRecipe(symbol.file.recipeIndex, profiles[outcomes.manifest.profile].files,
        outcomes.manifest.declarationsPerFile, symbol.file.variant);
      const source = recipe.drafts.find((item) => item.name === symbol.declaration.name)?.content;
      if (source === undefined || !data.context.includes(source) || await normalize(data.filePath) !== path) throw new RetrievalError('structured_source_mismatch');
      if (data.budget.requested !== query.args.tokenBudget || data.budget.actual !== tokenCounter.count(data.context) ||
        data.budget.actual > data.budget.requested || data.budget.exceeded) throw new RetrievalError('structured_budget_mismatch');
      const seen = new Set<string>();
      for (const imported of data.imports) {
        const expected = symbol.file.imports.find((item) => item.moduleSpecifier === imported.moduleSpecifier &&
          item.startByte === imported.startByte && item.endByte === imported.endByte);
        if (expected === undefined || seen.has(imported.id)) throw new RetrievalError('unknown_fixture_result');
        seen.add(imported.id);
      }
      stage = 'context'; break;
    }
    default: throw new RetrievalError('malformed_response');
  }
  return validRetrievalValidationSchema.parse({ status: 'valid', resultCount: 1,
    identities: [{ path, name: symbol.declaration.name, line: symbol.declaration.startLine, origin: 'structured', stage,
      identityDigest: sha(JSON.stringify([path, stage, symbol.declaration.name, symbol.declaration.sourceHash])) }] });
}
