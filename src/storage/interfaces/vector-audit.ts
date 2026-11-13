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
const vectorIterable = z.custom<Iterable<unknown>>(
  (value) => typeof value === 'object' && value !== null && Symbol.iterator in value,
);
const physicalVector = z.preprocess((value) => {
  if (Array.isArray(value)) return value;
  const parsed = vectorIterable.safeParse(value);
  return parsed.success ? Array.from(parsed.data) : value;
}, z.array(z.number().or(z.nan())).readonly());
const physicalIdentity = {
  id: z.string(), filePath: z.string(), name: z.string(), kind: z.string(), contentHash: z.string(),
  startLine: z.number().int(), endLine: z.number().int(), vector: physicalVector,
};
export const physicalVectorRowSchema = z.discriminatedUnion('view', [
  z.object({ ...physicalIdentity, view: z.literal('legacy'), generationId: z.string().nullable().optional() }).strict(),
  z.object({ ...physicalIdentity, view: z.literal('structured'), generationId: z.string(),
    symbolId: z.string().nullable(), visibility: z.enum(['pending', 'active']) }).strict(),
]).readonly();
export type PhysicalVectorRow = z.infer<typeof physicalVectorRowSchema>;
export interface VectorAuditOptions {
  readonly pageSize: number;
  readonly signal: AbortSignal;
}
export class VectorAuditReadError extends Error {
  constructor(readonly code: 'invalid_audit_page_size' | 'audit_reader_unavailable' | 'audit_snapshot_changed') {
    super(code);
    this.name = 'VectorAuditReadError';
  }
}
