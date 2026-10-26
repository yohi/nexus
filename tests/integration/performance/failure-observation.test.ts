import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { OutcomeCollector } from '../../benchmarks/performance/outcomes.js';
import { validateGrepEvidence } from '../../benchmarks/performance/grep-evidence.js';
import { generateFixture } from '../../benchmarks/performance/fixtures.js';
import { logicalPathSchema, queryCaseSchema } from '../../benchmarks/performance/contracts.js';
import { createBenchmarkRuntimeFactory } from '../../benchmarks/performance/runtime.js';
import { buildToolHandlers } from '../../../src/server/tools/tool-support.js';
import { parseGrepOutput } from '../../../src/server/runtime/grep-spawn.js';
import { withObservationContext } from '../../../src/observability/runtime-observer.js';

const directories: string[] = [];
async function createSourceRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'nexus-outcome-failure-'));
  directories.push(directory);
  const root = join(directory, 'source');
  await mkdir(root);
  return root;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('real-runtime outcome evidence', () => {
  it('captures all 125 pre-fusion grep matches while actual Hybrid handlers return topK20', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'nexus-outcome-integration-'));
    directories.push(directory);
    const root = join(directory, 'source');
    await mkdir(root);
    const manifest = await generateFixture(root, 'smoke');
    const collector = new OutcomeCollector();
    const assembly = await collector.run('startup', () => createBenchmarkRuntimeFactory(root, collector)(new AbortController().signal));
    try {
      await collector.run('initialize', async () => {
        await assembly.runtime.initialize();
        await assembly.options.pipeline.waitForActiveReindex();
        expect((await collector.seal('initialize')).status).toBe('valid');
      });
      const handlers = buildToolHandlers(assembly.options, assembly.runtime.initialize.bind(assembly.runtime));
      const query = manifest.queries.find((item) => item.id === 'hybrid-pre-fusion-125');
      if (query === undefined) throw new Error('query required');
      await collector.run('hybrid', async () => {
        const result = await handlers.hybrid_search(query.args);
        expect(result.isError).not.toBe(true);
        expect(z.object({ results: z.array(z.unknown()) }).parse(result.structuredContent).results).toHaveLength(20);
        const sealed = await collector.seal('hybrid');
        expect(sealed.status).toBe('valid');
        const evidence = collector.grepEvidence('hybrid', 'hybrid');
        if (evidence === undefined) throw new Error('hybrid evidence required');
        const normalize = (path: string): Promise<string> => Promise.resolve(logicalPathSchema.parse(
          (isAbsolute(path) ? relative(root, path) : path).split(sep).join('/'),
        ));
        expect(await validateGrepEvidence(evidence, query, normalize))
          .toMatchObject({ status: 'valid', lineMatchCount: 125, submatchCount: 125 });
        expect(JSON.stringify(sealed)).not.toContain(root);
      });
      for (const branch of ['semanticSearch', 'grepEngine'] as const) {
        const failure = vi.spyOn(assembly.options[branch], 'search').mockRejectedValueOnce(new Error('branch_failed'));
        await collector.run(`failed-${branch}`, async () => {
          const result = await handlers.hybrid_search(query.args);
          expect(result.isError).not.toBe(true);
          expect((await collector.seal(`failed-${branch}`)).status).toBe('invalid');
        });
        failure.mockRestore();
      }
    } finally {
      collector.releaseAll();
      await assembly.runtime.close();
    }
  });

  it('observes malformed real-parser match records before they are discarded', async () => {
    const collector = new OutcomeCollector();
    await collector.run('parser', async () => {
      const result = withObservationContext({ requestId: 'parser', phaseId: 'request' }, () =>
        parseGrepOutput('{"type":"match","data":{}}\n', collector));
      expect(result).toEqual([]);
      expect((await collector.seal('parser')).failures).toContain('grep_parser_failure');
    });
  });

  it('rejects background startup rejection even though runtime initialization fulfills', async () => {
    const root = await createSourceRoot();
    const collector = new OutcomeCollector();
    const assembly = await collector.run('construct', () => createBenchmarkRuntimeFactory(root, collector)(new AbortController().signal));
    vi.spyOn(assembly.options, 'runReindex').mockRejectedValueOnce(new Error('scan_failed'));
    try {
      await collector.run('startup', async () => {
        await expect(assembly.runtime.initialize()).resolves.toBeUndefined();
        await assembly.options.pipeline.waitForActiveReindex();
        expect((await collector.seal('startup')).failures).toContain('reindex_failed');
      });
    } finally { collector.releaseAll(); await assembly.runtime.close(); }
  });

  it('observes swallowed compaction failure independently of fulfilled indexing', async () => {
    const root = await createSourceRoot();
    const collector = new OutcomeCollector();
    const assembly = await collector.run('construct', () => createBenchmarkRuntimeFactory(root, collector)(new AbortController().signal));
    vi.spyOn(assembly.diagnostics.vectorStore, 'compactAfterReindex').mockRejectedValueOnce(new Error('compact_failed'));
    try {
      await collector.run('startup', async () => {
        await assembly.runtime.initialize();
        await assembly.options.pipeline.waitForActiveReindex();
        expect((await collector.seal('startup')).failures).toContain('compaction_failed');
        expect(assembly.options.pipeline.getProgress().lastError).toBeUndefined();
      });
    } finally { collector.releaseAll(); await assembly.runtime.close(); }
  });

  it('does not admit real grep abort-to-empty as a successful no-match', async () => {
    const root = await createSourceRoot();
    const collector = new OutcomeCollector();
    const assembly = await collector.run('construct', () => createBenchmarkRuntimeFactory(root, collector)(new AbortController().signal));
    try {
      await collector.run('aborted', async () => {
        const matches = await assembly.options.grepEngine.search({ query: 'needle', cwd: root, abortSignal: AbortSignal.abort() });
        expect(matches).toEqual([]);
        expect((await collector.seal('aborted')).failures).toContain('grep_aborted');
      });
    } finally { collector.releaseAll(); await assembly.runtime.close(); }
  });

  it('admits a normal real-ripgrep no-match exit with a complete empty proof', async () => {
    const root = await createSourceRoot();
    const collector = new OutcomeCollector();
    const assembly = await collector.run('construct', () => createBenchmarkRuntimeFactory(root, collector)(new AbortController().signal));
    const query = queryCaseSchema.parse({ id: 'normal-empty', tool: 'grep_search',
      args: { pattern: 'needle', maxResults: 100 }, requestedMaximum: 100,
      limits: [{ stage: 'grep', behavior: 'uncapped' }], expectedMatches: [] });
    try {
      await collector.run('empty', async () => {
        expect(await assembly.options.grepEngine.search({ query: 'needle', cwd: root })).toEqual([]);
        expect((await collector.seal('empty')).status).toBe('valid');
        const evidence = collector.grepEvidence('empty', 'direct');
        if (evidence === undefined) throw new Error('empty capture required');
        expect(await validateGrepEvidence(evidence, query, (path) => Promise.resolve(path)))
          .toMatchObject({ status: 'valid', lineMatchCount: 0, submatchCount: 0 });
      });
    } finally { collector.releaseAll(); await assembly.runtime.close(); }
  });

  it('observes successful no-op initialization after reopening persisted state', async () => {
    const root = await createSourceRoot();
    const collector = new OutcomeCollector();
    const factory = createBenchmarkRuntimeFactory(root, collector);
    const first = await collector.run('first-construct', () => factory(new AbortController().signal));
    try {
      await collector.run('cold', async () => {
        await first.runtime.initialize();
        await first.options.pipeline.waitForActiveReindex();
        expect((await collector.seal('cold')).status).toBe('valid');
      });
    } finally { await first.runtime.close(); }
    const reopened = await collector.run('reopen-construct', () => factory(new AbortController().signal));
    const reindex = vi.spyOn(reopened.options.pipeline, 'reindex');
    try {
      await collector.run('warm', async () => {
        await reopened.runtime.initialize();
        expect(reindex).not.toHaveBeenCalled();
        expect((await collector.seal('warm')).status).toBe('valid');
      });
    } finally { collector.releaseAll(); await reopened.runtime.close(); }
  });
});
