import { lstat, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQualityFixture, applyQualityMutation, type OwnedQualityFixture } from '../../../tests/benchmarks/quality/fixtures.js';
import { captureOracleSnapshot, gradeTaskSource } from '../../../tests/benchmarks/quality/oracle.js';
import { createNexusAdapter } from '../../../tests/benchmarks/quality/adapters.js';
import { runQualityPair } from '../../../tests/benchmarks/quality/runner.js';
import { createBenchmarkRuntimeFactory } from '../../../tests/benchmarks/performance/runtime.js';
import { buildToolHandlers } from '../../../src/server/tools/tool-support.js';
import type { IStructuredCatalog } from '../../../src/storage/interfaces/structured-catalog.js';
import type { readCanonicalSource as ReadCanonicalSource } from '../../../src/lsp/target-resolver.js';
import { sha256 } from '../../../tests/benchmarks/performance/fixture-recipe.js';

type TargetResolverModule = Record<string, unknown> & {
  readonly readCanonicalSource: typeof ReadCanonicalSource;
};

const injection = vi.hoisted(() => ({
  targetPath: null as string | null,
  afterCanonicalRead: null as null | (() => Promise<void>),
}));

vi.mock('../../../src/lsp/target-resolver.js', async (importOriginal) => {
  const actual = await importOriginal<TargetResolverModule>();
  return {
    ...actual,
    readCanonicalSource: async (input: Parameters<typeof actual.readCanonicalSource>[0]) => {
      const snapshot = await actual.readCanonicalSource(input);
      if (input.filePath === injection.targetPath && injection.afterCanonicalRead !== null) {
        const mutation = injection.afterCanonicalRead;
        injection.afterCanonicalRead = null;
        await mutation();
      }
      return snapshot;
    },
  };
});

