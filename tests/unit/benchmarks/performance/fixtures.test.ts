import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { generateFixture, applyIncrement } from '../../../benchmarks/performance/fixtures.js';
import { profiles } from '../../../benchmarks/performance/profiles.js';
import { fixtureManifestSchema } from '../../../benchmarks/performance/contracts.js';
import { Chunker } from '../../../../src/indexer/chunker.js';
import { PluginRegistry } from '../../../../src/plugins/registry.js';
import { TypeScriptLanguagePlugin } from '../../../../src/plugins/languages/typescript.js';

const roots: string[] = [];
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nexus-perf-fixture-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('performance fixtures', () => {
  it('profile_sizes_are_fixed', () => {
    // Given / When: workload selection must preserve the published recipe.
    const actual = profiles;
    // Then: changing scale silently changes the benchmark workload.
    expect(actual).toEqual({
      smoke: { files: 20, declarationsPerFile: 5 },
      small: { files: 100, declarationsPerFile: 10 },
      medium: { files: 1_000, declarationsPerFile: 10 },
      large: { files: 10_000, declarationsPerFile: 10 },
    });
  });

  it('generates identical manifests in independent roots', async () => {
    // Given
    const firstRoot = await temporaryRoot();
    const secondRoot = await temporaryRoot();
    // When
    const manifests = await Promise.all([
      generateFixture(firstRoot, 'smoke'), generateFixture(secondRoot, 'smoke'),
    ]);
    // Then
    expect(manifests[0]).toEqual(manifests[1]);
    expect(JSON.stringify(manifests)).not.toContain(firstRoot);
    expect(JSON.stringify(manifests)).not.toContain(secondRoot);
  });

  it('accounts for UTF-8 bytes, declarations, imports and each physical row view', async () => {
    // Given
    const root = await temporaryRoot();
    // When
    const manifest = await generateFixture(root, 'smoke');
    const sources = await Promise.all(manifest.files.map((file) => readFile(join(root, file.path))));
    // Then
    expect(manifest.files).toHaveLength(20);
    expect(manifest.bytes).toBe(sources.reduce((total, source) => total + source.byteLength, 0));
    expect(manifest.files.reduce((total, file) => total + file.declarations.length, 0)).toBe(100);
    expect(manifest.files.reduce((total, file) => total + file.imports.length, 0)).toBe(20);
    expect(manifest.files.reduce((total, file) => total + file.legacyRows.length, 0)).toBe(120);
    expect(manifest.files.reduce((total, file) => total + file.structuredRows.length, 0)).toBe(100);
    sources.forEach((source, index) => {
      expect(manifest.files[index]?.sourceHash).toBe(createHash('sha256').update(source).digest('hex'));
      expect(manifest.files[index]?.bytes).toBe(source.byteLength);
    });
    expect(fixtureManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('fixes the complete 125-line Hybrid branch independently of the final limit', async () => {
    // Given
    const root = await temporaryRoot();
    // When
    const manifest = await generateFixture(root, 'smoke');
    const query = manifest.queries.find((item) => item.id === 'hybrid-pre-fusion-125');
    // Then
    expect(query?.expectedMatches).toHaveLength(125);
    expect(query?.expectedMatches.reduce((count, match) => count + match.submatches.length, 0)).toBe(125);
    expect(query?.args).toMatchObject({ topK: 20 });
    expect(query?.limits).toContainEqual({ stage: 'grep', behavior: 'uncapped' });
    expect(manifest.queries.find((item) => item.id === 'grep-broad')?.expectedMatches.length).toBeGreaterThan(100);
    expect(manifest.queries.find((item) => item.id === 'grep-no-match')?.expectedMatches).toEqual([]);
  });

  it('applies one added, modified and deleted file without mutating the original manifest', async () => {
    // Given
    const root = await temporaryRoot();
    const before = await generateFixture(root, 'smoke');
    const original = JSON.stringify(before);
    // When
    const result = await applyIncrement(root, before);
    // Then
    expect(result.events.map((event) => event.type).sort()).toEqual(['added', 'deleted', 'modified']);
    expect(new Set(result.events.map((event) => event.filePath)).size).toBe(3);
    expect(result.manifest.files).toHaveLength(20);
    expect(result.manifest.digest).not.toBe(before.digest);
    expect(JSON.stringify(before)).toBe(original);
    const deleted = result.events.find((event) => event.type === 'deleted');
    expect(result.manifest.files.some((file) => file.path === deleted?.filePath)).toBe(false);
  });

  it('keeps distinct chunk hashes and intentionally repeated helper content', async () => {
    // Given
    const root = await temporaryRoot();
    // When
    const manifest = await generateFixture(root, 'smoke');
    const helpers = manifest.files.flatMap((file) => file.structuredRows.filter((row) => row.name === 'sharedHelper'));
    // Then
    expect(helpers).toHaveLength(20);
    expect(new Set(helpers.map((row) => row.contentHash)).size).toBe(1);
    expect(helpers.every((row) => row.contentHash.length === 16 && row.sourceHash.length === 64)).toBe(true);
    expect(manifest.files.every((file) => file.legacyRows.every((row) => row.contentHash !== file.sourceHash))).toBe(true);
  });

  it('rejects unsafe paths embedded in an otherwise valid manifest', async () => {
    const root = await temporaryRoot();
    const manifest = await generateFixture(root, 'smoke');
    const first = manifest.files[0];
    const result = fixtureManifestSchema.safeParse({
      ...manifest, files: [{ ...first, path: '../escape.ts' }, ...manifest.files.slice(1)],
    });
    expect(result.success).toBe(false);
  });

  it('predicts production chunk content hashes and spans without deriving the manifest from a parser', async () => {
    const root = await temporaryRoot();
    const manifest = await generateFixture(root, 'smoke');
    const expected = manifest.files[0];
    if (expected === undefined) throw new Error('fixture required');
    const content = await readFile(join(root, expected.path), 'utf8');
    const registry = new PluginRegistry();
    const language = new TypeScriptLanguagePlugin();
    registry.registerLanguage(language);
    const chunker = new Chunker(registry, { maxChunkChars: 4096 });
    const source = { filePath: expected.path, language: 'typescript', content, bytes: Buffer.from(content) };
    const parser = await language.createStructuredParser();
    const parsed = await parser.parseStructured({ ...source, text: content });
    const legacy = await chunker.chunkFiles([source]);
    const structured = await chunker.chunkStructuredFile(source, parsed);
    const view = (rows: readonly { id: string; hash: string; startLine: number; endLine: number }[]) =>
      rows.map((row) => ({ key: row.id, contentHash: row.hash, startLine: row.startLine, endLine: row.endLine }));
    const byKey = (left: { key: string }, right: { key: string }): number =>
      left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
    for (const [actual, predictions] of [[view(legacy), expected.legacyRows], [view(structured), expected.structuredRows]] as const) {
      expect(actual.toSorted(byKey)).toEqual(predictions.map(({ key, contentHash, startLine, endLine }) =>
        ({ key, contentHash, startLine, endLine })).toSorted(byKey));
    }
    expect(parsed.declarations.map((item) => item.signatureDiscriminator)).toEqual(expected.declarations.map((item) => item.signature));
  });
});
