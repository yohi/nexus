import { z } from 'zod';

const auditRow = z.object({
  id: z.string(), filePath: z.string(), name: z.string(), kind: z.string(), contentHash: z.string(),
  startLine: z.number().int(), endLine: z.number().int(),
});
export const vectorAuditRowSchema = z.discriminatedUnion('view', [
  auditRow.extend({ view: z.literal('legacy') }).strict(),
  auditRow.extend({ view: z.literal('structured'), generationId: z.string(), symbolId: z.string().nullable() }).strict(),
]).readonly();
export type VectorAuditRow = z.infer<typeof vectorAuditRowSchema>;
export interface VectorAuditOptions {
  readonly pageSize: number;
  readonly signal: AbortSignal;
}
export class VectorAuditReadError extends Error {
  constructor(readonly code: 'invalid_audit_page_size' | 'audit_reader_unavailable') {
    super(code);
    this.name = 'VectorAuditReadError';
  }
}