describe('Q08 structured retrieval contract probe', () => {
  let fixture: OwnedQualityFixture | undefined;

  afterEach(async () => {
    injection.targetPath = null;
    injection.afterCanonicalRead = null;
    await fixture?.dispose();
    fixture = undefined;
  });

  it('records the real in-request deletion and grades the returned source against the post-mutation snapshot', async () => {
    fixture = await createQualityFixture(['Q08@quality-v1'], new AbortController().signal);
    const task = fixture.oracleCases[0];
    const root = fixture.roots.single;
    const filePath = task?.expectedFiles[0];
    const expectedSymbol = task?.expectedSymbols[0];
    if (task === undefined || root === undefined || filePath === undefined || expectedSymbol === undefined) {
      throw new Error('Q08 contract fixture missing');
    }

    const lifecycle: string[] = [];
    const assembly = await createBenchmarkRuntimeFactory(root)(new AbortController().signal);
    const catalog = assembly.options.metadataStore as unknown as IStructuredCatalog;
    const originalGetGeneration = catalog.getGeneration.bind(catalog);
    let trackingSourceRetrieval = false;
    catalog.getGeneration = async (...args: Parameters<IStructuredCatalog['getGeneration']>) => {
      const generation = await originalGetGeneration(...args);
      if (generation === null) return null;
      return new Proxy(generation, {
        get(target, property, receiver) {
          if (trackingSourceRetrieval && property === 'fileHash') lifecycle.push('product_freshness_check');
          return Reflect.get(target, property, receiver) as typeof generation;
        },
      });
    };

    try {
      await assembly.runtime.initialize();
      await assembly.runtime.reindex();
      await assembly.options.watcher.stop();
      const adapter = createNexusAdapter(
        buildToolHandlers(assembly.options, assembly.runtime.initialize.bind(assembly.runtime)),
      );
      const signal = new AbortController().signal;
      const outline = await adapter.invoke('get_file_outline', { filePath }, signal, { traceSequence: 1 });
      const symbolId = outline.results.find(({ preview }) => preview === expectedSymbol.name)?.symbolId;
      if (symbolId === undefined) throw new Error('Q08 contract symbol identity missing');

      lifecycle.push('request_started');
      const requestSnapshot = await captureOracleSnapshot(fixture, 'single', task.taskId);
      lifecycle.push('request_snapshot');
      lifecycle.push('source_retrieval_started');
      trackingSourceRetrieval = true;
      let postMutationSnapshot: Awaited<ReturnType<typeof captureOracleSnapshot>> | undefined;
      injection.targetPath = filePath;
      injection.afterCanonicalRead = async () => {
        lifecycle.push('mutation_hook_fired');
        const target = join(root, filePath);
        expect((await lstat(target)).isFile()).toBe(true);
        await applyQualityMutation(fixture as OwnedQualityFixture, task.taskId, 'during_request');
        await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
        lifecycle.push('file_delete_completed');
        postMutationSnapshot = await captureOracleSnapshot(fixture as OwnedQualityFixture, 'single', task.taskId);
        lifecycle.push('post_mutation_snapshot');
      };

      const response = await adapter.invoke(
        'get_symbol_source',
        { symbolId },
        signal,
        { traceSequence: 2 },
      );
      lifecycle.push('tool_response');
      const adoption = response.sourceAdoptions[0];
      expect(adoption).toBeDefined();
      if (adoption === undefined || postMutationSnapshot === undefined) {
        throw new Error('Q08 contract evidence missing');
      }
      expect(response.status).toBe('ok');
      expect(adoption.content).toContain('return 42');
      if (!lifecycle.includes('file_delete_completed')) {
        throw new Error('q08_mutation_coverage_missing');
      }
      expect(lifecycle).toEqual([
        'request_started',
        'request_snapshot',
        'source_retrieval_started',
        'mutation_hook_fired',
        'file_delete_completed',
        'post_mutation_snapshot',
        'product_freshness_check',
        'tool_response',
      ]);

      const canonicalRoot = await realpath(root);
      const oracleAdoption = {
        ...adoption,
        filePath: adoption.filePath.startsWith(`${canonicalRoot}/`)
          ? relative(canonicalRoot, adoption.filePath).replaceAll('\\', '/')
          : adoption.filePath,
      };
      lifecycle.push('publication_mutation_started');
      await applyQualityMutation(fixture, task.taskId, 'before_publication');
      lifecycle.push('publication_file_recreated');
      const publicationSnapshot = await captureOracleSnapshot(fixture, 'single', task.taskId);
      lifecycle.push('publication_snapshot');
      const expectedPath = task.expectedFiles[0];
      if (expectedPath === undefined) throw new Error('Q08 expected path missing');
      expect(publicationSnapshot.sourceHashes[expectedPath]).not.toBe(requestSnapshot.sourceHashes[expectedPath]);
      expect(new TextDecoder().decode(publicationSnapshot.sourceBytes[expectedPath])).toContain('return 43');

      const oracleResult = gradeTaskSource(task, postMutationSnapshot, oracleAdoption, {
        observedSourceRootKey: 'single',
        canonicalSourceRoot: canonicalRoot,
        sourceRootProofDigest: sha256(canonicalRoot),
      });
      lifecycle.push(`independent_oracle:${oracleResult}`);
      expect(oracleResult).toBe('FALSE_FRESH');
      expect(lifecycle.slice(-4)).toEqual([
        'publication_mutation_started',
        'publication_file_recreated',
        'publication_snapshot',
        'independent_oracle:FALSE_FRESH',
      ]);
    } finally {
      catalog.getGeneration = originalGetGeneration;
      await assembly.runtime.close();
    }
  });

  it('keeps Q08 policy tool choice separate and records whether its path executed the mutation', async () => {
    const rFixture = await createQualityFixture(['Q08@quality-v1'], new AbortController().signal);
    const nFixture = await createQualityFixture(['Q08@quality-v1'], new AbortController().signal);
    const task = nFixture.oracleCases[0];
    const root = nFixture.roots.single;
    const filePath = task?.expectedFiles[0];
    if (task === undefined || root === undefined || filePath === undefined) {
      await Promise.all([rFixture.dispose(), nFixture.dispose()]);
      throw new Error('Q08 policy fixture missing');
    }

    const mutationEvents: string[] = [];
    injection.targetPath = filePath;
    injection.afterCanonicalRead = async () => {
      mutationEvents.push('actual_structured_source_read');
      expect((await lstat(join(root, filePath))).isFile()).toBe(true);
      await applyQualityMutation(nFixture, task.taskId, 'during_request');
      await expect(lstat(join(root, filePath))).rejects.toMatchObject({ code: 'ENOENT' });
      mutationEvents.push('file_delete_completed');
    };

    try {
      const result = await runQualityPair(task, rFixture, {
        signal: new AbortController().signal,
        armFixtures: { R: rFixture, N: nFixture },
      });
      const policy = result.outcomes.N.policy;
      const tools = policy?.trace.map(({ tool }) => tool) ?? [];
      const structuredReadSelected = tools.some((tool) =>
        tool === 'get_symbol_source' || tool === 'get_symbol_context',
      );
      const mutationStatus: 'NOT_EXECUTED' | 'EXECUTED' = mutationEvents.includes('file_delete_completed')
        ? 'EXECUTED'
        : 'NOT_EXECUTED';

      expect(tools).toContain('hybrid_search');
      if (mutationStatus === 'EXECUTED') {
        expect(structuredReadSelected).toBe(true);
        expect(mutationEvents).toEqual(['actual_structured_source_read', 'file_delete_completed']);
        expect(result.outcomes.N.observation).toBe('FALSE_FRESH');
      } else {
        expect(mutationEvents).toEqual([]);
        expect(result.outcomes.N.observation).toBe('WRONG_SOURCE');
      }
    } finally {
      injection.targetPath = null;
      injection.afterCanonicalRead = null;
      await Promise.all([rFixture.dispose(), nFixture.dispose()]);
    }
  });
});
