import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LanceVectorStore } from '../../../src/storage/vector-store.js';
import { auditRuntime } from '../../benchmarks/performance/audit.js';
import { createAuditFixture, nativeFixturePath } from './audit-fixture.js';

const fixtures: Awaited<ReturnType<typeof createAuditFixture>>[] = [];
async function fixture() {
  const value = await createAuditFixture();
  fixtures.push(value);
  return value;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map((value) => value.close()));
});
const signal = (): AbortSignal => new AbortController().signal;

describe('audit failure completeness and resource ownership', () => {
  it('detects missing active imports without relying on declaration or vector counts', async () => {
    const current = await fixture();
    const file = current.manifest.files[0];
    if (file === undefined) throw new Error('file required');
    current.mutateCatalog((database) => {
      database.prepare('DELETE FROM imports WHERE file_path = ? AND generation = ?')
        .run(nativeFixturePath(file.path), file.sourceHash);
    });
    const result = await auditRuntime(current.assembly.diagnostics, current.manifest, signal());
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') expect(result.failures.map((failure) => failure.code)).toContain('catalog_import_mismatch');
  });

  it('checks generation metadata independently of active-vector membership', async () => {
    const current = await fixture();
    const file = current.manifest.files[0];
    if (file === undefined) throw new Error('file required');
    current.mutateCatalog((database) => {
      database.prepare('UPDATE symbol_generations SET content_hash = ? WHERE file_path = ? AND generation = ?')
        .run('0'.repeat(64), nativeFixturePath(file.path), file.sourceHash);
    });
    const result = await auditRuntime(current.assembly.diagnostics, current.manifest, signal());
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') expect(result.failures.map((failure) => failure.code)).toContain('catalog_generation_mismatch');
  });

  it('caps examples while retaining every mismatched-row failure count', async () => {
    const current = await fixture();
    const manifest = { ...current.manifest, files: current.manifest.files.map((file) => ({ ...file,
      legacyRows: file.legacyRows.map((row) => ({ ...row, contentHash: '0'.repeat(16) })) })) };
    const result = await auditRuntime(current.assembly.diagnostics, manifest, signal());
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      const mismatch = result.failures.find((failure) => failure.code === 'vector_hash_mismatch');
      expect(mismatch?.count).toBe(120);
      expect(mismatch?.examples).toHaveLength(20);
    }
  });

  it('closes the read-only catalog connection when cancellation occurs during file auditing', async () => {
    const current = await fixture();
    const controller = new AbortController();
    const original = current.assembly.diagnostics.metadataStore.getFileDeclarations.bind(current.assembly.diagnostics.metadataStore);
    vi.spyOn(current.assembly.diagnostics.metadataStore, 'getFileDeclarations').mockImplementationOnce(async (path) => {
      const result = await original(path);
      controller.abort();
      return result;
    });
    const close = vi.spyOn(Database.prototype, 'close');
    expect((await auditRuntime(current.assembly.diagnostics, current.manifest, controller.signal)).status).toBe('invalid');
    expect(close).toHaveBeenCalledOnce();
  });

  it('rejects an oversized read request before querying either native table', async () => {
    const current = await fixture();
    const iterator = current.assembly.diagnostics.vectorStore.iterateAuditRows({ pageSize: 513, signal: signal() })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toThrow('invalid_audit_page_size');
  });

  it('observes idle compaction as concurrent runtime work during an audit', async () => {
    const scheduling = vi.spyOn(LanceVectorStore.prototype, 'scheduleIdleCompaction');
    const current = await fixture();
    const callback = scheduling.mock.calls[0]?.[0];
    if (callback === undefined) throw new Error('idle callback required');
    const original = current.assembly.diagnostics.metadataStore.getFileDeclarations.bind(current.assembly.diagnostics.metadataStore);
    vi.spyOn(current.assembly.diagnostics.metadataStore, 'getFileDeclarations').mockImplementationOnce(async (path) => {
      const result = await original(path);
      await callback();
      return result;
    });
    const result = await auditRuntime(current.assembly.diagnostics, current.manifest, signal());
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') expect(result.failures.map((failure) => failure.code)).toContain('concurrent_mutation');
  });
});
