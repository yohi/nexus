import { z } from 'zod';

export const grepMatchSchema = z.object({ filePath: z.string(), lineNumber: z.number().int().positive(), lineText: z.string(),
  submatches: z.array(z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative(), match: z.string() })
    .refine((match) => match.end >= match.start)) });
export const searchResultSchema = z.object({
  source: z.enum(['semantic', 'grep', 'hybrid']), score: z.number().finite(),
  rank: z.number().int().positive().optional(), reciprocalRankScore: z.number().finite().optional(),
  chunk: z.object({ id: z.string(), filePath: z.string(), content: z.string(), hash: z.string(),
    startLine: z.number().int().positive(), endLine: z.number().int().positive(),
    symbolName: z.string().optional(), symbolKind: z.string(),
    symbolId: z.string().optional(), generationId: z.string().optional() }),
});
export const structuredStatusSchema = z.object({ status: z.literal('ok'), freshness: z.literal('fresh'), reindexRequired: z.literal(false) });
