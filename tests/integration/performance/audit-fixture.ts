import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import Database from 'better-sqlite3';
import { createSymbolId } from '../../../src/structured/identity.js';
import type { CodeChunk } from '../../../src/types/index.js';
import type { ExpectedRow, FixtureFile } from '../../benchmarks/performance/contracts.js';
import { generateFixture } from '../../benchmarks/performance/fixtures.js';
import { OutcomeCollector } from '../../benchmarks/performance/outcomes.js';
import { createBenchmarkRuntimeFactory } from '../../benchmarks/performance/runtime.js';

export async function createAuditFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-physical-audit-'));
  const source = join(directory, 'source');
  await mkdir(source);
  const root = await realpath(source);
  const manifest = await generateFixture(root, 'smoke');
  const collector = new OutcomeCollector();
  const assembly = await collector.run('construction', () => createBenchmarkRuntimeFactory(root, collector)(new AbortController().signal));
  try {
    await collector.run('initialization', async () => {
      await assembly.runtime.initialize();
      await assembly.options.pipeline.waitForActiveReindex();
      const outcome = await collector.seal('initialization');
      if (outcome.status !== 'valid') throw new Error('fixture_initialization_failed');
    });
    return {
      root, manifest, assembly,
      mutateCatalog: (operation: (database: Database.Database) => void) => {
        const database = new Database(assembly.diagnostics.metadataDbPath, { fileMustExist: true });
        try { operation(database); } finally { database.close(); }
      },
      close: async () => {
        collector.releaseAll();
        try { await assembly.runtime.close(); } finally { await rm(directory, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    collector.releaseAll();
    await assembly.runtime.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export const nativeFixturePath = (path: string): string => path.split('/').join(sep);

export function faultChunk(file: FixtureFile, row: ExpectedRow): CodeChunk {
  const filePath = nativeFixturePath(file.path);
  const declaration = file.declarations.find((item) => item.name === row.name);
  return {
    id: `${filePath}:${row.startLine}-${row.endLine}:${row.name}`, filePath,
    content: 'fault-injected payload', language: 'typescript', symbolName: row.name,
    symbolKind: row.kind, startLine: row.startLine, endLine: row.endLine, hash: row.contentHash,
    ...(declaration === undefined ? {} : { symbolId: createSymbolId({ filePath,
      qualifiedName: declaration.name, kind: 'function', signatureDiscriminator: declaration.signature, occurrence: 0 }) }),
  };
}
