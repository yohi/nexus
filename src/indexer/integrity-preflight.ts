import { createHash } from 'node:crypto';
import type { IMetadataStore, MerkleNodeRow } from '../types/index.js';
import type { PhysicalVectorRow } from '../storage/interfaces/vector-audit.js';
import { assessPhysicalRows, expectedRowsWithVectors, rowKey } from './integrity-preflight-rows.js';
import { catalogMatches, readCatalog } from './integrity-preflight-catalog.js';
import { expectedMerkleNodes, merkleNodeKey } from './integrity-preflight-merkle.js';
import { sameSorted } from './integrity-preflight-shared.js';
import type { IntegrityPreflightInput, IntegrityPreflightResult } from './integrity-preflight-types.js';

const unknown = (reason: string): IntegrityPreflightResult => ({ kind: 'INTEGRITY_UNKNOWN', reason });

function recoveryFingerprint(
  epoch: number,
  nodes: readonly MerkleNodeRow[],
  input: IntegrityPreflightInput,
  stats: Awaited<ReturnType<IMetadataStore['getIndexStats']>>,
  catalogEvidence: string,
  expectedRows: readonly PhysicalVectorRow[],
  rows: readonly PhysicalVectorRow[],
): string {
  const payload = JSON.stringify({
    epoch,
    nodes: nodes.map(merkleNodeKey).sort((left, right) => left.localeCompare(right)),
    source: input.files.map((file) => [file.event.filePath, file.sourceHash, file.merkleHash])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
    stats,
    catalogEvidence,
    expectedRows: expectedRows.map(rowKey).sort((left, right) => left.localeCompare(right)),
    rows: rows.map(rowKey).sort((left, right) => left.localeCompare(right)),
  });
  return createHash('sha256').update(payload).digest('hex');
}

