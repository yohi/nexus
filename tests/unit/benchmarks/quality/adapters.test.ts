import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createNexusAdapter,
  createRipgrepAdapter,
  type QualityInvocationContext,
  type QualityTool,
} from '../../../benchmarks/quality/adapters.js';
import type { buildToolHandlers } from '../../../../src/server/tools/tool-support.js';
import type { NexusToolCallResult, ToolHandler } from '../../../../src/server/tools/types.js';

type ToolHandlers = ReturnType<typeof buildToolHandlers>;

const rgExecutable = (() => {
  try {
    return execFileSync('which', ['rg'], { encoding: 'utf8' }).trim();
  } catch {
    return 'rg';
  }
})();

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const queryDigest = (publicQuery: string): string =>
  sha256(new TextEncoder().encode(`quality-query-v1\0${publicQuery}`));

const temporaryRoots = new Set<string>();

const fixedRgArgv = (query: string): readonly string[] =>
  Object.freeze([
    '--no-config',
    '--no-ignore',
    '--hidden',
    '--json',
    '--sort',
    'path',
    '--fixed-strings',
    '--glob',
    '!.git/**',
    '--glob',
    '!**/.git/**',
    '--glob',
    '!node_modules/**',
    '--glob',
    '!**/node_modules/**',
    '--glob',
    '!.nexus/**',
    '--glob',
    '!**/.nexus/**',
    '--',
    query,
    '.',
  ]);

const makeRoot = async (prefix = 'nexus-quality-'): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.add(root);
  return root;
};

const createBlockingRg = async (root: string): Promise<{ executable: string; startedMarker: string }> => {
  const executable = join(root, 'blocking-rg');
  const startedMarker = join(root, 'search-started');
  await writeFile(
    executable,
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "if (process.argv[2] === '--version') { process.stdout.write('ripgrep 0.0.0\\n'); process.exit(0); }",
      `fs.writeFileSync(${JSON.stringify(startedMarker)}, 'started');`,
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'),
    'utf8',
  );
  await chmod(executable, 0o755);
  return { executable, startedMarker };
};

const waitForFile = async (filePath: string): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
  }
  throw new Error(`Timed out waiting for ${filePath}`);
};

const cleanup = async (root: string): Promise<void> => {
  temporaryRoots.delete(root);
  await rm(root, { recursive: true, force: true });
};

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await Promise.all([...temporaryRoots].map(cleanup));
});

