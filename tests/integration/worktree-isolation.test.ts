import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';
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

async function openWorktrees(ctx: TestContext): Promise<DisposableWorktreeSet> {
  const set = await createDisposableWorktreeSet('smoke', new AbortController().signal);
  if (set.status === 'skipped') ctx.skip('environment unavailable: git is missing');
  cleanups.push(set.dispose);
  return set;
}

async function writeSentinels(set: DisposableWorktreeSet): Promise<void> {
  for (const role of roles) {
    await writeFile(join(set[role], sentinelFile(role)), `export const ${sentinelSymbol(role)} = '${role}';\n`);
  }
}

async function openRuntime(projectRoot: string, env: Record<string, string> = {}): Promise<RuntimeAssembly> {
  const config = await loadConfig({ projectRoot, env });
  const assembly = await createRuntimeAssembly({ ...config, embedding: syntheticEmbeddingConfig },
    { createEmbeddingProvider: createSyntheticProvider });
  cleanups.push(async () => { await assembly.runtime.close(); });
  return assembly;
}

async function waitIdle(assembly: RuntimeAssembly): Promise<void> {
  await assembly.options.pipeline.waitForActiveReindex();
  const deadline = Date.now() + 60_000;
  while (assembly.options.pipeline.getProgress().status !== 'idle' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function startRuntime(projectRoot: string, env: Record<string, string> = {}): Promise<RuntimeAssembly> {
  const assembly = await openRuntime(projectRoot, env);
  await assembly.runtime.initialize();
  await assembly.runtime.reindex(true);
  await waitIdle(assembly);
  return assembly;
}

/** Runs git against the disposable fixture repository with the fixture's isolated (non-user) git configuration. */
async function fixtureGit(set: DisposableWorktreeSet, args: readonly string[]): Promise<void> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  await git('git', [...args], { cwd: set.primary,
    env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dirname(set.primary), 'git-config'), GIT_ATTR_NOSYSTEM: '1' } });
}

/** Deletes a linked worktree (including its untracked default `.nexus`) and recreates a fresh incarnation at `path`. */
async function deleteAndRecreate(set: DisposableWorktreeSet, oldPath: string, newPath: string): Promise<void> {
  await fixtureGit(set, ['worktree', 'remove', '--force', oldPath]);
  await expect(lstat(oldPath)).rejects.toThrow();
  await fixtureGit(set, ['worktree', 'add', '--quiet', '--detach', newPath, 'HEAD']);
}

const externalStorageEnv = (storage: string): Record<string, string> => ({
  NEXUS_STORAGE_ROOT_DIR: storage,
  NEXUS_STORAGE_METADATA_DB_PATH: join(storage, 'metadata.db'),
  NEXUS_STORAGE_VECTOR_DB_PATH: join(storage, 'vectors'),
});

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
  for (const other of roles.filter((candidate) => candidate !== role)) {
    const foreign = await assembly.diagnostics.metadataStore.getFileDeclarations(sentinelFile(other));
    expect(foreign.map((declaration) => declaration.name)).not.toContain(sentinelSymbol(other));
  }
  const declarations = await assembly.diagnostics.metadataStore.getFileDeclarations(sentinelFile(role));
  expect(declarations.map((declaration) => declaration.name)).toContain(sentinelSymbol(role));
}