export async function runIntegrityPreflight(input: IntegrityPreflightInput): Promise<IntegrityPreflightResult> {
  try {
    input.assertWriterLease();
    input.signal.throwIfAborted();
    if (!input.queueIsQuiet()) return unknown('queued_filesystem_changes');
    if (input.events.some((event) => event.type !== 'added')
      || input.events.length !== input.files.length
      || new Set(input.events.map((event) => event.filePath)).size !== input.events.length) {
      return { kind: 'GENERATION_CHANGED' };
    }
    if (input.files.some((file) => file.skipped || file.structuredParseFailed)) {
      return unknown('preflight_input_incomplete');
    }
    if (input.files.some((file) => file.sourceHash.length === 0)) return unknown('source_identity_unavailable');

    const stats = await input.metadataStore.getIndexStats();
    if (stats?.lastIndexedAt === null || stats?.lastIndexedAt === undefined || stats.lastError !== null) {
      return { kind: 'GENERATION_CHANGED' };
    }
    if ((await input.metadataStore.getDeadLetterEntries()).length > 0) return { kind: 'GENERATION_CHANGED' };
    const recovery = await input.metadataStore.getFullRebuildRecovery?.();
    if (recovery !== null && recovery !== undefined) return unknown('recovery_journal_active');

    const initialNodes = await input.metadataStore.getAllNodes();
    const expectedNodes = await expectedMerkleNodes(input.files);
    if (!sameSorted(
      expectedNodes.filter((node) => !node.isDirectory),
      initialNodes.filter((node) => !node.isDirectory),
      merkleNodeKey,
    )) return { kind: 'GENERATION_CHANGED' };
    let corruptionConfirmed = !sameSorted(
      expectedNodes.filter((node) => node.isDirectory),
      initialNodes.filter((node) => node.isDirectory),
      merkleNodeKey,
    );

    const catalog = await readCatalog(input.metadataStore, input.catalogEnabled);
    let catalogEvidence = '';
    let catalogStatus: Awaited<ReturnType<typeof catalogMatches>>['status'] = 'matches';
    if (catalog !== undefined) {
      const result = await catalogMatches(input.metadataStore, input.files, catalog);
      catalogEvidence = result.evidence;
      catalogStatus = result.status;
      if (result.status === 'unknown') return unknown('catalog_audit_unavailable');
      if (result.status === 'changed') return { kind: 'GENERATION_CHANGED' };
      corruptionConfirmed ||= result.status === 'corrupt';
    }

    if (input.embeddingKeyFor === undefined) return unknown('embedding_identity_unavailable');
    const hashes = input.files.flatMap((file) => [
      ...file.chunks,
      ...(file.structured?.chunks ?? []),
    ]).map((chunk) => input.embeddingKeyFor?.(chunk.hash)).filter((key): key is string => key !== undefined);
    const l2 = hashes.length === 0
      ? new Map<string, number[]>()
      : await input.loadEmbeddingSource([...new Set(hashes)]);
    const expectedRows = expectedRowsWithVectors(input.files, input.l1Embeddings, l2, input.embeddingKeyFor);
    if (expectedRows === undefined) return unknown('expected_embedding_unavailable');

    const actualRows: PhysicalVectorRow[] = [];
    for await (const row of input.vectorStore.iteratePhysicalRows({ pageSize: 256, signal: input.signal })) {
      actualRows.push(row);
    }
    const physical = assessPhysicalRows(expectedRows, actualRows, input.dimensions);
    if (physical.kind === 'INTEGRITY_UNKNOWN') return unknown(physical.reason);
    corruptionConfirmed ||= physical.kind === 'CORRUPTION_CONFIRMED';
    const legacyRows = actualRows.filter((row) => row.view === 'legacy');
    const fileCount = new Set(legacyRows.map((row) => row.filePath)).size;
    const vectorStats = await input.vectorStore.getStats();
    corruptionConfirmed ||= vectorStats.totalChunks !== legacyRows.length || vectorStats.totalFiles !== fileCount;

    const currentNodes = await input.metadataStore.getAllNodes();
    const currentCatalog = await readCatalog(input.metadataStore, input.catalogEnabled);
    if (!sameSorted(initialNodes, currentNodes, merkleNodeKey)
      || catalog?.epoch !== currentCatalog?.epoch
      || (catalog !== undefined && currentCatalog !== undefined
        && !sameSorted([...catalog.active].map(([filePath, generationId]) => ({ filePath, generationId })),
          [...currentCatalog.active].map(([filePath, generationId]) => ({ filePath, generationId })),
          (entry) => JSON.stringify([entry.filePath, entry.generationId])))) {
      return unknown('state_changed_during_audit');
    }
    const currentStats = await input.metadataStore.getIndexStats();
    if (JSON.stringify(currentStats) !== JSON.stringify(stats)
      || (await input.metadataStore.getDeadLetterEntries()).length > 0) {
      return unknown('metadata_changed_during_audit');
    }
    if (catalog !== undefined && currentCatalog !== undefined) {
      const finalAudit = await catalogMatches(input.metadataStore, input.files, currentCatalog);
      if (finalAudit.status !== catalogStatus || finalAudit.evidence !== catalogEvidence) {
        return unknown('catalog_changed_during_audit');
      }
    }
    if (await input.metadataStore.getFullRebuildRecovery?.()) return unknown('recovery_journal_active');
    const rescanned = await input.rescan();
    if (!sameSorted(input.events, rescanned, (event) => JSON.stringify([event.type, event.filePath]))) {
      return unknown('source_scan_changed');
    }
    for (const file of input.files) {
      if (await input.readSourceHash(file.event.filePath) !== file.sourceHash) {
        return unknown('source_changed_during_audit');
      }
    }
    input.assertWriterLease();
    if (!input.queueIsQuiet()) return unknown('queued_filesystem_changes');

    const request = {
      rebuildEpoch: catalog?.epoch ?? 0,
      fingerprint: recoveryFingerprint(
        catalog?.epoch ?? 0, initialNodes, input, stats, catalogEvidence, expectedRows, actualRows,
      ),
    };
    const sourceIdentities = new Map(input.files.map((file) => [file.event.filePath, file.sourceHash]));
    return corruptionConfirmed
      ? { kind: 'CORRUPTION_CONFIRMED', request, sourceIdentities }
      : { kind: 'MATCH', request, sourceIdentities };
  } catch {
    return unknown('audit_incomplete');
  }
}
