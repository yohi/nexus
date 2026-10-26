import { sep } from 'node:path';
import { createSymbolId } from '../../../src/structured/identity.js';
import type { VectorAuditRow } from '../../../src/storage/interfaces/vector-audit.js';
import type { FixtureFile, FixtureManifest } from './contracts.js';
import type { AuditFailures } from './audit-failures.js';

export const physicalFixturePath = (path: string): string => path.split('/').join(sep);

export function expectedSymbolId(file: FixtureFile, name: string): string | undefined {
  const declaration = file.declarations.find((item) => item.name === name);
  return declaration === undefined ? undefined : createSymbolId({ filePath: physicalFixturePath(file.path),
    qualifiedName: declaration.name, kind: 'function', signatureDiscriminator: declaration.signature, occurrence: 0 });
}

export class AuditMembership {
  private readonly files = new Map<string, { file: FixtureFile; legacy: Uint8Array; structured: Uint8Array }>();
  private readonly legacyFiles = new Set<string>();
  private readonly structuredFiles = new Set<string>();

  constructor(manifest: FixtureManifest, private readonly failures: AuditFailures) {
    for (const file of manifest.files) this.files.set(physicalFixturePath(file.path), {
      file, legacy: new Uint8Array(file.legacyRows.length), structured: new Uint8Array(file.structuredRows.length),
    });
  }

  get fileCounts() { return { legacyFiles: this.legacyFiles.size, structuredFiles: this.structuredFiles.size }; }

  accept(row: VectorAuditRow): void {
    switch (row.view) {
      case 'legacy': this.legacyFiles.add(row.filePath); break;
      case 'structured': this.structuredFiles.add(row.filePath); break;
    }
    const state = this.files.get(row.filePath);
    if (state === undefined) { this.failures.add('unexpected_active_file'); return; }
    const expected = row.view === 'legacy' ? state.file.legacyRows : state.file.structuredRows;
    const index = expected.findIndex((item) => row.id === `${row.filePath}:${item.startLine}-${item.endLine}:${item.name}`);
    const target = expected[index];
    if (target === undefined) { this.failures.add('vector_identity_mismatch', 1, state.file.path); return; }
    if (state[row.view][index] !== 0) this.failures.add('duplicate_vector_row', 1, state.file.path);
    state[row.view][index] = 1;
    if (row.name !== target.name || row.kind !== target.kind) this.failures.add('vector_identity_mismatch', 1, state.file.path);
    if (row.contentHash !== target.contentHash) this.failures.add('vector_hash_mismatch', 1, state.file.path);
    if (row.startLine !== target.startLine || row.endLine !== target.endLine) this.failures.add('vector_span_mismatch', 1, state.file.path);
    if (row.view === 'structured' && (row.generationId !== state.file.sourceHash ||
      row.symbolId !== expectedSymbolId(state.file, target.name))) this.failures.add('vector_generation_mismatch', 1, state.file.path);
  }

  finish(complete: boolean): void {
    for (const [path, state] of this.files) {
      for (const view of ['legacy', 'structured'] as const) {
        if (complete) for (const seen of state[view]) if (seen === 0) this.failures.add('missing_vector_row', 1, state.file.path);
      }
      this.files.delete(path);
    }
    this.legacyFiles.clear();
    this.structuredFiles.clear();
  }
}
