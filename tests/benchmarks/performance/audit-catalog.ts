import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import ts from 'typescript';
import { z } from 'zod';
import type { RuntimeDiagnostics } from '../../../src/server/runtime/assembly-types.js';
import type { FixtureManifest } from './contracts.js';
import type { AuditProgress } from './audit-failures.js';
import { expectedSymbolId, physicalFixturePath } from './audit-manifest.js';
import { sha256 } from './fixture-recipe.js';
import { incrementRuntimeDiagnosticCounter } from '../../../src/observability/diagnostic-stage-trace.js';

const importRowSchema = z.object({ id: z.string(), moduleSpecifier: z.string(), bindingName: z.string(),
  startByte: z.number().int(), endByte: z.number().int(), sourceHash: z.string(),
  startLine: z.number().int(), endLine: z.number().int() }).strict();

export async function auditCatalog(reader: RuntimeDiagnostics, manifest: FixtureManifest,
  progress: Readonly<AuditProgress>): Promise<void> {
  const { signal, counts, failures } = progress;
  const database = new Database(reader.metadataDbPath, { readonly: true, fileMustExist: true });
  try {
    const imports = database.prepare(`SELECT id, source AS moduleSpecifier, imported_names AS bindingName,
      start_byte AS startByte, end_byte AS endByte, source_hash AS sourceHash,
      start_line AS startLine, end_line AS endLine FROM imports
      WHERE file_path = ? AND generation = ? ORDER BY id LIMIT ? OFFSET ?`);
    for (const file of manifest.files) {
      signal.throwIfAborted();
      const failuresBeforeFile = failures.records().reduce((total, failure) => total + failure.count, 0);
      const path = physicalFixturePath(file.path);
      incrementRuntimeDiagnosticCounter({ stageId: 'S10_manifest_audit', counterId: 'audit.catalog_files_attempted', delta: 1, unit: 'files', semantics: 'attempted', sampleReason: 'threshold' });
      try {
        const generation = await reader.metadataStore.getGeneration(path, file.sourceHash);
        if (generation === null || generation.generationId !== file.sourceHash || generation.fileHash !== file.sourceHash ||
          generation.schemaVersion !== 1 || generation.parserId !== 'typescript' || generation.parserVersion !== ts.version ||
          generation.fileCompleteness !== 'complete') failures.add('catalog_generation_mismatch', 1, file.path);
        const declarations = await reader.metadataStore.getFileDeclarations(path);
        counts.declarations += declarations.length;
        const seen = new Set<string>();
        for (const declaration of declarations) {
          const expected = file.declarations.find((item) => declaration.symbolId === expectedSymbolId(file, item.name));
          if (expected === undefined || seen.has(declaration.symbolId) || declaration.sourceHash !== expected.sourceHash ||
            declaration.name !== expected.name || declaration.qualifiedName !== expected.name || declaration.kind !== 'function' ||
            declaration.signatureDiscriminator !== expected.signature || declaration.startByte !== expected.startByte ||
            declaration.endByte !== expected.endByte || declaration.position.startLine !== expected.startLine ||
            declaration.position.endLine !== expected.endLine || declaration.position.startColumn !== 0 ||
            declaration.position.endColumn !== 1 || !declaration.isExact || declaration.languageId !== 'typescript') {
            failures.add('catalog_declaration_mismatch', 1, file.path);
          }
          seen.add(declaration.symbolId);
        }
        if (declarations.length !== file.declarations.length) failures.add('catalog_declaration_mismatch', 1, file.path);
        const seenImports = new Set<string>();
        for (let offset = 0; ; offset += 512) {
          signal.throwIfAborted();
          const page = imports.all(path, file.sourceHash, 512, offset);
          for (const raw of page) {
            const actual = importRowSchema.parse(raw);
            counts.imports += 1;
            const expected = file.imports.find((item) => actual.id === `import_v1_${createHash('sha256')
              .update(`${path}:${item.startByte}:${item.moduleSpecifier}:`, 'utf8').digest('base64url')}`);
            if (expected === undefined || seenImports.has(actual.id) || actual.moduleSpecifier !== expected.moduleSpecifier ||
              actual.bindingName !== '' || actual.startByte !== expected.startByte || actual.endByte !== expected.endByte ||
              actual.startLine !== expected.startLine || actual.endLine !== expected.endLine || actual.sourceHash !== expected.sourceHash) {
              failures.add('catalog_import_mismatch', 1, file.path);
            }
            seenImports.add(actual.id);
          }
          if (page.length < 512) break;
        }
        if (seenImports.size !== file.imports.length) failures.add('catalog_import_mismatch', 1, file.path);
      } catch (error) {
        if (signal.aborted) throw error;
        failures.add('catalog_read_error', 1, file.path);
      }
      try {
        const path = await reader.sanitizer.resolveExisting(file.path);
        if (path !== resolve(reader.sanitizer.getProjectRoot(), file.path)) failures.add('source_file_mismatch', 1, file.path);
        else {
          const bytes = await readFile(path);
          if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sourceHash) failures.add('source_file_mismatch', 1, file.path);
        }
      } catch (error) {
        if (signal.aborted) throw error;
        failures.add('source_file_mismatch', 1, file.path);
      }
      const failuresAfterFile = failures.records().reduce((total, failure) => total + failure.count, 0);
      if (failuresAfterFile === failuresBeforeFile) {
        incrementRuntimeDiagnosticCounter({ stageId: 'S10_manifest_audit', counterId: 'audit.catalog_files_verified', delta: 1, unit: 'files', semantics: 'verified', sampleReason: 'threshold' });
        incrementRuntimeDiagnosticCounter({ stageId: 'S10_manifest_audit', counterId: 'audit.declarations_verified', delta: file.declarations.length, unit: 'rows', semantics: 'verified', sampleReason: 'threshold' });
        incrementRuntimeDiagnosticCounter({ stageId: 'S10_manifest_audit', counterId: 'audit.imports_verified', delta: file.imports.length, unit: 'rows', semantics: 'verified', sampleReason: 'threshold' });
      }
    }
  } finally { database.close(); }
}