const writeFiles = async (root: string, files: Record<string, string>): Promise<void> => {
  for (const [relativePath, content] of Object.entries(files)) {
    const absolute = resolve(root, relativePath);
    await mkdir(resolve(absolute, '..'), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }
};

const ctx = (traceSequence: number): QualityInvocationContext => ({ traceSequence });

const handler =
  (result: NexusToolCallResult): ToolHandler =>
  () =>
    Promise.resolve(result);

const handlersFor = (overrides: Partial<ToolHandlers> = {}): ToolHandlers => {
  const base: Record<string, ToolHandler> = {
    grep_search: handler({ content: [{ type: 'text', text: '' }], structuredContent: { status: 'ok', matches: [] } }),
    semantic_search: handler({ content: [{ type: 'text', text: '' }], structuredContent: { status: 'ok', results: [] } }),
    hybrid_search: handler({ content: [{ type: 'text', text: '' }], structuredContent: { status: 'ok', results: [] } }),
    get_context: handler({ content: [{ type: 'text', text: '' }], structuredContent: { status: 'ok' } }),
    get_file_outline: handler({ content: [{ type: 'text', text: '' }], structuredContent: { status: 'ok', file: { filePath: 'src/file.ts' }, symbols: [] } }),
    get_symbol_source: handler({ content: [{ type: 'text', text: '' }], structuredContent: { status: 'ok', source: '' } }),
    get_symbol_context: handler({ content: [{ type: 'text', text: '' }], structuredContent: { status: 'ok', context: '' } }),
    get_definition: handler({ content: [{ type: 'text', text: '' }], structuredContent: { status: 'ok', locations: [] } }),
    get_references: handler({ content: [{ type: 'text', text: '' }], structuredContent: { status: 'ok', locations: [] } }),
    get_implementations: handler({ content: [{ type: 'text', text: '' }], structuredContent: { status: 'ok', locations: [] } }),
    index_status: handler({ content: [{ type: 'text', text: '' }], structuredContent: { status: 'ok' } }),
    reindex: handler({ content: [{ type: 'text', text: '' }], structuredContent: { status: 'ok' } }),
  };
  return { ...base, ...overrides } as unknown as ToolHandlers;
};

describe('createRipgrepAdapter', () => {
  it('validates the selected owned root and rg identity on first invoke', async () => {
    const root = await makeRoot();
    await writeFiles(root, { 'a.ts': 'hello world\n' });
    const adapter = createRipgrepAdapter(root, rgExecutable);
    const observation = await adapter.invoke('rg_search', { query: 'hello' }, new AbortController().signal, ctx(1));
    expect(observation.status).toBe('ok');
    expect(observation.results.some((result) => result.filePath.endsWith('a.ts'))).toBe(true);
    await cleanup(root);
  });

  it('preserves the absolute byte offset of a ripgrep match', async () => {
    const root = await makeRoot();
    await writeFiles(root, { 'deep.ts': `${'x'.repeat(8192)}needle\n` });
    const adapter = createRipgrepAdapter(root, rgExecutable);

    const observation = await adapter.invoke(
      'rg_search',
      { query: 'needle' },
      new AbortController().signal,
      ctx(1),
    );

    expect(observation.status).toBe('ok');
    expect(observation.results[0]).toMatchObject({
      filePath: './deep.ts',
      line: 1,
      matchStartByte: 8192,
    });
    await cleanup(root);
  });

  it('validates the trace sequence and classifies an aborted first call before lazy initialization', async () => {
    const adapter = createRipgrepAdapter('/does/not/exist', rgExecutable);
    const controller = new AbortController();
    controller.abort(new DOMException('timeout', 'TimeoutError'));

    await expect(adapter.invoke('rg_search', { query: 'x' }, controller.signal, ctx(0))).rejects.toThrow(
      'quality_trace_sequence_invalid_or_duplicate',
    );
    await expect(adapter.invoke('rg_search', { query: 'x' }, controller.signal, ctx(1))).resolves.toMatchObject({
      status: 'timeout',
      reasonCode: 'RG_TIMEOUT',
    });
  });

  it('rejects an invalid root directory at initialization', async () => {
    await expect(
      createRipgrepAdapter('/does/not/exist', rgExecutable).invoke('rg_search', { query: 'x' }, new AbortController().signal, ctx(1)),
    ).rejects.toThrow('quality_rg_root_not_directory');
  });

  it('rejects a non-ripgrep executable at initialization', async () => {
    const root = await makeRoot();
    const fakeRg = join(root, 'not-rg');
    await writeFile(fakeRg, '#!/bin/sh\necho "fake searcher"\n', 'utf8');
    await chmod(fakeRg, 0o755);
    await expect(
      createRipgrepAdapter(root, fakeRg).invoke('rg_search', { query: 'x' }, new AbortController().signal, ctx(1)),
    ).rejects.toThrow('quality_rg_executable_not_ripgrep');
    await cleanup(root);
  });

  it('emits the exact fixed argv, exclusions and contract digest for a validated query', async () => {
    const root = await makeRoot();
    await writeFiles(root, { 'a.ts': 'needle\n' });
    const adapter = createRipgrepAdapter(root, rgExecutable);
    await adapter.invoke('rg_search', { query: 'needle' }, new AbortController().signal, ctx(1));
    const snapshot = adapter.snapshotRgExecution();

    expect(adapter.rgExecutionContractDigest).not.toBe(sha256(new TextEncoder().encode('uninitialized')));
    expect(adapter.rgExecutionContractDigest).toBe(snapshot.initializedContractDigest);
    expect(snapshot.rgSearchInvocationCount).toBe(1);
    expect(snapshot.spawnAttemptCount).toBe(1);
    expect(snapshot.spawns).toHaveLength(1);

    const spawn = snapshot.spawns[0];
    if (spawn === undefined) throw new Error('spawn missing');
    expect(spawn.rootKey).toBe('single');
    expect(spawn.searchScope).toBe('.');
    expect(spawn.readMaxBytesPerCall).toBe(4096);
    expect(spawn.normalizedObservedArgv).toEqual([...fixedRgArgv('<public-query>')]);
    expect(spawn.observedExclusions).toEqual([
      '!.git/**',
      '!**/.git/**',
      '!node_modules/**',
      '!**/node_modules/**',
      '!.nexus/**',
      '!**/.nexus/**',
    ]);
    expect(spawn.observedContractDigest).toEqual(expect.any(String));
    expect(spawn.observedContractDigest).toHaveLength(64);
    expect(snapshot.evidenceComplete).toBe(true);
    await cleanup(root);
  });

  it('redacts the literal query and computes the domain-separated query digest', async () => {
    const root = await makeRoot();
    await writeFiles(root, { 'a.ts': 'secret-token\n' });
    const adapter = createRipgrepAdapter(root, rgExecutable);
    const query = 'secret-token';
    await adapter.invoke('rg_search', { query }, new AbortController().signal, ctx(1));
    const snapshot = adapter.snapshotRgExecution();
    const spawn = snapshot.spawns[0];
    if (spawn === undefined) throw new Error('spawn missing');

    expect(spawn.normalizedObservedArgv).not.toContain(query);
    expect(spawn.normalizedObservedArgv).toContain('<public-query>');
    expect(spawn.queryDigest).toBe(queryDigest(query));
    await cleanup(root);
  });

  it('associates every spawn with the policy trace sequence and orders by ordinal', async () => {
    const root = await makeRoot();
    await writeFiles(root, { 'a.ts': 'findme\n', 'b.ts': 'findme\n' });
    const adapter = createRipgrepAdapter(root, rgExecutable);
    await adapter.invoke('rg_search', { query: 'findme' }, new AbortController().signal, ctx(5));
    await adapter.invoke('rg_search', { query: 'findme' }, new AbortController().signal, ctx(7));
    const snapshot = adapter.snapshotRgExecution();

    expect(snapshot.spawns.map((s) => s.spawnOrdinal)).toEqual([1, 2]);
    expect(snapshot.spawns.map((s) => s.policyTraceSequence)).toEqual([5, 7]);
    await cleanup(root);
  });

  it('treats rg exit 1 (no matches) as ok with empty results', async () => {
    const root = await makeRoot();
    await writeFiles(root, { 'a.ts': 'hello\n' });
    const adapter = createRipgrepAdapter(root, rgExecutable);
    const observation = await adapter.invoke('rg_search', { query: 'missing' }, new AbortController().signal, ctx(1));
    expect(observation.status).toBe('ok');
    expect(observation.results).toHaveLength(0);
    expect(observation.normalizedPublicArgs).toEqual({});
    await cleanup(root);
  });

  it('caps results at the 20-candidate policy limit and ranks by path, line and char', async () => {
    const root = await makeRoot();
    const files: Record<string, string> = {};
    for (let i = 0; i < 25; i += 1) {
      files[`src/${String(i).padStart(2, '0')}.ts`] = 'target\n';
    }
    await writeFiles(root, files);
    const adapter = createRipgrepAdapter(root, rgExecutable);
    const observation = await adapter.invoke('rg_search', { query: 'target' }, new AbortController().signal, ctx(1));
    expect(observation.status).toBe('ok');
    expect(observation.results).toHaveLength(20);
    expect(observation.results[0]?.rank).toBe(1);
    expect(observation.results[19]?.rank).toBe(20);
    const paths = observation.results.map((r) => r.filePath);
    expect(paths).toEqual([...paths].sort());
    await cleanup(root);
  });

  it('increments the rg_search counter before validation and rejects invalid queries without spawning', async () => {
    const root = await makeRoot();
    const adapter = createRipgrepAdapter(root, rgExecutable);
    const invalidQueries = ['', '-foo', 'multi\nline'];
    let sequence = 100;
    for (const query of invalidQueries) {
      const observation = await adapter.invoke('rg_search', { query }, new AbortController().signal, ctx(sequence++));
      expect(observation.status).toBe('error');
      expect(observation.reasonCode).toBe('RG_QUERY_INVALID');
    }
    const snapshot = adapter.snapshotRgExecution();
    expect(snapshot.rgSearchInvocationCount).toBe(invalidQueries.length);
    expect(snapshot.spawnAttemptCount).toBe(0);
    expect(snapshot.spawns).toHaveLength(0);
    await cleanup(root);
  });

  it('records a failed spawn attempt and still increments the attempt counter', async () => {
    const root = await makeRoot();
    const fakeRg = join(root, 'fake-rg');
    await writeFile(
      fakeRg,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "ripgrep 0.0.0"; exit 0; fi\nexit 2\n',
      'utf8',
    );
    await chmod(fakeRg, 0o755);
    const adapter = createRipgrepAdapter(root, fakeRg);
    const observation = await adapter.invoke('rg_search', { query: 'x' }, new AbortController().signal, ctx(1));
    const snapshot = adapter.snapshotRgExecution();
    expect(observation.status).toBe('error');
    expect(observation.reasonCode).toBe('RG_EXIT_2');
    expect(snapshot.spawnAttemptCount).toBe(1);
    expect(snapshot.spawns).toHaveLength(1);
    expect(snapshot.evidenceComplete).toBe(true);
    await cleanup(root);
  });

  it('records a cancelled invocation when the signal is aborted with a timeout reason', async () => {
    const root = await makeRoot();
    await writeFiles(root, { 'a.ts': 'slow\n' });
    const adapter = createRipgrepAdapter(root, rgExecutable);
    const controller = new AbortController();
    controller.abort(new DOMException('timeout', 'TimeoutError'));
    const observation = await adapter.invoke('rg_search', { query: 'slow' }, controller.signal, ctx(1));
    expect(observation.status).toBe('timeout');
    const snapshot = adapter.snapshotRgExecution();
    expect(snapshot.spawns).toHaveLength(0);
    expect(snapshot.spawnAttemptCount).toBe(0);
    await cleanup(root);
  });

  it.each([
    { label: 'timeout', timeout: true, status: 'timeout', reasonCode: 'RG_TIMEOUT' },
    { label: 'cancellation', timeout: false, status: 'cancelled', reasonCode: 'REQUEST_CANCELLED' },
  ])('classifies an in-flight $label signal correctly', async ({ timeout, status, reasonCode }) => {
    const root = await makeRoot();
    const { executable, startedMarker } = await createBlockingRg(root);
    const adapter = createRipgrepAdapter(root, executable);
    const controller = new AbortController();
    const invocation = adapter.invoke('rg_search', { query: 'slow' }, controller.signal, ctx(1));

    try {
      await waitForFile(startedMarker);
      controller.abort(timeout ? new DOMException('timeout', 'TimeoutError') : undefined);
      await expect(invocation).resolves.toMatchObject({ status, reasonCode });
    } finally {
      if (!controller.signal.aborted) controller.abort();
      await invocation.catch(() => undefined);
      await cleanup(root);
    }
  });

  it('removes its abort listener when ripgrep closes normally', async () => {
    const root = await makeRoot();
    await writeFiles(root, { 'a.ts': 'needle\n' });
    const controller = new AbortController();
    const activeAbortListeners = new Set<unknown>();
    const originalAdd = controller.signal.addEventListener.bind(controller.signal);
    const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((type: string, listener: unknown, options: unknown) => {
      if (type === 'abort' && listener !== null) activeAbortListeners.add(listener);
      Reflect.apply(originalAdd, controller.signal, [type, listener, options]);
    }) as typeof controller.signal.addEventListener;
    controller.signal.removeEventListener = ((type: string, listener: unknown, options: unknown) => {
      if (type === 'abort' && listener !== null) activeAbortListeners.delete(listener);
      Reflect.apply(originalRemove, controller.signal, [type, listener, options]);
    }) as typeof controller.signal.removeEventListener;

    const observation = await createRipgrepAdapter(root, rgExecutable).invoke(
      'rg_search',
      { query: 'needle' },
      controller.signal,
      ctx(1),
    );

    expect(observation.status).toBe('ok');
    expect(activeAbortListeners.size).toBe(0);
  });

  it('removes its abort listener when ripgrep emits an error', async () => {
    const root = await makeRoot();
    const executable = join(root, 'vanishing-rg');
    await writeFile(
      executable,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then rm "$0"; echo "ripgrep 0.0.0"; exit 0; fi\n',
      'utf8',
    );
    await chmod(executable, 0o755);
    const controller = new AbortController();
    const addedAbortListeners: unknown[] = [];
    const removedAbortListeners = new Set<unknown>();
    const originalAdd = controller.signal.addEventListener.bind(controller.signal);
    const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((type: string, listener: unknown, options: unknown) => {
      if (type === 'abort' && listener !== null) addedAbortListeners.push(listener);
      Reflect.apply(originalAdd, controller.signal, [type, listener, options]);
    }) as typeof controller.signal.addEventListener;
    controller.signal.removeEventListener = ((type: string, listener: unknown, options: unknown) => {
      if (type === 'abort' && listener !== null) removedAbortListeners.add(listener);
      Reflect.apply(originalRemove, controller.signal, [type, listener, options]);
    }) as typeof controller.signal.removeEventListener;

    const observation = await createRipgrepAdapter(root, executable).invoke(
      'rg_search',
      { query: 'needle' },
      controller.signal,
      ctx(1),
    );

    expect(observation.status).toBe('error');
    expect(addedAbortListeners.at(-1)).toBeDefined();
    expect(removedAbortListeners.has(addedAbortListeners.at(-1))).toBe(true);
  });

  it('returns an incomplete immutable zero-call snapshot without poisoning later evidence', async () => {
    const root = await makeRoot();
    const adapter = createRipgrepAdapter(root, rgExecutable);
    const snapshot = adapter.snapshotRgExecution();
    expect(snapshot.rgSearchInvocationCount).toBe(0);
    expect(snapshot.spawnAttemptCount).toBe(0);
    expect(snapshot.spawns).toHaveLength(0);
    expect(snapshot.evidenceComplete).toBe(false);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.spawns)).toBe(true);
    await adapter.invoke('rg_search', { query: 'after-initial-snapshot' }, new AbortController().signal, ctx(1));
    expect(adapter.snapshotRgExecution().evidenceComplete).toBe(true);
    await cleanup(root);
  });

  it('fails closed on duplicate or invalid trace sequences and marks evidence incomplete', async () => {
    const root = await makeRoot();
    const adapter = createRipgrepAdapter(root, rgExecutable);
    await adapter.invoke('rg_search', { query: 'x' }, new AbortController().signal, ctx(1));
    await expect(adapter.invoke('rg_search', { query: 'x' }, new AbortController().signal, ctx(1))).rejects.toThrow(
      'quality_trace_sequence_invalid_or_duplicate',
    );
    await expect(adapter.invoke('rg_search', { query: 'x' }, new AbortController().signal, ctx(0))).rejects.toThrow(
      'quality_trace_sequence_invalid_or_duplicate',
    );
    await expect(
      adapter.invoke('rg_search', { query: 'x' }, new AbortController().signal, ctx(-1 as unknown as number)),
    ).rejects.toThrow('quality_trace_sequence_invalid_or_duplicate');
    expect(adapter.snapshotRgExecution().evidenceComplete).toBe(false);
    await cleanup(root);
  });

  it('never leaks the physical root, executable, literal query or source bytes in the snapshot', async () => {
    const root = await makeRoot();
    await writeFiles(root, { 'a.ts': 'literal-query\n' });
    const adapter = createRipgrepAdapter(root, rgExecutable);
    await adapter.invoke('rg_search', { query: 'literal-query' }, new AbortController().signal, ctx(1));
    const snapshot = JSON.stringify(adapter.snapshotRgExecution());
    expect(snapshot).not.toContain(root);
    expect(snapshot).not.toContain(rgExecutable);
    expect(snapshot).not.toContain('literal-query');
    expect(snapshot).not.toContain('literal-query\n');
    await cleanup(root);
  });

  it('returns root-relative, query-free normalized args for read_file', async () => {
    const root = await makeRoot();
    await writeFiles(root, { 'src/file.ts': 'content\n' });
    const adapter = createRipgrepAdapter(root, rgExecutable);
    const observation = await adapter.invoke(
      'read_file',
      { filePath: 'src/file.ts', startByte: 0, endByte: 6 },
      new AbortController().signal,
      ctx(1),
    );
    expect(observation.status).toBe('ok');
    expect(observation.normalizedPublicArgs).toEqual({ filePath: 'src/file.ts', startByte: 0, endByte: 6 });
    expect(observation.sourceAdoptions).toHaveLength(1);
    expect(observation.sourceAdoptions[0]?.sourceValidation).toBe('partial');
    expect(observation.results[0]?.preview).toBe('conten');
    await cleanup(root);
  });

  it('reads a bounded window starting at a requested line beyond the first 4 KiB', async () => {
    const root = await makeRoot();
    const prefix = `${'x'.repeat(4096)}\n`;
    await writeFiles(root, { 'deep.ts': `${prefix}answer is here\n` });
    const adapter = createRipgrepAdapter(root, rgExecutable);

    const observation = await adapter.invoke(
      'read_file',
      { filePath: 'deep.ts', startLine: 2 },
      new AbortController().signal,
      ctx(1),
    );

    expect(observation.status).toBe('ok');
    expect(observation.sourceAdoptions[0]).toMatchObject({
      startByte: Buffer.byteLength(prefix),
      content: 'answer is here\n',
    });
    expect(observation.exposedBytes).toBeLessThanOrEqual(4096);
    await cleanup(root);
  });

  it('allows a 4096-byte read window and rejects a 4097-byte window', async () => {
    const root = await makeRoot();
    await writeFiles(root, { 'big.bin': 'x'.repeat(5000) });
    const adapter = createRipgrepAdapter(root, rgExecutable);
    const ok = await adapter.invoke('read_file', { filePath: 'big.bin', startByte: 0, endByte: 4096 }, new AbortController().signal, ctx(1));
    expect(ok.status).toBe('ok');
    expect(ok.exposedBytes).toBe(4096);

    const bad = await adapter.invoke(
      'read_file',
      { filePath: 'big.bin', startByte: 0, endByte: 4097 },
      new AbortController().signal,
      ctx(2),
    );
    expect(bad.status).toBe('error');
    expect(bad.reasonCode).toBe('READ_WINDOW_EXCEEDS_LIMIT');
    await cleanup(root);
  });

  it.each([
    { requestedStart: 5, expectedStart: 3 },
    { requestedStart: 3, expectedStart: 3 },
  ])('clamps read_file startByte $requestedStart to EOF', async ({ requestedStart, expectedStart }) => {
    const root = await makeRoot();
    await writeFiles(root, { 'small.bin': 'abc' });
    const adapter = createRipgrepAdapter(root, rgExecutable);

    const observation = await adapter.invoke(
      'read_file',
      { filePath: 'small.bin', startByte: requestedStart },
      new AbortController().signal,
      ctx(1),
    );

    expect(observation.status).toBe('ok');
    expect(observation.normalizedPublicArgs).toEqual({
      filePath: 'small.bin',
      startByte: expectedStart,
      endByte: 3,
    });
    expect(observation.sourceAdoptions[0]).toMatchObject({
      startByte: expectedStart,
      endByte: 3,
      content: '',
    });
  });

  it('does not expose bytes when cancelled during a bounded read', async () => {
    const root = await makeRoot();
    const filePath = join(root, 'cancelled.bin');
    await writeFile(filePath, 'content', 'utf8');
    const controller = new AbortController();
    let handleClosed = false;
    const originalOpen = fsPromises.open.bind(fsPromises);
    vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] === filePath) {
        const originalRead = handle.read.bind(handle);
        Object.defineProperty(handle, 'read', {
          configurable: true,
          value: async (buffer: Buffer, offset: number, length: number, position: number) => {
            controller.abort(new DOMException('cancelled', 'AbortError'));
            return originalRead(buffer, offset, length, position);
          },
        });
        const originalClose = handle.close.bind(handle);
        Object.defineProperty(handle, 'close', {
          configurable: true,
          value: async () => {
            handleClosed = true;
            return originalClose();
          },
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    const adapter = createRipgrepAdapter(root, rgExecutable);

    const observation = await adapter.invoke(
      'read_file',
      { filePath: 'cancelled.bin' },
      controller.signal,
      ctx(1),
    );

    expect(observation).toMatchObject({
      status: 'cancelled',
      reasonCode: 'REQUEST_CANCELLED',
      exposedBytes: 0,
      sourceAdoptions: [],
    });
    expect(handleClosed).toBe(true);
  });

  it('stops scanning for a requested line after cancellation', async () => {
    const root = await makeRoot();
    const filePath = join(root, 'many-lines.txt');
    await writeFile(filePath, 'line\n'.repeat(6000), 'utf8');
    const controller = new AbortController();
    let readCount = 0;
    const originalOpen = fsPromises.open.bind(fsPromises);
    vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] === filePath) {
        const originalRead = handle.read.bind(handle);
        Object.defineProperty(handle, 'read', {
          configurable: true,
          value: async (buffer: Buffer, offset: number, length: number, position: number) => {
            readCount += 1;
            const result = await originalRead(buffer, offset, length, position);
            if (readCount === 1) controller.abort(new DOMException('cancelled', 'AbortError'));
            return result;
          },
        });
      }
      return handle;
    });
    syncBuiltinESMExports();
    const adapter = createRipgrepAdapter(root, rgExecutable);

    const observation = await adapter.invoke(
      'read_file',
      { filePath: 'many-lines.txt', startLine: 5000 },
      controller.signal,
      ctx(1),
    );

    expect(observation.status).toBe('cancelled');
    expect(readCount).toBe(1);
    await cleanup(root);
  });

  it('reads at most 4096 bytes and reports only bytes actually read', async () => {
    const root = await makeRoot();
    const filePath = join(root, 'large.bin');
    await writeFile(filePath, 'x'.repeat(5000), 'utf8');
    const readLengths: number[] = [];
    const originalOpen = fsPromises.open.bind(fsPromises);
    const openSpy = vi.spyOn(fsPromises, 'open').mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (args[0] === filePath) {
        const originalStat = handle.stat.bind(handle);
        Object.defineProperty(handle, 'stat', {
          configurable: true,
          value: async () => {
            const stats = await originalStat();
            await fsPromises.truncate(filePath, 3);
            return stats;
          },
        });
        const originalRead = handle.read.bind(handle);
        Object.defineProperty(handle, 'read', {
          configurable: true,
          value: (buffer: Buffer, offset: number, length: number, position: number) => {
            readLengths.push(length);
            return originalRead(buffer, offset, length, position);
          },
        });
      }
      return handle;
    });
    const readFileSpy = vi.spyOn(fsPromises, 'readFile');
    syncBuiltinESMExports();
    const adapter = createRipgrepAdapter(root, rgExecutable);

    const observation = await adapter.invoke(
      'read_file',
      { filePath: 'large.bin', startByte: 0, endByte: 4096 },
      new AbortController().signal,
      ctx(1),
    );

    expect(observation.status).toBe('ok');
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith(filePath, 'r');
    expect(readLengths).toEqual([4096]);
    expect(observation.normalizedPublicArgs).toEqual({
      filePath: 'large.bin',
      startByte: 0,
      endByte: 3,
    });
    expect(observation.sourceAdoptions[0]).toMatchObject({ content: 'xxx', endByte: 3 });
  });

  it('rejects path traversal and symlink escape', async () => {
    const root = await makeRoot();
    await writeFiles(root, { 'src/inside.ts': 'inside\n' });
    const outside = await makeRoot('nexus-quality-outside-');
    await writeFiles(outside, { 'secret.txt': 'secret\n' });
    const linkName = join(root, 'escape');
    await symlink(outside, linkName);

    const adapter = createRipgrepAdapter(root, rgExecutable);
    const traversal = await adapter.invoke('read_file', { filePath: '../outside.txt' }, new AbortController().signal, ctx(1));
    expect(traversal.status).toBe('error');
    expect(traversal.reasonCode).toBe('PATH_TRAVERSAL');

    const escape = await adapter.invoke('read_file', { filePath: 'escape/secret.txt' }, new AbortController().signal, ctx(2));
    expect(escape.status).toBe('error');
    expect(escape.reasonCode).toBe('SYMLINK_ESCAPE');

    await cleanup(root);
    await cleanup(outside);
  });

  it('returns not_found for a missing file', async () => {
    const root = await makeRoot();
    const adapter = createRipgrepAdapter(root, rgExecutable);
    const observation = await adapter.invoke('read_file', { filePath: 'missing.ts' }, new AbortController().signal, ctx(1));
    expect(observation.status).toBe('not_found');
    expect(observation.reasonCode).toBe('FILE_NOT_FOUND');
    await cleanup(root);
  });

  it('redacts the query `path` by position without corrupting fixed argv tokens', async () => {
    const root = await makeRoot();
    await writeFiles(root, { 'a.ts': 'path\n' });
    const adapter = createRipgrepAdapter(root, rgExecutable);
    await adapter.invoke('rg_search', { query: 'path' }, new AbortController().signal, ctx(1));
    const snapshot = adapter.snapshotRgExecution();
    const spawn = snapshot.spawns[0];
    if (spawn === undefined) throw new Error('spawn missing');
    expect(spawn.normalizedObservedArgv).toEqual([...fixedRgArgv('<public-query>')]);
    expect(spawn.normalizedObservedArgv[spawn.normalizedObservedArgv.length - 2]).toBe('<public-query>');
    expect(spawn.queryDigest).toBe(queryDigest('path'));
    expect(snapshot.evidenceComplete).toBe(true);
    await cleanup(root);
  });

  it('redacts an exclusion-glob literal query by position without leaking it', async () => {
    const root = await makeRoot();
    await writeFiles(root, { 'a.ts': '!.git/**\n' });
    const adapter = createRipgrepAdapter(root, rgExecutable);
    await adapter.invoke('rg_search', { query: '!.git/**' }, new AbortController().signal, ctx(1));
    const snapshot = adapter.snapshotRgExecution();
    const spawn = snapshot.spawns[0];
    if (spawn === undefined) throw new Error('spawn missing');
    expect(spawn.normalizedObservedArgv).toEqual([...fixedRgArgv('<public-query>')]);
    expect(spawn.normalizedObservedArgv[spawn.normalizedObservedArgv.length - 2]).toBe('<public-query>');
    expect(spawn.queryDigest).toBe(queryDigest('!.git/**'));
    expect(snapshot.evidenceComplete).toBe(true);
    await cleanup(root);
  });

  it('returns error RG_INVALID_JSON when a fake rg prints non-JSON stdout', async () => {
    const root = await makeRoot();
    const fakeRg = join(root, 'fake-rg');
    await writeFile(fakeRg, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "ripgrep 0.0.0"; exit 0; fi\nprintf "%s" "this is not json"\n', 'utf8');
    await chmod(fakeRg, 0o755);
    const adapter = createRipgrepAdapter(root, fakeRg);
    const observation = await adapter.invoke('rg_search', { query: 'x' }, new AbortController().signal, ctx(1));
    expect(observation.status).toBe('error');
    expect(observation.reasonCode).toBe('RG_INVALID_JSON');
    expect(observation.results).toHaveLength(0);
    await cleanup(root);
  });

  it('returns error RG_EXIT_1_DIAGNOSTIC when rg exits 1 with stderr', async () => {
    const root = await makeRoot();
    const fakeRg = join(root, 'fake-rg');
    await writeFile(fakeRg, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "ripgrep 0.0.0"; exit 0; fi\nprintf "%s" "bad pattern" >&2\nexit 1\n', 'utf8');
    await chmod(fakeRg, 0o755);
    const adapter = createRipgrepAdapter(root, fakeRg);
    const observation = await adapter.invoke('rg_search', { query: 'x' }, new AbortController().signal, ctx(1));
    expect(observation.status).toBe('error');
    expect(observation.reasonCode).toBe('RG_EXIT_1_DIAGNOSTIC');
    await cleanup(root);
  });

  it('increments rgSearchInvocationCount before validation and marks duplicate traces incomplete', async () => {
    const root = await makeRoot();
    await writeFiles(root, { 'a.ts': 'x\n' });
    const adapter = createRipgrepAdapter(root, rgExecutable);
    await adapter.invoke('rg_search', { query: 'x' }, new AbortController().signal, ctx(1));
    await expect(adapter.invoke('rg_search', { query: 'x' }, new AbortController().signal, ctx(1))).rejects.toThrow(
      'quality_trace_sequence_invalid_or_duplicate',
    );
    const snapshot = adapter.snapshotRgExecution();
    expect(snapshot.rgSearchInvocationCount).toBe(2);
    expect(snapshot.evidenceComplete).toBe(false);
    await cleanup(root);
  });

  it('records primary and linked rootKey values in spawn observations', async () => {
    const primaryRoot = await makeRoot();
    const linkedRoot = await makeRoot();
    await writeFiles(primaryRoot, { 'a.ts': 'shared\n' });
    await writeFiles(linkedRoot, { 'a.ts': 'shared\n' });

    const primary = createRipgrepAdapter(primaryRoot, rgExecutable, { rootKey: 'primary' });
    const linked = createRipgrepAdapter(linkedRoot, rgExecutable, { rootKey: 'linked' });

    await primary.invoke('rg_search', { query: 'shared' }, new AbortController().signal, ctx(1));
    await linked.invoke('rg_search', { query: 'shared' }, new AbortController().signal, ctx(2));

    const primarySnapshot = primary.snapshotRgExecution();
    const linkedSnapshot = linked.snapshotRgExecution();

    expect(primarySnapshot.spawns[0]?.rootKey).toBe('primary');
    expect(linkedSnapshot.spawns[0]?.rootKey).toBe('linked');
    expect(primarySnapshot.evidenceComplete).toBe(true);
    expect(linkedSnapshot.evidenceComplete).toBe(true);

    await cleanup(primaryRoot);
    await cleanup(linkedRoot);
  });

  it('converts ripgrep byte offsets to UTF-16 code units for ranking', async () => {
    const root = await makeRoot();
    // α (U+03B1) is 2 bytes in UTF-8 but 1 UTF-16 code unit.
    await writeFiles(root, { 'utf.ts': 'α needle\n' });
    const adapter = createRipgrepAdapter(root, rgExecutable);
    const observation = await adapter.invoke('rg_search', { query: 'needle' }, new AbortController().signal, ctx(1));
    expect(observation.status).toBe('ok');
    expect(observation.results).toHaveLength(1);
    const hit = observation.results[0]!;
    expect(hit.character).toBe(2); // α + space = 2 UTF-16 code units before 'needle'
    await cleanup(root);
  });

  it('converts UTF-8 ripgrep lines.bytes offsets to UTF-16 coordinates', async () => {
    const root = await makeRoot();
    const line = 'α needle\n';
    const matchEvent = {
      type: 'match',
      data: {
        path: { text: 'a.ts' },
        lines: { bytes: Buffer.from(line).toString('base64') },
        line_number: 1,
        submatches: [{ match: { text: 'needle' }, start: 3, end: 9 }],
      },
    };
    const executable = join(root, 'bytes-rg');
    await writeFile(
      executable,
      `#!/usr/bin/env node\nif (process.argv[2] === '--version') { process.stdout.write('ripgrep 0.0.0\\n'); process.exit(0); }\nprocess.stdout.write(${JSON.stringify(`${JSON.stringify(matchEvent)}\n`)});\n`,
      'utf8',
    );
    await chmod(executable, 0o755);
    const observation = await createRipgrepAdapter(root, executable).invoke(
      'rg_search',
      { query: 'needle' },
      new AbortController().signal,
      ctx(1),
    );

    expect(observation.status).toBe('ok');
    expect(observation.results[0]).toMatchObject({
      character: 2,
      endCharacter: 8,
      preview: 'needle',
    });
  });

  it('rejects ripgrep lines.bytes that cannot be represented as UTF-8 coordinates', async () => {
    const root = await makeRoot();
    const matchEvent = {
      type: 'match',
      data: {
        path: { text: 'a.ts' },
        lines: { bytes: Buffer.from([0xff, 0x61]).toString('base64') },
        line_number: 1,
        submatches: [{ match: { text: 'a' }, start: 1, end: 2 }],
      },
    };
    const executable = join(root, 'invalid-bytes-rg');
    await writeFile(
      executable,
      `#!/usr/bin/env node\nif (process.argv[2] === '--version') { process.stdout.write('ripgrep 0.0.0\\n'); process.exit(0); }\nprocess.stdout.write(${JSON.stringify(`${JSON.stringify(matchEvent)}\n`)});\n`,
      'utf8',
    );
    await chmod(executable, 0o755);
    const observation = await createRipgrepAdapter(root, executable).invoke(
      'rg_search',
      { query: 'a' },
      new AbortController().signal,
      ctx(1),
    );

    expect(observation.status).toBe('error');
    expect(observation.results).toHaveLength(0);
    expect(observation.reasonCode).toBe('RG_INVALID_UTF8');
  });
});

