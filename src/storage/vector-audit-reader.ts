import type { Table } from '@lancedb/lancedb';
import { z } from 'zod';
import { vectorAuditRowSchema, VectorAuditReadError } from './interfaces/vector-audit.js';
import type { VectorAuditOptions, VectorAuditRow } from './interfaces/vector-audit.js';

const columns = ['id', 'filepath', 'symbolname', 'symbolkind', 'startline', 'endline', 'hash'];
const projectionSchema = z.object({
  id: z.string(), filepath: z.string(), symbolname: z.string(), symbolkind: z.string(),
  startline: z.number().int(), endline: z.number().int(), hash: z.string(),
  symbolid: z.string().nullable().optional(), generationid: z.string().optional(),
  visibility: z.literal('active').optional(),
}).strict();
type ReadOperation = <T>(operation: () => Promise<T>) => Promise<T>;

export async function* iterateVectorAuditRows(
  tables: Readonly<{ legacy?: Table; structured?: Table }>, options: Readonly<VectorAuditOptions>,
  read: ReadOperation,
): AsyncGenerator<VectorAuditRow> {
  if (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 512) {
    throw new VectorAuditReadError('invalid_audit_page_size');
  }
  for (const view of ['legacy', 'structured'] as const) {
    const table = tables[view];
    if (table === undefined) continue;
    for (let offset = 0; ; offset += options.pageSize) {
      options.signal.throwIfAborted();
      const rows = await read(() => {
        const query = table.query().select(view === 'legacy' ? [...columns] : [...columns, 'symbolid', 'generationid', 'visibility']);
        if (view === 'structured') query.where("visibility = 'active'");
        return query.limit(options.pageSize).offset(offset).toArray();
      });
      for (const raw of rows) {
        options.signal.throwIfAborted();
        const row = projectionSchema.parse(raw);
        const identity = { id: row.id, filePath: row.filepath, name: row.symbolname, kind: row.symbolkind,
          contentHash: row.hash, startLine: row.startline, endLine: row.endline };
        yield vectorAuditRowSchema.parse(view === 'legacy' ? { view, ...identity }
          : { view, ...identity, generationId: row.generationid, symbolId: row.symbolid });
      }
      if (rows.length < options.pageSize) break;
    }
  }
}