describe('worktree isolation (disposable git worktrees)', () => {
  it('W01_primary_git_directory_and_linked_git_file', { timeout: 120_000 }, async (ctx) => {
    const set = await openWorktrees(ctx);
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

  it('W02_independent_search_catalog_and_vector', { timeout: 180_000 }, async (ctx) => {
    const set = await openWorktrees(ctx);
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

  it('W03_detached_and_dirty_current_source', { timeout: 180_000 }, async (ctx) => {
    const set = await openWorktrees(ctx);
    const head = (await git('git', ['rev-parse', 'HEAD'], { cwd: set.primary })).stdout.trim();
    expect((await git('git', ['rev-parse', 'HEAD'], { cwd: set.linkedA })).stdout.trim()).toBe(head);
    expect((await git('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: set.linkedA }).catch((error: { code?: number }) => error.code)))
      .toBe(1); // detached
    await writeSentinels(set);
    await writeFile(join(set.linkedB, sentinelFile('linkedB')), `export const ${sentinelSymbol('linkedB')} = 'dirty-edit';\n// DIRTY_LINKED_B\n`);
    const assemblyA = await startRuntime(set.linkedA);
    const assemblyB = await startRuntime(set.linkedB);
    await assertIsolated('linkedA', assemblyA);
    await assertIsolated('linkedB', assemblyB);
    const dirty = await assemblyB.options.orchestrator.search({ query: 'DIRTY_LINKED_B', topK: 20 });
    expect(hasFile(dirty, sentinelFile('linkedB'))).toBe(true);
    const clean = await assemblyA.options.orchestrator.search({ query: 'DIRTY_LINKED_B', topK: 20 });
    expect(hasFile(clean, sentinelFile('linkedB'))).toBe(false);
  });

  // W06 (Design §4.6): delete/recreate a linked worktree. Old-incarnation-only content is an untracked file, so a
  // recreated checkout of the same commit never contains it; seeing it after recreation would be index leakage.
  const OLD_FILE = 'old-incarnation.ts';
  const OLD_SYMBOL = 'oldIncarnationOnlyMarker';
  const NEW_FILE = 'new-incarnation.ts';
  const NEW_SYMBOL = 'newIncarnationOnlyMarker';
  const writeOld = (root: string) => writeFile(join(root, OLD_FILE), `export const ${OLD_SYMBOL} = 'old';\n`);
  const writeNew = (root: string) => writeFile(join(root, NEW_FILE), `export const ${NEW_SYMBOL} = 'new';\n`);
  async function expectOnlyNewIncarnation(assembly: RuntimeAssembly): Promise<void> {
    const paths = await assembly.diagnostics.metadataStore.getAllPaths();
    expect(paths).toContain(NEW_FILE);
    expect(paths).not.toContain(OLD_FILE);
    expect(hasFile(await assembly.options.orchestrator.search({ query: OLD_SYMBOL, topK: 20 }), OLD_FILE)).toBe(false);
    expect(hasFile(await assembly.options.orchestrator.search({ query: NEW_SYMBOL, topK: 20 }), NEW_FILE)).toBe(true);
  }

  it('W06_different_path_recreation_default_storage', { timeout: 180_000 }, async (ctx) => {
    const set = await openWorktrees(ctx);
    await writeOld(set.linkedA);
    const old = await startRuntime(set.linkedA);
    expect(await old.diagnostics.metadataStore.getAllPaths()).toContain(OLD_FILE);
    await old.runtime.close();
    const moved = join(dirname(set.linkedA), 'linkedA-recreated');
    await deleteAndRecreate(set, set.linkedA, moved);
    await writeNew(moved);
    const fresh = await startRuntime(moved);
    expect(fresh.diagnostics.metadataDbPath).toBe(join(await realpath(moved), '.nexus', 'metadata.db'));
    await expectOnlyNewIncarnation(fresh);
  });

  it('W06_same_path_recreation_default_storage_live_old_writer_blocks_then_fresh_store', { timeout: 180_000 }, async (ctx) => {
    const set = await openWorktrees(ctx);
    await writeOld(set.linkedA);
    const old = await startRuntime(set.linkedA); // stays live (holds its kernel writer leases) across the deletion
    await deleteAndRecreate(set, set.linkedA, set.linkedA);
    await writeNew(set.linkedA);
    // The old live writer still holds the path-keyed leases: the recreated incarnation gets no second writer and the
    // refusal precedes any Storage bootstrap (no `.nexus` is created in the new checkout).
    const refused = await openRuntime(set.linkedA).then(() => undefined, (error: unknown) => error);
    expect(refused).toMatchObject({ code: 'writer_busy' });
    await expect(lstat(join(set.linkedA, '.nexus'))).rejects.toThrow();
    await old.runtime.close().catch(() => undefined);
    // Old writer gone: the deleted default store went with the old checkout, so the new incarnation starts clean.
    const fresh = await startRuntime(set.linkedA);
    await expectOnlyNewIncarnation(fresh);
  });

  /** Recursive byte digest of a directory tree (file contents by hash). */
  async function digestTree(path: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const walk = async (entry: string): Promise<void> => {
      const info = await lstat(entry);
      if (info.isDirectory()) {
        out[`${entry}/`] = 'dir';
        for (const name of (await readdir(entry)).sort()) await walk(join(entry, name));
      } else out[entry] = createHash('sha256').update(await readFile(entry)).digest('hex');
    };
    await walk(path);
    return out;
  }

  // W06-A/B (Design §4.6, W06 witness): with storage outside the worktree, the canonical project root of a same-path
  // recreation equals the old incarnation's, so only the worktree incarnation witness tells them apart.
  it('W06_same_path_recreation_external_storage_must_not_reuse_old_incarnation_store', { timeout: 180_000 }, async (ctx) => {
    const set = await openWorktrees(ctx);
    const storage = join(dirname(set.primary), 'external-storage');
    const env = externalStorageEnv(storage);
    await writeOld(set.linkedA);
    const old = await startRuntime(set.linkedA, env);
    expect(await old.diagnostics.metadataStore.getAllPaths()).toContain(OLD_FILE);
    await deleteAndRecreate(set, set.linkedA, set.linkedA);
    await writeNew(set.linkedA);
    // W06-A: while the old runtime is live the recreated incarnation is refused by the read-only incarnation check
    // before it even tries a writer lease, so the old runtime keeps its leases and gets no competing writer.
    expect(await openRuntime(set.linkedA, env).then(() => undefined, (error: unknown) => error))
      .toMatchObject({ code: 'incarnation_mismatch' });
    expect(hasFile(await old.options.orchestrator.search({ query: OLD_SYMBOL, topK: 20 }), OLD_FILE)).toBe(true);
    await old.runtime.close();
    // W06-B: old runtime gone; the recreated incarnation is refused and the old store is left byte-identical.
    const before = await digestTree(storage);
    expect(await openRuntime(set.linkedA, env).then(() => undefined, (error: unknown) => error))
      .toMatchObject({ code: 'incarnation_mismatch' });
    expect(await digestTree(storage)).toEqual(before);
    // A new, empty external storage works and never serves the old incarnation's entries.
    const fresh = await startRuntime(set.linkedA, externalStorageEnv(join(dirname(set.primary), 'external-storage-new')));
    await expectOnlyNewIncarnation(fresh);
  });

  // W06-C: the same worktree restarts onto its own external storage without a new witness and keeps its index.
  it('W06_same_worktree_external_storage_sequential_restart_keeps_index_and_witness', { timeout: 180_000 }, async (ctx) => {
    const set = await openWorktrees(ctx);
    const env = externalStorageEnv(join(dirname(set.primary), 'external-storage'));
    await writeOld(set.linkedA);
    const first = await startRuntime(set.linkedA, env);
    const witness = await readFile(join(set.linkedA, '.nexus', 'worktree-witness'));
    expect(await first.diagnostics.metadataStore.getAllPaths()).toContain(OLD_FILE);
    await first.runtime.close();
    const second = await startRuntime(set.linkedA, env);
    expect(await second.diagnostics.metadataStore.getAllPaths()).toContain(OLD_FILE);
    expect(hasFile(await second.options.orchestrator.search({ query: OLD_SYMBOL, topK: 20 }), OLD_FILE)).toBe(true);
    expect(await readFile(join(set.linkedA, '.nexus', 'worktree-witness'))).toEqual(witness);
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