describe('createNexusAdapter', () => {
  it('rejects duplicate or invalid trace sequences', async () => {
    const adapter = createNexusAdapter(handlersFor());
    await adapter.invoke('index_status', {}, new AbortController().signal, ctx(1));
    await expect(adapter.invoke('index_status', {}, new AbortController().signal, ctx(1))).rejects.toThrow(
      'quality_trace_sequence_invalid_or_duplicate',
    );
    await expect(adapter.invoke('index_status', {}, new AbortController().signal, ctx(0))).rejects.toThrow(
      'quality_trace_sequence_invalid_or_duplicate',
    );
  });

  it('returns normalized public args without the search query', async () => {
    const adapter = createNexusAdapter(
      handlersFor({
        grep_search: handler({
          content: [{ type: 'text', text: '' }],
          structuredContent: { status: 'ok', matches: [{ filePath: 'a.ts', lineNumber: 1, lineText: 'hit' }] },
        }),
      }),
    );
    const observation = await adapter.invoke(
      'grep_search',
      { pattern: 'secret', topK: 5, maxResults: 10, unknownField: 'leak' },
      new AbortController().signal,
      ctx(1),
    );
    expect(observation.status).toBe('ok');
    expect(observation.normalizedPublicArgs).not.toHaveProperty('pattern');
    expect(observation.normalizedPublicArgs).not.toHaveProperty('query');
    expect(observation.normalizedPublicArgs).not.toHaveProperty('unknownField');
    expect(observation.normalizedPublicArgs).toEqual({ maxResults: 10 });
  });

  it('maps ok, not_found, stale_identity and unavailable statuses distinctly', async () => {
    const cases: { tool: QualityTool; result: NexusToolCallResult; expected: string; reason?: string }[] = [
      {
        tool: 'grep_search',
        result: { content: [{ type: 'text', text: '' }], structuredContent: { status: 'ok', matches: [] } },
        expected: 'ok',
      },
      {
        tool: 'grep_search',
        result: { content: [{ type: 'text', text: '' }], structuredContent: { status: 'not_found', reasonCode: 'NO_MATCHES' } },
        expected: 'not_found',
        reason: 'NO_MATCHES',
      },
      {
        tool: 'get_symbol_source',
        result: { content: [{ type: 'text', text: '' }], structuredContent: { status: 'stale_identity', reasonCode: 'SYMBOL_STALE' } },
        expected: 'stale_identity',
        reason: 'SYMBOL_STALE',
      },
      {
        tool: 'get_definition',
        result: { content: [{ type: 'text', text: '' }], structuredContent: { status: 'unavailable', reasonCode: 'LSP_NOT_CONFIGURED' } },
        expected: 'unavailable',
        reason: 'LSP_NOT_CONFIGURED',
      },
    ];

    let sequence = 1;
    for (const { tool, result, expected, reason } of cases) {
      const adapter = createNexusAdapter(handlersFor({ [tool]: handler(result) }));
      const observation = await adapter.invoke(tool, { filePath: 'a.ts' }, new AbortController().signal, ctx(sequence++));
      expect(observation.status).toBe(expected);
      if (reason !== undefined) {
        expect(observation.reasonCode).toBe(reason);
      }
      expect(observation.normalizedPublicArgs).not.toHaveProperty('query');
    }
  });

  it('treats a handler isError response as error regardless of envelope status', async () => {
    const adapter = createNexusAdapter(
      handlersFor({
        grep_search: handler({
          content: [{ type: 'text', text: 'bad' }],
          isError: true,
          structuredContent: { status: 'ok' },
        }),
      }),
    );
    const observation = await adapter.invoke('grep_search', { pattern: 'x' }, new AbortController().signal, ctx(1));
    expect(observation.status).toBe('error');
  });

  it('distinguishes unavailable LSP from an empty successful LSP response', async () => {
    const unavailable = createNexusAdapter(
      handlersFor({
        get_references: handler({
          content: [{ type: 'text', text: '' }],
          structuredContent: { status: 'unavailable', reasonCode: 'LSP_NOT_CONFIGURED' },
        }),
      }),
    );
    const emptyOk = createNexusAdapter(
      handlersFor({
        get_references: handler({
          content: [{ type: 'text', text: '' }],
          structuredContent: { status: 'ok', locations: [] },
        }),
      }),
    );
    const unavailableObservation = await unavailable.invoke('get_references', { filePath: 'a.ts' }, new AbortController().signal, ctx(1));
    const emptyObservation = await emptyOk.invoke('get_references', { filePath: 'a.ts' }, new AbortController().signal, ctx(1));
    expect(unavailableObservation.status).toBe('unavailable');
    expect(emptyObservation.status).toBe('ok');
    expect(unavailableObservation.navigation?.capability).toBe('not_checked');
    expect(emptyObservation.navigation?.locations).toHaveLength(0);
  });

  it('preserves LSP locations including two references on the same line with distinct characters', async () => {
    const locations = [
      { filePath: 'a.ts', startLine: 1, startCharacter: 0, endLine: 1, endCharacter: 4 },
      { filePath: 'a.ts', startLine: 1, startCharacter: 10, endLine: 1, endCharacter: 14 },
    ];
    const adapter = createNexusAdapter(
      handlersFor({
        get_references: handler({
          content: [{ type: 'text', text: '' }],
          structuredContent: {
            status: 'ok',
            locations,
            truncated: false,
            sourceValidation: 'partial',
            capability: 'supported',
          },
        }),
      }),
    );
    const observation = await adapter.invoke('get_references', { filePath: 'a.ts' }, new AbortController().signal, ctx(1));
    expect(observation.status).toBe('ok');
    expect(observation.navigation?.locations).toHaveLength(2);
    expect(observation.navigation?.locations[0]?.startCharacter).toBe(0);
    expect(observation.navigation?.locations[1]?.startCharacter).toBe(10);
    expect(observation.navigation?.truncated).toBe(false);
    expect(observation.navigation?.sourceValidation).toBe('partial');
    expect(observation.navigation?.capability).toBe('supported');
  });

  it('ranks scored candidates first by descending score and then by path/line/char', async () => {
    const results = [
      { chunk: { filePath: 'b.ts', startLine: 1, content: 'b' }, score: 0.5 },
      { chunk: { filePath: 'a.ts', startLine: 2, content: 'a' }, score: 0.9 },
      { chunk: { filePath: 'c.ts', startLine: 1, content: 'c' }, score: 0.5 },
      { chunk: { filePath: 'd.ts', startLine: 1, content: 'd' } },
    ];
    const adapter = createNexusAdapter(
      handlersFor({
        hybrid_search: handler({
          content: [{ type: 'text', text: '' }],
          structuredContent: { status: 'ok', results },
        }),
      }),
    );
    const observation = await adapter.invoke('hybrid_search', { query: 'x' }, new AbortController().signal, ctx(1));
    expect(observation.status).toBe('ok');
    const ranks = observation.results.map((r) => ({
      filePath: r.filePath,
      rank: r.rank,
      publicScore: r.publicScore,
    }));
    expect(ranks).toEqual([
      { filePath: 'a.ts', rank: 1, publicScore: 0.9 },
      { filePath: 'b.ts', rank: 2, publicScore: 0.5 },
      { filePath: 'c.ts', rank: 3, publicScore: 0.5 },
      { filePath: 'd.ts', rank: 4, publicScore: undefined },
    ]);
  });

  it('rejects non-finite scores by treating them as unscored', async () => {
    const results = [
      { chunk: { filePath: 'a.ts', startLine: 1, content: 'a' }, score: Number.POSITIVE_INFINITY },
      { chunk: { filePath: 'b.ts', startLine: 1, content: 'b' }, score: Number.NaN },
      { chunk: { filePath: 'c.ts', startLine: 1, content: 'c' }, score: 1.0 },
    ];
    const adapter = createNexusAdapter(
      handlersFor({
        semantic_search: handler({
          content: [{ type: 'text', text: '' }],
          structuredContent: { status: 'ok', results },
        }),
      }),
    );
    const observation = await adapter.invoke('semantic_search', { query: 'x' }, new AbortController().signal, ctx(1));
    const byScore = new Map(observation.results.map((r) => [r.filePath, r.publicScore]));
    expect(byScore.get('c.ts')).toBe(1.0);
    expect(byScore.get('a.ts')).toBeUndefined();
    expect(byScore.get('b.ts')).toBeUndefined();
    expect(observation.results[0]?.filePath).toBe('c.ts');
  });

  it('breaks ties by original rank when path, line and character are equal', async () => {
    const results = [
      { chunk: { filePath: 'a.ts', startLine: 1, startCharacter: 0, content: 'second' }, score: 1 },
      { chunk: { filePath: 'a.ts', startLine: 1, startCharacter: 0, content: 'first' }, score: 1 },
    ];
    const adapter = createNexusAdapter(
      handlersFor({
        semantic_search: handler({
          content: [{ type: 'text', text: '' }],
          structuredContent: { status: 'ok', results },
        }),
      }),
    );
    const observation = await adapter.invoke('semantic_search', { query: 'x' }, new AbortController().signal, ctx(1));
    expect(observation.results.map((r) => r.preview)).toEqual(['second', 'first']);
  });

  it('caps Nexus results at 20 candidates', async () => {
    const results = Array.from({ length: 25 }, (_, i) => ({
      chunk: { filePath: `f${i}.ts`, startLine: 1, content: `${i}` },
      score: 1,
    }));
    const adapter = createNexusAdapter(
      handlersFor({
        semantic_search: handler({
          content: [{ type: 'text', text: '' }],
          structuredContent: { status: 'ok', results },
        }),
      }),
    );
    const observation = await adapter.invoke('semantic_search', { query: 'x' }, new AbortController().signal, ctx(1));
    expect(observation.results).toHaveLength(20);
    expect(observation.results[19]?.rank).toBe(20);
  });

  it('exposes exposedBytes as the sum of UTF-8 preview bytes', async () => {
    const results = [
      { chunk: { filePath: 'a.ts', startLine: 1, content: 'abc' } },
      { chunk: { filePath: 'b.ts', startLine: 1, content: 'あいう' } },
    ];
    const adapter = createNexusAdapter(
      handlersFor({
        semantic_search: handler({
          content: [{ type: 'text', text: '' }],
          structuredContent: { status: 'ok', results },
        }),
      }),
    );
    const observation = await adapter.invoke('semantic_search', { query: 'x' }, new AbortController().signal, ctx(1));
    expect(observation.exposedBytes).toBe(3 + 9);
  });

  it('treats index_status as a charged operation returning ok', async () => {
    const adapter = createNexusAdapter(handlersFor());
    const observation = await adapter.invoke('index_status', {}, new AbortController().signal, ctx(1));
    expect(observation.status).toBe('ok');
    expect(observation.results).toHaveLength(0);
    expect(observation.normalizedPublicArgs).toEqual({});
  });

  it('returns unsupported when a tool handler is absent', async () => {
    const handlers = handlersFor();
    const partial = Object.fromEntries(
      Object.entries(handlers).filter(([name]) => name !== 'grep_search'),
    ) as unknown as ToolHandlers;
    const adapter = createNexusAdapter(partial);
    const observation = await adapter.invoke('grep_search', { pattern: 'x' }, new AbortController().signal, ctx(1));
    expect(observation.status).toBe('unsupported');
    expect(observation.reasonCode).toBe('TOOL_NOT_IN_HANDLERS');
  });

  it('handles timeouts before invoking the handler', async () => {
    const adapter = createNexusAdapter(handlersFor());
    const controller = new AbortController();
    controller.abort(new DOMException('timeout', 'TimeoutError'));
    const observation = await adapter.invoke('index_status', {}, controller.signal, ctx(1));
    expect(observation.status).toBe('timeout');
    expect(observation.reasonCode).toBe('TIMEOUT');
  });

  it.each([
    {
      label: 'timeout',
      reason: new DOMException('timeout', 'TimeoutError'),
      status: 'timeout',
      reasonCode: 'TIMEOUT',
    },
    {
      label: 'cancellation',
      reason: new DOMException('cancelled', 'AbortError'),
      status: 'cancelled',
      reasonCode: 'REQUEST_CANCELLED',
    },
  ])('classifies a handler rejection after $label as an interruption', async ({ reason, status, reasonCode }) => {
    const adapter = createNexusAdapter(
      handlersFor({
        index_status: async (_args, extras) =>
          new Promise<NexusToolCallResult>((_resolve, reject) => {
            extras?.signal?.addEventListener('abort', () => reject(reason), { once: true });
          }),
      }),
    );
    const controller = new AbortController();
    const invocation = adapter.invoke('index_status', {}, controller.signal, ctx(1));
    controller.abort(reason);

    await expect(invocation).resolves.toMatchObject({ status, reasonCode });
  });

  it('rejects hybrid_search grepPattern in normalizedPublicArgs', async () => {
    const adapter = createNexusAdapter(handlersFor());
    const observation = await adapter.invoke(
      'hybrid_search',
      { query: 'secret-query', grepPattern: 'raw-literal', topK: 5 },
      new AbortController().signal,
      ctx(1),
    );
    expect(observation.status).toBe('ok');
    expect(observation.normalizedPublicArgs).not.toHaveProperty('query');
    expect(observation.normalizedPublicArgs).not.toHaveProperty('grepPattern');
    expect(observation.normalizedPublicArgs).toEqual({ topK: 5 });
  });

  it('returns MALFORMED_ENVELOPE for malformed search envelopes', async () => {
    const adapter = createNexusAdapter(handlersFor({
      grep_search: handler({ content: [{ type: 'text', text: '' }], structuredContent: { status: 'ok', matches: 'not-an-array' } }),
      semantic_search: handler({ content: [{ type: 'text', text: '' }], structuredContent: { status: 'ok', results: 'not-an-array' } }),
      hybrid_search: handler({ content: [{ type: 'text', text: '' }], structuredContent: { status: 'ok', results: null } }),
      get_context: handler({ content: [{ type: 'text', text: '' }], structuredContent: { status: 'ok', content: 'x' } }),
    }));

    const grep = await adapter.invoke('grep_search', { pattern: 'x' }, new AbortController().signal, ctx(1));
    expect(grep.status).toBe('error');
    expect(grep.reasonCode).toBe('MALFORMED_ENVELOPE');

    const semantic = await adapter.invoke('semantic_search', { query: 'x' }, new AbortController().signal, ctx(2));
    expect(semantic.status).toBe('error');
    expect(semantic.reasonCode).toBe('MALFORMED_ENVELOPE');

    const hybrid = await adapter.invoke('hybrid_search', { query: 'x' }, new AbortController().signal, ctx(3));
    expect(hybrid.status).toBe('error');
    expect(hybrid.reasonCode).toBe('MALFORMED_ENVELOPE');

    const context = await adapter.invoke('get_context', { filePath: 'x.ts' }, new AbortController().signal, ctx(4));
    expect(context.status).toBe('error');
    expect(context.reasonCode).toBe('MALFORMED_ENVELOPE');
  });

  it('preserves the reasonCode from structured status failed', async () => {
    const adapter = createNexusAdapter(handlersFor({
      get_symbol_source: handler({
        content: [{ type: 'text', text: '' }],
        structuredContent: { status: 'failed', reasonCode: 'parse_error', source: '' },
      }),
    }));
    const observation = await adapter.invoke('get_symbol_source', { symbolId: 'x' }, new AbortController().signal, ctx(1));
    expect(observation.status).toBe('error');
    expect(observation.reasonCode).toBe('parse_error');
  });

  it('validates trace sequence before an aborted N invocation', async () => {
    const adapter = createNexusAdapter(handlersFor());
    const controller = new AbortController();
    controller.abort(new DOMException('timeout', 'TimeoutError'));
    const first = await adapter.invoke('index_status', {}, controller.signal, ctx(1));
    expect(first.status).toBe('timeout');
    // Sequence 1 was consumed even though the call aborted before the handler.
    await expect(adapter.invoke('index_status', {}, new AbortController().signal, ctx(1))).rejects.toThrow(
      'quality_trace_sequence_invalid_or_duplicate',
    );
  });

  it('rejects undefined and non-integer trace sequences', async () => {
    const adapter = createNexusAdapter(handlersFor());
    await expect(
      adapter.invoke('index_status', {}, new AbortController().signal, { traceSequence: 0 } as QualityInvocationContext),
    ).rejects.toThrow('quality_trace_sequence_invalid_or_duplicate');
    await expect(
      adapter.invoke('index_status', {}, new AbortController().signal, { traceSequence: 1.5 } as QualityInvocationContext),
    ).rejects.toThrow('quality_trace_sequence_invalid_or_duplicate');
  });
});
