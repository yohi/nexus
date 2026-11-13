import type { PhysicalVectorRow } from '../storage/interfaces/vector-audit.js';
import type { IntegrityAssessment, IntegrityPreparedFile } from './integrity-preflight-types.js';

function rowIdentity(row: PhysicalVectorRow): readonly (string | number | null)[] {
  const common = [row.view, row.id, row.filePath, row.name, row.kind, row.contentHash, row.startLine, row.endLine];
  if (row.view === 'legacy') return [...common, row.generationId ?? null];
  return [...common, row.generationId, row.symbolId, row.visibility];
}

export function rowKey(row: PhysicalVectorRow): string {
  return JSON.stringify([...rowIdentity(row), row.vector.map(Math.fround)]);
}

function countRows(rows: readonly PhysicalVectorRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = rowKey(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function validVector(vector: readonly number[], dimensions: number): boolean {
  return vector.length === dimensions && vector.every(Number.isFinite);
}

export function assessPhysicalRows(
  expected: readonly PhysicalVectorRow[] | undefined,
  actual: readonly PhysicalVectorRow[],
  dimensions: number,
): IntegrityAssessment {
  if (expected === undefined) return { kind: 'INTEGRITY_UNKNOWN', reason: 'expected_rows_unavailable' };
  if (expected.some((row) => !validVector(row.vector, dimensions))) {
    return { kind: 'INTEGRITY_UNKNOWN', reason: 'expected_vector_invalid' };
  }
  if (actual.some((row) => !validVector(row.vector, dimensions))) {
    return { kind: 'CORRUPTION_CONFIRMED', reason: 'invalid_vector' };
  }
  const expectedCounts = countRows(expected);
  const actualCounts = countRows(actual);
  if (expectedCounts.size !== actualCounts.size) {
    return { kind: 'CORRUPTION_CONFIRMED', reason: 'row_multiset_mismatch' };
  }
  for (const [key, count] of expectedCounts) {
    if (actualCounts.get(key) !== count) {
      return { kind: 'CORRUPTION_CONFIRMED', reason: 'row_multiset_mismatch' };
    }
  }
  return { kind: 'MATCH' };
}

export function expectedRowsWithVectors(
  files: readonly IntegrityPreparedFile[],
  l1: ReadonlyMap<string, readonly number[]>,
  l2: ReadonlyMap<string, number[]>,
  keyFor: (hash: string) => string,
): readonly PhysicalVectorRow[] | undefined {
  const rows: PhysicalVectorRow[] = [];
  for (const file of files) {
    const chunks = [
      ...file.chunks.map((chunk) => ({ view: 'legacy' as const, chunk })),
      ...(file.structured?.chunks.map((chunk) => ({ view: 'structured' as const, chunk })) ?? []),
    ];
    for (const { view, chunk } of chunks) {
      const key = keyFor(chunk.hash);
      const vector = l1.get(key) ?? l2.get(key);
      if (vector === undefined) return undefined;
      const identity = {
        id: chunk.id,
        filePath: chunk.filePath,
        name: chunk.symbolName ?? '',
        kind: chunk.symbolKind,
        contentHash: chunk.hash,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        vector,
      };
      if (view === 'legacy') {
        rows.push({
          view, ...identity,
          ...(chunk.generationId === undefined || chunk.generationId === '' ? {} : { generationId: chunk.generationId }),
        });
        continue;
      }
      const structured = file.structured;
      if (structured === undefined) return undefined;
      rows.push({
        view, ...identity, generationId: structured.generation.generationId,
        symbolId: chunk.symbolId ?? null, visibility: 'active',
      });
    }
  }
  return rows;
}
