import type { IMetadataStore } from '../types/index.js';
import { supportsStructuredCatalog } from '../storage/interfaces/metadata-store.js';
import type { StructuredImportAuditRecord } from '../storage/interfaces/structured-catalog.js';
import type { StructuredDeclaration, StructuredImport } from '../structured/contracts.js';
import { sameSorted } from './integrity-preflight-shared.js';
import type { CatalogRead, IntegrityPreparedFile } from './integrity-preflight-types.js';

export type CatalogAuditResult = Readonly<{
  readonly status: 'matches' | 'changed' | 'corrupt' | 'unknown';
  readonly evidence: string;
}>;

const declarationKey = (declaration: StructuredDeclaration): string => JSON.stringify([
  declaration.symbolId, declaration.name, declaration.qualifiedName, declaration.kind,
  declaration.signatureDiscriminator, declaration.position.startLine, declaration.position.startColumn,
  declaration.position.endLine, declaration.position.endColumn, declaration.startByte, declaration.endByte,
  declaration.sourceHash, declaration.parentSymbolId ?? null, declaration.languageId, declaration.isExact,
]);

const importKey = (imported: Readonly<{
  id: string;
  moduleSpecifier?: string | undefined;
  bindingName?: string | undefined;
  startByte: number;
  endByte: number;
  sourceHash: string;
  completeness: 'complete' | 'partial';
}>): string => JSON.stringify([
  imported.id, imported.moduleSpecifier ?? null, imported.bindingName ?? null,
  imported.startByte, imported.endByte, imported.sourceHash, imported.completeness,
]);

const importAuditKey = (imported: StructuredImport | StructuredImportAuditRecord): string => JSON.stringify([
  importKey(imported), imported.position.startLine, imported.position.startColumn,
  imported.position.endLine, imported.position.endColumn,
]);

export async function readCatalog(metadataStore: IMetadataStore, enabled: boolean): Promise<CatalogRead | undefined> {
  if (!enabled) return undefined;
  if (!supportsStructuredCatalog(metadataStore)) throw new Error('catalog_audit_unavailable');
  const state = await metadataStore.getStructuredIndexState();
  return { epoch: state.rebuildEpoch, active: state.activeGenerations, state };
}

function activeGenerationMatches(
  files: readonly IntegrityPreparedFile[],
  active: ReadonlyMap<string, string>,
): 'matches' | 'changed' | 'corrupt' {
  const expected = new Map<string, string>();
  for (const file of files) {
    if (file.structured !== undefined) expected.set(file.event.filePath, file.structured.generation.generationId);
  }
  for (const [filePath, generationId] of active) {
    const expectedGeneration = expected.get(filePath);
    if (expectedGeneration === undefined || expectedGeneration !== generationId) return 'changed';
  }
  for (const [filePath] of expected) {
    if (!active.has(filePath)) return 'corrupt';
  }
  return 'matches';
}

export async function catalogMatches(
  metadataStore: IMetadataStore,
  files: readonly IntegrityPreparedFile[],
  catalog: CatalogRead,
): Promise<CatalogAuditResult> {
  const evidence: string[] = [JSON.stringify({
    schemaVersion: catalog.state.schemaVersion,
    rebuildState: catalog.state.rebuildState,
    rebuildEpoch: catalog.state.rebuildEpoch,
    lastErrorCode: catalog.state.lastErrorCode,
    counts: catalog.state.counts,
    active: [...catalog.active].sort(([left], [right]) => left.localeCompare(right)),
  })];
  if (catalog.state.counts.pendingFiles > 0) return { status: 'corrupt', evidence: evidence.join('|') };
  if (catalog.state.schemaVersion === null || catalog.state.reindexRequired || catalog.state.rebuildState !== 'idle') {
    return { status: 'unknown', evidence: evidence.join('|') };
  }
  const generationMatch = activeGenerationMatches(files, catalog.active);
  if (generationMatch !== 'matches') return { status: generationMatch, evidence: evidence.join('|') };
  if (!supportsStructuredCatalog(metadataStore)) return { status: 'unknown', evidence: evidence.join('|') };
  for (const file of files) {
    const structured = file.structured;
    if (structured === undefined) continue;
    const filePath = file.event.filePath;
    const generation = await metadataStore.getGeneration(filePath, structured.generation.generationId);
    if (generation === null) {
      evidence.push(JSON.stringify([filePath, structured.generation.generationId, null]));
      return { status: 'corrupt', evidence: evidence.join('|') };
    }
    const declarations = await metadataStore.getFileDeclarations(filePath);
    const imports = await metadataStore.getFileImports(filePath, structured.generation.generationId);
    const expectedImports = new Map(structured.imports.map((imported) => [imported.id, imported]));
    const bindings = await Promise.all(structured.declarations.map(async (declaration) => ({
      symbolId: declaration.symbolId,
      rows: await metadataStore.getImportsForSymbol(declaration.symbolId),
      expected: (declaration.importBindingIds ?? []).flatMap((id) => {
        const imported = expectedImports.get(id);
        return imported === undefined ? [] : [imported];
      }),
    })));
    evidence.push(JSON.stringify([
      filePath,
      generation,
      declarations.map(declarationKey).sort((left, right) => left.localeCompare(right)),
      imports.map(importAuditKey).sort((left, right) => left.localeCompare(right)),
      bindings.map((binding) => [binding.symbolId, binding.rows.map(importKey)
        .sort((left, right) => left.localeCompare(right))])
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    ]));
    if (generation.parserId !== structured.generation.parserId
      || generation.parserVersion !== structured.generation.parserVersion) {
      return { status: 'changed', evidence: evidence.join('|') };
    }
    if (generation.schemaVersion !== structured.generation.schemaVersion
      || generation.fileHash !== structured.generation.fileHash
      || generation.fileCompleteness !== structured.fileCompleteness
      || generation.rebuildEpoch !== catalog.epoch) {
      return { status: 'corrupt', evidence: evidence.join('|') };
    }
    if (!sameSorted(structured.declarations, declarations, declarationKey)
      || !sameSorted(structured.imports, imports, importAuditKey)
      || bindings.some((binding) => !sameSorted(binding.expected, binding.rows, importKey))) {
      return { status: 'corrupt', evidence: evidence.join('|') };
    }
  }
  return { status: 'matches', evidence: evidence.join('|') };
}
