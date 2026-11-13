import type { Table } from '@lancedb/lancedb';
import { z } from 'zod';
import { physicalVectorRowSchema, vectorAuditRowSchema, VectorAuditReadError } from './interfaces/vector-audit.js';
import type { PhysicalVectorRow, VectorAuditOptions, VectorAuditRow } from './interfaces/vector-audit.js';

const columns = ['id', 'filepath', 'symbolname', 'symbolkind', 'startline', 'endline', 'hash'];
const projectionSchema = z.object({
  id: z.string(), filepath: z.string(), symbolname: z.string(), symbolkind: z.string(),
  startline: z.number().int(), endline: z.number().int(), hash: z.string(),
  symbolid: z.string().nullable().optional(), generationid: z.string().optional(),
  visibility: z.literal('active').optional(),
}).strict();
const physicalRawRowSchema = z.object({
  id: z.unknown(), filepath: z.unknown(), symbolname: z.unknown(), symbolkind: z.unknown(),
  startline: z.unknown(), endline: z.unknown(), hash: z.unknown(), vector: z.unknown(),
  symbolid: z.unknown().optional(), generationid: z.unknown().optional(), visibility: z.unknown().optional(),
}).passthrough();
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

export async function* iteratePhysicalVectorRows(
  tables: Readonly<{ legacy?: Table; structured?: Table }>, options: Readonly<VectorAuditOptions>,
  read: ReadOperation,
): AsyncGenerator<PhysicalVectorRow> {
  if (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 512) {
    throw new VectorAuditReadError('invalid_audit_page_size');
  }
  const snapshotVersions = new Map<Table, number>();
  for (const table of [tables.legacy, tables.structured]) {
    if (table === undefined) continue;
    await read(() => table.checkoutLatest());
    snapshotVersions.set(table, await read(() => table.version()));
  }
  let legacyHasGenerationId = false;
  const legacyTable = tables.legacy;
  if (legacyTable !== undefined) {
    const schema = await read(() => legacyTable.schema());
    legacyHasGenerationId = schema.fields.some((field) => field.name === 'generationid');
  }
  for (const view of ['legacy', 'structured'] as const) {
    const table = tables[view];
    if (table === undefined) continue;
    for (let offset = 0; ; offset += options.pageSize) {
      options.signal.throwIfAborted();
      const rows = await read(() => table.query()
        .select(view === 'legacy'
          ? [...columns, 'vector', ...(legacyHasGenerationId ? ['generationid'] : [])]
          : [...columns, 'vector', 'symbolid', 'generationid', 'visibility'])
        .limit(options.pageSize).offset(offset).toArray());
      for (const raw of rows) {
        options.signal.throwIfAborted();
        const rawRow = physicalRawRowSchema.parse(raw);
        const identity = {
          id: rawRow['id'], filePath: rawRow['filepath'], name: rawRow['symbolname'],
          kind: rawRow['symbolkind'], contentHash: rawRow['hash'], startLine: rawRow['startline'],
          endLine: rawRow['endline'], vector: rawRow['vector'],
        };
        const legacyGenerationId = rawRow['generationid'];
        const row = physicalVectorRowSchema.parse(view === 'legacy'
          ? {
              view, ...identity,
              ...(legacyHasGenerationId && legacyGenerationId !== '' ? { generationId: legacyGenerationId } : {}),
            }
          : {
              view, ...identity, generationId: rawRow['generationid'], symbolId: rawRow['symbolid'],
              visibility: rawRow['visibility'],
            });
        yield row;
      }
      if (rows.length < options.pageSize) break;
    }
  }
  for (const [table, snapshotVersion] of snapshotVersions) {
    if (await read(() => table.version()) !== snapshotVersion) {
      throw new VectorAuditReadError('audit_snapshot_changed');
    }
  }
}
