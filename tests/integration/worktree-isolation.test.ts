import { execFile } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/index.js';
import { createRuntimeAssembly } from '../../src/server/runtime-assembly.js';
import type { RuntimeAssembly } from '../../src/server/runtime/assembly-types.js';
import { createDisposableWorktreeSet } from '../benchmarks/performance/git-fixture.js';
import type { DisposableWorktreeSet } from '../benchmarks/performance/git-fixture.js';
import { createSyntheticProvider, syntheticEmbeddingConfig } from '../benchmarks/performance/synthetic-provider.js';

const git = promisify(execFile);
const roles = ['primary', 'linkedA', 'linkedB'] as const;
type Role = (typeof roles)[number];
const sentinelFile = (role: Role) => `sentinel-${role}.ts`;
const sentinelSymbol = (role: Role) => `uniqueSentinel${role}Marker`;

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined); });

async function openWorktrees(): Promise<DisposableWorktreeSet | undefined> {
  const set = await createDisposableWorktreeSet('smoke', new AbortController().signal);
  if (set.status === 'skipped') return undefined; // environment unavailable: git missing
  cleanups.push(set.dispose);
  return set;
}

async function writeSentinels(set: DisposableWorktreeSet): Promise<void> {
  for (const role of roles) {
    await writeFile(join(set[role], sentinelFile(role)), `export const ${sentinelSymbol(role)} = '${role}';\n`);
  }
}

async function startRuntime(projectRoot: string): Promise<RuntimeAssembly> {
  const config = await loadConfig({ projectRoot, env: {} });
  const assembly = await createRuntimeAssembly({ ...config, embedding: syntheticEmbeddingConfig },
    { createEmbeddingProvider: createSyntheticProvider });
  cleanups.push(async () => { await assembly.runtime.close(); });
  await assembly.runtime.initialize();
  await assembly.runtime.reindex(true);
  await assembly.options.pipeline.waitForActiveReindex();
  const deadline = Date.now() + 60_000;
  while (assembly.options.pipeline.getProgress().status !== 'idle' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return assembly;
}

type Hits = Awaited<ReturnType<RuntimeAssembly['options']['orchestrator']['search']>>;
// Grep hits are absolute paths; semantic hits are project-relative.
const hasFile = (response: Hits, file: string): boolean =>
  response.results.some((result) => result.chunk.filePath === file || result.chunk.filePath.endsWith(`/${file}`));

async function assertIsolated(role: Role, assembly: RuntimeAssembly): Promise<void> {
  const paths = await assembly.diagnostics.metadataStore.getAllPaths();
  expect(paths).toContain(sentinelFile(role));
  for (const other of roles.filter((candidate) => candidate !== role)) {
    expect(paths).not.toContain(sentinelFile(other));
    expect(await assembly.diagnostics.metadataStore.resolveFile(sentinelFile(other))).toEqual({ kind: 'missing' });
    const grep = await assembly.options.orchestrator.search({ query: sentinelSymbol(other), topK: 20 });
    expect(hasFile(grep, sentinelFile(other))).toBe(false);
  }
  const own = await assembly.options.orchestrator.search({ query: sentinelSymbol(role), topK: 20 });
  expect(hasFile(own, sentinelFile(role))).toBe(true);
  const declarations = await assembly.diagnostics.metadataStore.getFileDeclarations(sentinelFile(role));
  expect(declarations.map((declaration) => declaration.name)).toContain(sentinelSymbol(role));
}

describe('worktree isolation (disposable git worktrees)', () => {
  it('W01_primary_git_directory_and_linked_git_file', { timeout: 120_000 }, async () => {
    const set = await openWorktrees();
    if (set === undefined) return;
    expect((await lstat(join(set.primary, '.git'))).isDirectory()).toBe(true);
    for (const linked of [set.linkedA, set.linkedB]) {
      expect((await lstat(join(linked, '.git'))).isFile()).toBe(true);
      expect(await readFile(join(linked, '.git'), 'utf8')).toMatch(/^gitdir: /);
    }
    await writeSentinels(set);
    for (const role of roles) {
      const assembly = await startRuntime(set[role]);
      expect(await assembly.diagnostics.metadataStore.getAllPaths()).toContain(sentinelFile(role));
      await assembly.runtime.close();
    }
  });

  it('W02_independent_search_catalog_and_vector', { timeout: 180_000 }, async () => {
    const set = await openWorktrees();
    if (set === undefined) return;
    await writeSentinels(set);
    const assemblies = new Map<Role, RuntimeAssembly>();
    for (const role of roles) assemblies.set(role, await startRuntime(set[role]));
    const roots = new Set<string>();
    for (const role of roles) {
      const assembly = assemblies.get(role)!;
      roots.add(assembly.diagnostics.metadataDbPath);
      roots.add(assembly.diagnostics.vectorDbPath);
      expect(assembly.diagnostics.metadataDbPath.startsWith(join(set[role], '.nexus'))).toBe(true);
      expect(assembly.diagnostics.vectorDbPath.startsWith(join(set[role], '.nexus'))).toBe(true);
      await assertIsolated(role, assembly);
    }
    expect(roots.size).toBe(6); // distinct default .nexus roots for metadata and vectors
  });

  it('W03_detached_and_dirty_current_source', { timeout: 180_000 }, async () => {
    const set = await openWorktrees();
    if (set === undefined) return;
    const head = (await git('git', ['rev-parse', 'HEAD'], { cwd: set.primary })).stdout.trim();
    expect((await git('git', ['rev-parse', 'HEAD'], { cwd: set.linkedA })).stdout.trim()).toBe(head);
    expect((await git('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: set.linkedA }).catch((error: { code?: number }) => error.code)))
      .toBe(1); // detached
    await writeSentinels(set);
    await writeFile(join(set.linkedB, sentinelFile('linkedB')), `export const ${sentinelSymbol('linkedB')} = 'dirty-edit';\n// DIRTY_LINKED_B\n`);
    const assemblyA = await startRuntime(set.linkedA);
    const assemblyB = await startRuntime(set.linkedB);
    await assertIsolated('linkedA', assemblyA);
    const dirty = await assemblyB.options.orchestrator.search({ query: 'DIRTY_LINKED_B', topK: 20 });
    expect(hasFile(dirty, sentinelFile('linkedB'))).toBe(true);
    const clean = await assemblyA.options.orchestrator.search({ query: 'DIRTY_LINKED_B', topK: 20 });
    expect(hasFile(clean, sentinelFile('linkedB'))).toBe(false);
  });

  it('W07_non_git_start_and_restart', { timeout: 120_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'nexus-non-git-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'plain.ts'), `export const ${sentinelSymbol('primary')} = 1;\n`);
    const first = await startRuntime(root);
    const firstPaths = await first.diagnostics.metadataStore.getAllPaths();
    expect(firstPaths).toContain('src/plain.ts');
    await first.runtime.close();
    const second = await startRuntime(root);
    expect(await second.diagnostics.metadataStore.getAllPaths()).toEqual(firstPaths);
    const found = await second.options.orchestrator.search({ query: sentinelSymbol('primary'), topK: 5 });
    expect(hasFile(found, 'src/plain.ts')).toBe(true);
  });
});
