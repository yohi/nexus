import { z } from 'zod';
import type { QueryCase, RetrievalValidation } from './contracts.js';
import { retrievalValidationSchema } from './contracts.js';
import type { FixturePathNormalizer } from './logical-path.js';
import type { RetrievalOutcomeContext } from './validation-context.js';
import { requireExecution, RetrievalError } from './validation-context.js';
import { validateSearchResponse } from './validate-search.js';
import { validateStructuredResponse } from './validate-structured.js';

const envelopeSchema = z.object({ isError: z.boolean().optional(), structuredContent: z.unknown(),
  content: z.array(z.object({ type: z.literal('text'), text: z.string() })).min(1) });

export async function validateHandlerResponse(query: QueryCase, envelope: unknown, outcomes: RetrievalOutcomeContext,
  normalizePath: FixturePathNormalizer): Promise<RetrievalValidation> {
  try {
    if (outcomes.signal.aborted) throw new RetrievalError('scenario_aborted');
    const parsed = envelopeSchema.safeParse(envelope);
    if (!parsed.success) throw new RetrievalError('malformed_envelope');
    if (parsed.data.isError) throw new RetrievalError('envelope_error');
    try {
      JSON.stringify(envelope);
      const text = parsed.data.content[0];
      if (parsed.data.content.length !== 1 || text === undefined) throw new RetrievalError('serialization_error');
      const rendered: unknown = JSON.parse(text.text);
      if (!isDeepStrictEqual(rendered, parsed.data.structuredContent)) throw new RetrievalError('serialization_error');
    }
    catch { throw new RetrievalError('serialization_error'); }
    requireExecution(query, outcomes);
    const context = { outcomes, normalize: normalizePath };
    let validation: RetrievalValidation;
    switch (query.tool) {
      case 'grep_search': case 'semantic_search': case 'hybrid_search':
        validation = await validateSearchResponse(query, parsed.data.structuredContent, context); break;
      case 'get_file_outline': case 'get_symbol_source': case 'get_symbol_context':
        validation = await validateStructuredResponse(query, parsed.data.structuredContent, context); break;
    }
    if (outcomes.signal.aborted) throw new RetrievalError('scenario_aborted');
    return validation;
  } catch (error) {
    const code = outcomes.signal.aborted ? 'scenario_aborted' : error instanceof RetrievalError ? error.code : 'malformed_response';
    return retrievalValidationSchema.parse({ status: 'invalid', failures: [{ code, count: 1, examples: [] }] });
  }
}
import { isDeepStrictEqual } from 'node:util';
