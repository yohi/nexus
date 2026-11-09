import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadConfig } from '../../src/config/index.js';
import type { NavigationResponse } from '../../src/lsp/contracts.js';
import { createRuntimeAssembly } from '../../src/server/runtime-assembly.js';
import type { RuntimeAssembly } from '../../src/server/runtime/assembly-types.js';
import { buildToolHandlers } from '../../src/server/tools/tool-support.js';
import { createSyntheticProvider, syntheticEmbeddingConfig } from '../benchmarks/performance/synthetic-provider.js';
import { ATA_PROBE_PROJECT_FILES, EXPECTED_LANGUAGE_IDS, TS_JS_PROJECT_FILES } from '../fixtures/lsp/ts-js-project.js';

// ---------------------------------------------------------------------------
// Test-owned environment: temp HOME / XDG_CONFIG_HOME, test-owned trust store, temp worktrees.
// Nothing here reads or writes the real user trust store, HOME or XDG directories.

const RECORDING_SERVER = fileURLToPath(new URL('../fixtures/lsp/recording-language-server.mjs', import.meta.url));
const RECORDING_PROXY = fileURLToPath(new URL('../fixtures/lsp/recording-proxy.mjs', import.meta.url));

interface Harness {
  readonly base: string;
  readonly configHome: string;
  readonly home: string;
  readonly bin: string;
  readonly scratch: string;
}

interface LogEntry {
  readonly pid: number;
  readonly seq: number;
  readonly direction?: 'c2s' | 's2c';
  readonly message: {
    id?: number | string;
    method?: string;
    params?: any;
    result?: any;
  };
}

interface OpenRuntime {
  readonly assembly: RuntimeAssembly;
  readonly handlers: ReturnType<typeof buildToolHandlers>;
}

const harnesses: Harness[] = [];
const runtimes: OpenRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.assembly.runtime.close().catch(() => undefined);
  vi.unstubAllEnvs();
  for (const harness of harnesses.splice(0)) await fs.rm(harness.base, { recursive: true, force: true });
});

const createHarness = async (): Promise<Harness> => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-lsp-integration-')));
  const harness: Harness = {
    base,
    configHome: path.join(base, 'xdg-config'),
    home: path.join(base, 'home'),
    bin: path.join(base, 'bin'),
    scratch: path.join(base, 'scratch'),
  };
  for (const dir of [harness.configHome, path.join(harness.configHome, 'nexus'), harness.home, harness.bin, harness.scratch]) {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700);
  }
  vi.stubEnv('XDG_CONFIG_HOME', harness.configHome);
  vi.stubEnv('HOME', harness.home);
  harnesses.push(harness);
  return harness;
};

const writeFiles = async (root: string, files: Readonly<Record<string, string>>): Promise<void> => {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
  }
};

const createWorktree = async (
  harness: Harness,
  name: string,
  files: Readonly<Record<string, string>> = TS_JS_PROJECT_FILES,
): Promise<string> => {
  const root = path.join(harness.base, name);
  await fs.mkdir(root, { recursive: true });
  await writeFiles(root, files);
  return fs.realpath(root);
};

/** Test-owned executable wrapper (absolute shebang to the running Node) importing a fixture module. */
const createExecutable = async (harness: Harness, name: string, modulePath: string): Promise<string> => {
  const executable = path.join(harness.bin, `${name}.mjs`);
  await fs.writeFile(
    executable,
    `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(modulePath).href)};\n`,
    { mode: 0o700 },
  );
  await fs.chmod(executable, 0o700);
  return fs.realpath(executable);
};

const sha256File = async (file: string): Promise<string> =>
  createHash('sha256').update(await fs.readFile(file)).digest('hex');

interface Approval {
  projectRoot: string;
  executable: string;
  args: string[];
}

const writeTrust = async (harness: Harness, approvals: readonly Approval[]): Promise<void> => {
  const entries = await Promise.all(
    approvals.map(async (approval) => ({
      ...approval,
      executableSha256: await sha256File(approval.executable),
      serverVersion: '6.0.2',
    })),
  );
  const file = path.join(harness.configHome, 'nexus', 'lsp-trust.json');
  await fs.writeFile(file, JSON.stringify({ version: 1, approvals: entries }), { mode: 0o600 });
  await fs.chmod(file, 0o600);
};

interface StubServer {
  readonly executable: string;
  readonly args: string[];
  readonly configPath: string;
  readonly logPath: string;
  configure(update: Record<string, unknown>): Promise<void>;
}

const createStubServer = async (
  harness: Harness,
  name: string,
  initial: Record<string, unknown> = {},
): Promise<StubServer> => {
  const executable = await createExecutable(harness, `${name}-server`, RECORDING_SERVER);
  const configPath = path.join(harness.scratch, `${name}.config.json`);
  const logPath = path.join(harness.scratch, `${name}.log.jsonl`);
  let current: Record<string, unknown> = { logPath, ...initial };
  await fs.writeFile(configPath, JSON.stringify(current));
  return {
    executable,
    args: ['--stdio', '--config', configPath],
    configPath,
    logPath,
    configure: async (update) => {
      current = { ...current, ...update };
      await fs.writeFile(configPath, JSON.stringify(current));
    },
  };
};

const lspEnv = (server: { executable: string; args: string[] }, extra: Record<string, string> = {}) => ({
  NEXUS_LSP_ENABLED: 'true',
  NEXUS_LSP_TYPESCRIPT_EXECUTABLE: server.executable,
  NEXUS_LSP_TYPESCRIPT_ARGS_JSON: JSON.stringify(server.args),
  ...extra,
});

const openRuntime = async (root: string, env: Record<string, string> = {}): Promise<OpenRuntime> => {
  const config = await loadConfig({ projectRoot: root, env });
  const assembly = await createRuntimeAssembly(
    { ...config, embedding: syntheticEmbeddingConfig },
    { createEmbeddingProvider: createSyntheticProvider },
  );
  const handlers = buildToolHandlers(assembly.options, () => assembly.runtime.initialize());
  const opened = { assembly, handlers };
  runtimes.push(opened);
  return opened;
};

const closeRuntime = async (runtime: OpenRuntime): Promise<void> => {
  const index = runtimes.indexOf(runtime);
  if (index >= 0) runtimes.splice(index, 1);
  await runtime.assembly.runtime.close();
};

type NavigationTool = 'get_definition' | 'get_references' | 'get_implementations';

const navigate = async (
  runtime: OpenRuntime,
  tool: NavigationTool,
  args: Record<string, unknown>,
): Promise<NavigationResponse> => {
  const result = await runtime.handlers[tool](args);
  expect(result.isError).not.toBe(true);
  return result.structuredContent as unknown as NavigationResponse;
};

const readLog = async (logPath: string): Promise<LogEntry[]> => {
  let raw: string;
  try {
    raw = await fs.readFile(logPath, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as LogEntry);
};

const byMethod = (log: readonly LogEntry[], method: string) => log.filter((entry) => entry.message.method === method);

const uriOf = (root: string, relative: string): string => pathToFileURL(path.join(root, relative)).href;

/** Zero-based UTF-16 end of a document; CRLF / CR / LF are single line breaks. */
const documentEnd = (text: string): { line: number; character: number } => {
  const lines = text.split(/\r\n|\r|\n/);
  return { line: lines.length - 1, character: lines.at(-1)?.length ?? 0 };
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitUntil = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('condition not met before deadline');
};

/** Single approved stub worktree + runtime. */
const setupStub = async (options: { env?: Record<string, string>; server?: Record<string, unknown> } = {}) => {
  const harness = await createHarness();
  const root = await createWorktree(harness, 'primary');
  const server = await createStubServer(harness, 'primary', options.server);
  await writeTrust(harness, [{ projectRoot: root, executable: server.executable, args: server.args }]);
  const runtime = await openRuntime(root, lspEnv(server, options.env));
  return { harness, root, server, runtime };
};

// ---------------------------------------------------------------------------
// Deterministic stub-server integration (always runs; CI evidence for production wiring)

describe('LSP navigation through the production runtime assembly (recording stub server)', () => {
  it.each<[string, string]>([
    ['U+2028', '\u2028'],
    ['U+2029', '\u2029'],
  ])('returns the public unsupported line separator reasonCode for %s', async (_label, separator) => {
    const { root, runtime } = await setupStub();
    await fs.writeFile(path.join(root, 'shapes.ts'), `export const shape = 1;${separator}\n`);

    const response = await navigate(runtime, 'get_definition', { filePath: 'shapes.ts', line: 1, character: 13 });

    expect(response).toMatchObject({ status: 'unsupported', reasonCode: 'unsupported_line_separator' });
  });

  it.each<[string, string]>([
    ['U+2028', '\u2028'],
    ['U+2029', '\u2029'],
  ])('closes unsafe open document A containing %s and aborts navigation from B', async (_label, separator) => {
    const { root, server, runtime } = await setupStub();
    const shapes = uriOf(root, 'shapes.ts');
    const main = uriOf(root, 'main.ts');
    await server.configure({ responses: { 'textDocument/definition': [] } });

    await navigate(runtime, 'get_definition', { filePath: 'shapes.ts', line: 5, character: 16 });
    const changedA = `${TS_JS_PROJECT_FILES['shapes.ts']!}${separator}\n`;
    await fs.writeFile(path.join(root, 'shapes.ts'), changedA);

    const response = await navigate(runtime, 'get_definition', { filePath: 'main.ts', line: 3, character: 21 });

    expect(response).toMatchObject({
      status: 'stale',
      reasonCode: 'INDEX_FILE_HASH_MISMATCH',
      locations: [],
    });
    expect(response.sourceValidation).not.toBe('verified');
    await waitUntil(async () =>
      byMethod(await readLog(server.logPath), 'textDocument/didClose').some(
        (entry) => entry.message.params.textDocument.uri === shapes,
      ));
    const log = await readLog(server.logPath);
    expect(byMethod(log, 'textDocument/definition').some(
      (entry) => entry.message.params.textDocument.uri === main,
    )).toBe(false);
  });

  it('routes all three tools through an Owner-approved, runtime-local language server', async () => {
    const { root, server, runtime } = await setupStub();
    const shapes = uriOf(root, 'shapes.ts');
    const main = uriOf(root, 'main.ts');
    await server.configure({
      responses: {
        'textDocument/definition': [{ uri: shapes, find: 'makeSquare' }],
        'textDocument/references': [
          { uri: shapes, find: 'makeSquare' },
          { uri: main, find: 'makeSquare', occurrence: 1 },
        ],
        'textDocument/implementation': [{ uri: shapes, find: 'Square implements' }],
      },
    });

    const definition = await navigate(runtime, 'get_definition', { filePath: 'main.ts', line: 3, character: 21 });
    expect(definition).toMatchObject({ status: 'ok', capability: 'supported', sourceValidation: 'verified', truncated: false });
    expect(definition.locations).toEqual([
      { filePath: 'shapes.ts', startLine: 5, startCharacter: 16, endLine: 5, endCharacter: 26 },
    ]);

    const references = await navigate(runtime, 'get_references', { filePath: 'shapes.ts', line: 5, character: 16 });
    expect(references.status).toBe('ok');
    expect(references.locations.map((location) => `${location.filePath}:${location.startLine}`).sort()).toEqual([
      'main.ts:3',
      'shapes.ts:5',
    ]);
    const truncated = await navigate(runtime, 'get_references', {
      filePath: 'shapes.ts',
      line: 5,
      character: 16,
      maxResults: 1,
    });
    expect(truncated).toMatchObject({ status: 'ok', truncated: true });
    expect(truncated.locations).toHaveLength(1);

    const implementations = await navigate(runtime, 'get_implementations', { filePath: 'shapes.ts', line: 1, character: 17 });
    expect(implementations.status).toBe('ok');
    expect(implementations.locations[0]).toMatchObject({ filePath: 'shapes.ts', startLine: 9, startCharacter: 13 });

    // JS cross-file definition (esm.mjs -> util.js).
    await server.configure({ responses: { 'textDocument/definition': [{ uri: uriOf(root, 'util.js'), find: 'helper' }] } });
    const jsDefinition = await navigate(runtime, 'get_definition', { filePath: 'esm.mjs', line: 3, character: 23 });
    expect(jsDefinition.locations).toEqual([
      { filePath: 'util.js', startLine: 1, startCharacter: 16, endLine: 1, endCharacter: 22 },
    ]);

    const log = await readLog(server.logPath);
    const [initialize] = byMethod(log, 'initialize');
    expect(initialize?.message.params.rootUri).toBe(pathToFileURL(root).href);
    expect(initialize?.message.params.initializationOptions).toEqual({ disableAutomaticTypingAcquisition: true });
    expect(JSON.stringify(initialize?.message.params)).not.toContain('npmLocation');
    // One process for TS and JS in this runtime.
    expect(new Set(log.map((entry) => entry.pid)).size).toBe(1);
    // Every navigation request is preceded by the didOpen of its document; no duplicate didOpen.
    const opens = byMethod(log, 'textDocument/didOpen');
    const openedUris = opens.map((entry) => entry.message.params.textDocument.uri);
    expect(new Set(openedUris).size).toBe(openedUris.length);
    expect(opens.every((entry) => entry.message.params.textDocument.version === 1)).toBe(true);
    const firstDefinition = byMethod(log, 'textDocument/definition')[0];
    const mainOpen = opens.find((entry) => entry.message.params.textDocument.uri === main);
    expect(mainOpen !== undefined && firstDefinition !== undefined && mainOpen.seq < firstDefinition.seq).toBe(true);
    expect(firstDefinition?.message.params.position).toEqual({ line: 2, character: 21 });
  });

  it('opens every supported extension with the shared extension-derived languageId', async () => {
    const { root, server, runtime } = await setupStub();
    for (const filePath of Object.keys(EXPECTED_LANGUAGE_IDS)) {
      const result = await navigate(runtime, 'get_definition', { filePath, line: 1, character: 0 });
      expect(result, filePath).toMatchObject({ status: 'ok', capability: 'supported', locations: [] });
    }
    const opens = byMethod(await readLog(server.logPath), 'textDocument/didOpen');
    const observed = Object.fromEntries(
      opens.map((entry) => [
        path.relative(root, fileURLToPath(entry.message.params.textDocument.uri)),
        entry.message.params.textDocument.languageId,
      ]),
    );
    expect(observed).toEqual(EXPECTED_LANGUAGE_IDS);
  });

  it('synchronizes CRLF / non-BMP saved edits with previous-text full-range didChange and increasing versions', async () => {
    const { root, server, runtime } = await setupStub();
    const uri = uriOf(root, 'unicode.ts');
    const v1 = "const s = '😀'; export const greet = s;\r\nexport const again = greet;";
    const v2 = `${v1}\r\nexport const third = again;`;
    const v3 = `// 😀😀\r\n${v2}`;
    await fs.writeFile(path.join(root, 'unicode.ts'), v1);
    await server.configure({ responses: { 'textDocument/definition': [{ uri, find: 'greet' }] } });

    const first = await navigate(runtime, 'get_definition', { filePath: 'unicode.ts', line: 2, character: 21 });
    expect(first.locations).toEqual([
      { filePath: 'unicode.ts', startLine: 1, startCharacter: 29, endLine: 1, endCharacter: 34 },
    ]);
    // Repeated navigation on unchanged text: no duplicate didOpen and no spurious change.
    await navigate(runtime, 'get_definition', { filePath: 'unicode.ts', line: 2, character: 21 });

    await fs.writeFile(path.join(root, 'unicode.ts'), v2);
    await navigate(runtime, 'get_definition', { filePath: 'unicode.ts', line: 2, character: 21 });
    await fs.writeFile(path.join(root, 'unicode.ts'), v3);
    const shifted = await navigate(runtime, 'get_definition', { filePath: 'unicode.ts', line: 3, character: 21 });
    expect(shifted.locations[0]).toMatchObject({ startLine: 2, startCharacter: 29 });

    const inside = await navigate(runtime, 'get_definition', { filePath: 'unicode.ts', line: 1, character: 4 });
    expect(inside).toMatchObject({ status: 'not_found', reasonCode: 'POSITION_INSIDE_SURROGATE_PAIR', capability: 'not_checked' });

    const log = (await readLog(server.logPath)).filter(
      (entry) => entry.message.params?.textDocument?.uri === uri,
    );
    const opens = byMethod(log, 'textDocument/didOpen');
    expect(opens).toHaveLength(1);
    expect(opens[0]?.message.params.textDocument).toMatchObject({ version: 1, languageId: 'typescript', text: v1 });
    const changes = byMethod(log, 'textDocument/didChange');
    expect(changes.map((entry) => entry.message.params.textDocument.version)).toEqual([2, 3]);
    expect(changes.map((entry) => entry.message.params.contentChanges)).toEqual([
      [{ range: { start: { line: 0, character: 0 }, end: documentEnd(v1) }, text: v2 }],
      [{ range: { start: { line: 0, character: 0 }, end: documentEnd(v2) }, text: v3 }],
    ]);
    expect(documentEnd(v1)).toEqual({ line: 1, character: 27 });
    // Each change strictly precedes the next definition request (ordered requests).
    const definitions = byMethod(log, 'textDocument/definition');
    expect(definitions).toHaveLength(4);
    expect(changes[0]!.seq).toBeLessThan(definitions[2]!.seq);
    expect(changes[1]!.seq).toBeLessThan(definitions[3]!.seq);
  });

  it('PR #345: refreshes a modified open document A before navigating from B and reports current A positions', async () => {
    const { root, server, runtime } = await setupStub();
    const shapes = uriOf(root, 'shapes.ts');
    const main = uriOf(root, 'main.ts');
    await server.configure({ responses: { 'textDocument/definition': [{ uri: shapes, find: 'makeSquare' }] } });

    // Open A through a direct navigation.
    const opened = await navigate(runtime, 'get_definition', { filePath: 'shapes.ts', line: 5, character: 16 });
    expect(opened.locations[0]).toMatchObject({ filePath: 'shapes.ts', startLine: 5 });

    // Edit A on disk without navigating it directly.
    const oldA = TS_JS_PROJECT_FILES['shapes.ts']!;
    const newA = `// moved\n// moved again\n${oldA}`;
    await fs.writeFile(path.join(root, 'shapes.ts'), newA);

    const fromB = await navigate(runtime, 'get_definition', { filePath: 'main.ts', line: 3, character: 21 });
    expect(fromB).toMatchObject({ status: 'ok', sourceValidation: 'verified' });
    // Must match current A on disk (a stale A would still report line 5).
    expect(fromB.locations).toEqual([
      { filePath: 'shapes.ts', startLine: 7, startCharacter: 16, endLine: 7, endCharacter: 26 },
    ]);

    const log = await readLog(server.logPath);
    const aChanges = byMethod(log, 'textDocument/didChange').filter(
      (entry) => entry.message.params.textDocument.uri === shapes,
    );
    expect(aChanges).toHaveLength(1);
    expect(aChanges[0]?.message.params.textDocument.version).toBe(2);
    expect(aChanges[0]?.message.params.contentChanges).toEqual([
      { range: { start: { line: 0, character: 0 }, end: documentEnd(oldA) }, text: newA },
    ]);
    const bDefinition = byMethod(log, 'textDocument/definition').find(
      (entry) => entry.message.params.textDocument.uri === main,
    );
    expect(bDefinition).toBeDefined();
    expect(aChanges[0]!.seq).toBeLessThan(bDefinition!.seq);

    // A deleted: navigation from B aborts (retryable stale) instead of trusting old A text.
    await fs.rm(path.join(root, 'shapes.ts'));
    const definitionsBefore = byMethod(log, 'textDocument/definition').length;
    const aborted = await navigate(runtime, 'get_definition', { filePath: 'main.ts', line: 3, character: 21 });
    expect(aborted).toMatchObject({ status: 'stale', reasonCode: 'INDEX_FILE_MISSING', locations: [] });
    // didClose is a notification: wait for the server to record it.
    await waitUntil(async () =>
      byMethod(await readLog(server.logPath), 'textDocument/didClose').some(
        (entry) => entry.message.params.textDocument.uri === shapes,
      ));
    const after = await readLog(server.logPath);
    expect(byMethod(after, 'textDocument/definition')).toHaveLength(definitionsBefore);
  });

  it('navigates verified symbolIds, refuses a stale symbolId and still serves the saved dirty file by position', async () => {
    const { root, server, runtime } = await setupStub();
    const shapes = uriOf(root, 'shapes.ts');
    await server.configure({ responses: { 'textDocument/definition': [{ uri: shapes, find: 'makeSquare' }] } });
    await runtime.assembly.runtime.initialize();
    await runtime.assembly.runtime.reindex();

    const symbolIds: Record<string, string> = {};
    for (const filePath of Object.keys(EXPECTED_LANGUAGE_IDS)) {
      const outline = (await runtime.handlers.get_file_outline({ filePath })).structuredContent as {
        status: string;
        symbols?: Array<{ symbolId?: string; name?: string }>;
      };
      const symbol = filePath === 'shapes.ts'
        ? outline.symbols?.find((candidate) => candidate.name === 'makeSquare')
        : outline.symbols?.find((candidate) => typeof candidate.symbolId === 'string');
      if (outline.status === 'ok' && symbol?.symbolId !== undefined) symbolIds[filePath] = symbol.symbolId;
    }
    expect(Object.keys(symbolIds)).toEqual(expect.arrayContaining(['shapes.ts', 'util.js']));

    const viaSymbol = await navigate(runtime, 'get_definition', { symbolId: symbolIds['shapes.ts'] });
    expect(viaSymbol).toMatchObject({ status: 'ok', sourceValidation: 'verified' });
    for (const [filePath, symbolId] of Object.entries(symbolIds)) {
      if (filePath === 'shapes.ts') continue;
      const result = await navigate(runtime, 'get_definition', { symbolId });
      expect(result.status, filePath).toBe('ok');
    }
    let log = await readLog(server.logPath);
    // symbolId and file/position share conversion: Nexus (5,16) -> LSP (4,16) on the name token.
    expect(byMethod(log, 'textDocument/definition')[0]?.message.params.position).toEqual({ line: 4, character: 16 });
    for (const entry of byMethod(log, 'textDocument/didOpen')) {
      const relative = path.relative(root, fileURLToPath(entry.message.params.textDocument.uri));
      expect(entry.message.params.textDocument.languageId, relative).toBe(EXPECTED_LANGUAGE_IDS[relative]);
    }

    // Dirty saved edit that renames the indexed symbol: the old symbolId must never be remapped.
    const dirty = TS_JS_PROJECT_FILES['shapes.ts']!.replace('makeSquare', 'makeBox');
    await fs.writeFile(path.join(root, 'shapes.ts'), `// dirty\n${dirty}`);
    const definitionsBefore = byMethod(log, 'textDocument/definition').length;
    const stale = await navigate(runtime, 'get_definition', { symbolId: symbolIds['shapes.ts'] });
    expect(['stale', 'stale_identity', 'index_incomplete', 'not_found']).toContain(stale.status);
    expect(stale.locations).toEqual([]);
    log = await readLog(server.logPath);
    expect(byMethod(log, 'textDocument/definition')).toHaveLength(definitionsBefore);

    // File/position on the saved dirty file works without waiting for reindexing.
    await server.configure({ responses: { 'textDocument/definition': [{ uri: shapes, find: 'makeBox' }] } });
    const dirtyResult = await navigate(runtime, 'get_definition', { filePath: 'shapes.ts', line: 6, character: 16 });
    expect(dirtyResult).toMatchObject({ status: 'ok', sourceValidation: 'verified' });
    expect(dirtyResult.locations[0]).toMatchObject({ filePath: 'shapes.ts', startLine: 6, startCharacter: 16 });
  });

  it('restarts with a clean didOpen version 1 after idle exit and re-resolves approval on every first launch', async () => {
    const { harness, root, server, runtime } = await setupStub({ env: { NEXUS_LSP_IDLE_TIMEOUT_MS: '1000' } });
    await navigate(runtime, 'get_definition', { filePath: 'main.ts', line: 3, character: 21 });
    const firstPid = (await readLog(server.logPath))[0]!.pid;
    await waitUntil(() => !isAlive(firstPid));

    await navigate(runtime, 'get_definition', { filePath: 'main.ts', line: 3, character: 21 });
    const log = await readLog(server.logPath);
    const pids = [...new Set(log.map((entry) => entry.pid))];
    expect(pids).toHaveLength(2);
    expect(byMethod(log, 'initialize')).toHaveLength(2);
    const secondOpens = byMethod(log, 'textDocument/didOpen').filter((entry) => entry.pid === pids[1]);
    expect(secondOpens.map((entry) => entry.message.params.textDocument.version)).toEqual([1]);
    await waitUntil(() => !isAlive(pids[1]!));

    // Owner revokes the approval out of band: the next first launch must be refused.
    await writeTrust(harness, []);
    const revoked = await navigate(runtime, 'get_definition', { filePath: 'main.ts', line: 3, character: 21 });
    expect(revoked).toMatchObject({ status: 'unavailable', capability: 'unavailable', reasonCode: 'LSP_TRUST_REQUIRED' });
    expect(new Set((await readLog(server.logPath)).map((entry) => entry.pid)).size).toBe(2);
    expect(root).toBeTruthy();
  });

  it('refuses to report navigation when the server dies during document synchronization', async () => {
    const { server, runtime } = await setupStub({ server: { exitOn: 'textDocument/didOpen' } });
    const result = await navigate(runtime, 'get_definition', { filePath: 'main.ts', line: 3, character: 21 });
    expect(result.status).not.toBe('ok');
    expect(result.locations).toEqual([]);
    const log = await readLog(server.logPath);
    expect(byMethod(log, 'textDocument/didOpen')).toHaveLength(1);
    expect(byMethod(log, 'textDocument/definition')).toHaveLength(0);
  });

  it('closes the language server on runtime close', async () => {
    const { server, runtime } = await setupStub();
    await navigate(runtime, 'get_definition', { filePath: 'main.ts', line: 3, character: 21 });
    const pid = (await readLog(server.logPath))[0]!.pid;
    expect(isAlive(pid)).toBe(true);
    await closeRuntime(runtime);
    await waitUntil(() => !isAlive(pid), 5_000);
    const log = await readLog(server.logPath);
    expect(byMethod(log, 'shutdown')).toHaveLength(1);
    expect(byMethod(log, 'exit')).toHaveLength(1);
  });

  it('isolates divergent worktrees and keeps unapproved/absent/invalid LSP failures LSP-local', async () => {
    const harness = await createHarness();
    const primary = await createWorktree(harness, 'primary');
    const linked = await createWorktree(harness, 'linked', {
      ...TS_JS_PROJECT_FILES,
      'shapes.ts': `// linked\n// worktree\n// diverges\n${TS_JS_PROJECT_FILES['shapes.ts']!}`,
    });
    const unapproved = await createWorktree(harness, 'unapproved');
    const absent = await createWorktree(harness, 'absent');
    const invalid = await createWorktree(harness, 'invalid');
    const primaryServer = await createStubServer(harness, 'primary');
    const linkedServer = await createStubServer(harness, 'linked');
    for (const [server, root] of [[primaryServer, primary], [linkedServer, linked]] as const) {
      await server.configure({ responses: { 'textDocument/definition': [{ uri: uriOf(root, 'shapes.ts'), find: 'makeSquare' }] } });
    }
    const missingExecutable = path.join(harness.bin, 'missing-server.mjs');
    await writeTrust(harness, [
      { projectRoot: primary, executable: primaryServer.executable, args: primaryServer.args },
      { projectRoot: linked, executable: linkedServer.executable, args: linkedServer.args },
      { projectRoot: absent, executable: primaryServer.executable, args: primaryServer.args },
    ]);

    const primaryRuntime = await openRuntime(primary, lspEnv(primaryServer));
    const linkedRuntime = await openRuntime(linked, lspEnv(linkedServer));
    const [fromPrimary, fromLinked] = await Promise.all([
      navigate(primaryRuntime, 'get_definition', { filePath: 'main.ts', line: 3, character: 21 }),
      navigate(linkedRuntime, 'get_definition', { filePath: 'main.ts', line: 3, character: 21 }),
    ]);
    expect(fromPrimary.locations[0]).toMatchObject({ filePath: 'shapes.ts', startLine: 5 });
    expect(fromLinked.locations[0]).toMatchObject({ filePath: 'shapes.ts', startLine: 8 });
    const primaryLog = await readLog(primaryServer.logPath);
    const linkedLog = await readLog(linkedServer.logPath);
    expect(primaryLog[0]!.pid).not.toBe(linkedLog[0]!.pid);
    expect(byMethod(primaryLog, 'initialize')[0]?.message.params.rootUri).toBe(pathToFileURL(primary).href);
    expect(byMethod(linkedLog, 'initialize')[0]?.message.params.rootUri).toBe(pathToFileURL(linked).href);
    expect(JSON.stringify(primaryLog)).not.toContain(pathToFileURL(linked).href);
    expect(JSON.stringify(linkedLog)).not.toContain(pathToFileURL(primary).href);

    const cases: Array<[string, Record<string, string>, string]> = [
      [unapproved, lspEnv(primaryServer), 'LSP_TRUST_REQUIRED'],
      [absent, lspEnv({ executable: missingExecutable, args: primaryServer.args }), 'LSP_EXECUTABLE_NOT_APPROVED'],
      [invalid, { ...lspEnv(primaryServer), NEXUS_LSP_STARTUP_TIMEOUT_MS: '0' }, 'LSP_CONFIG_INVALID'],
    ];
    const pidsBefore = new Set((await readLog(primaryServer.logPath)).map((entry) => entry.pid));
    for (const [root, env, reasonCode] of cases) {
      const runtime = await openRuntime(root, env);
      const result = await navigate(runtime, 'get_definition', { filePath: 'main.ts', line: 3, character: 21 });
      expect(result, reasonCode).toMatchObject({ status: 'unavailable', capability: 'unavailable', reasonCode, locations: [] });
      const grep = await runtime.handlers.grep_search({ pattern: 'makeSquare' });
      expect(grep.isError).not.toBe(true);
      await closeRuntime(runtime);
    }
    // No process was spawned for any refused worktree.
    expect(new Set((await readLog(primaryServer.logPath)).map((entry) => entry.pid))).toEqual(pidsBefore);
  });

  it('reports LSP_NOT_CONFIGURED by default without affecting other tools', async () => {
    const harness = await createHarness();
    const root = await createWorktree(harness, 'default');
    const runtime = await openRuntime(root);
    const result = await navigate(runtime, 'get_references', { filePath: 'main.ts', line: 3, character: 21 });
    expect(result).toMatchObject({ status: 'unavailable', capability: 'unavailable', reasonCode: 'LSP_NOT_CONFIGURED' });
    expect((await runtime.handlers.grep_search({ pattern: 'makeSquare' })).isError).not.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Opt-in real typescript-language-server@6.0.2 suite.
//
// Runs ONLY when NEXUS_LSP_TEST_SERVER is an absolute path to an explicitly prepared binary
// whose `--version` (checked here, on that binary only) is exactly 6.0.2, and the repository
// TypeScript is 5.9.x. Otherwise every test is reported as SKIPPED (never as PASS).

const execFileAsync = promisify(execFile);

const probeRealServer = async (): Promise<{ ready: boolean; reason: string; executable?: string }> => {
  const candidate = process.env.NEXUS_LSP_TEST_SERVER;
  if (candidate === undefined || candidate === '') return { ready: false, reason: 'NEXUS_LSP_TEST_SERVER is not set' };
  if (!path.isAbsolute(candidate)) return { ready: false, reason: 'NEXUS_LSP_TEST_SERVER is not absolute' };
  let executable: string;
  try {
    executable = await fs.realpath(candidate);
    const { stdout } = await execFileAsync(executable, ['--version'], {
      timeout: 10_000,
      env: { PATH: [path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(path.delimiter), HOME: os.tmpdir() },
    });
    if (stdout.trim() !== '6.0.2') return { ready: false, reason: 'test server --version is not 6.0.2' };
  } catch {
    return { ready: false, reason: 'test server --version failed' };
  }
  const tsVersion = JSON.parse(
    await fs.readFile(fileURLToPath(new URL('../../node_modules/typescript/package.json', import.meta.url)), 'utf8'),
  ) as { version: string };
  if (!tsVersion.version.startsWith('5.9.')) return { ready: false, reason: 'repository TypeScript is not 5.9.x' };
  return { ready: true, reason: 'ready', executable };
};

const realServer = await probeRealServer();

describe.skipIf(!realServer.ready)(
  `real typescript-language-server@6.0.2 + TypeScript 5.9.x (NOT_RUN unless prepared: ${realServer.reason})`,
  () => {
    const setupReal = async (files: Readonly<Record<string, string>> = TS_JS_PROJECT_FILES) => {
      const harness = await createHarness();
      const root = await createWorktree(harness, 'real', files);
      const typescriptDir = await fs.realpath(fileURLToPath(new URL('../../node_modules/typescript', import.meta.url)));
      await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });
      await fs.symlink(typescriptDir, path.join(root, 'node_modules', 'typescript'), 'dir');
      const executable = await createExecutable(harness, 'real-proxy', RECORDING_PROXY);
      const configPath = path.join(harness.scratch, 'real.config.json');
      const logPath = path.join(harness.scratch, 'real.log.jsonl');
      await fs.writeFile(configPath, JSON.stringify({ logPath, target: realServer.executable, targetArgs: ['--stdio'] }));
      const args = ['--stdio', '--config', configPath];
      await writeTrust(harness, [{ projectRoot: root, executable, args }]);
      const env = lspEnv({ executable, args }, { NEXUS_LSP_STARTUP_TIMEOUT_MS: '60000', NEXUS_LSP_REQUEST_TIMEOUT_MS: '60000' });
      const runtime = await openRuntime(root, env);
      return { harness, root, logPath, runtime, env };
    };
    const c2s = (log: readonly LogEntry[]) => log.filter((entry) => entry.direction === 'c2s');

    it('negotiates Incremental sync without ATA and navigates TS/JS definition, references and implementations', async () => {
      const { logPath, runtime } = await setupReal();
      const definition = await navigate(runtime, 'get_definition', { filePath: 'main.ts', line: 3, character: 21 });
      expect(definition.status).toBe('ok');
      expect(definition.locations).toContainEqual(expect.objectContaining({ filePath: 'shapes.ts', startLine: 5, startCharacter: 16 }));
      const references = await navigate(runtime, 'get_references', { filePath: 'shapes.ts', line: 5, character: 16 });
      expect(references.locations.map((location) => location.filePath)).toEqual(expect.arrayContaining(['main.ts', 'shapes.ts']));
      const implementations = await navigate(runtime, 'get_implementations', { filePath: 'shapes.ts', line: 1, character: 17 });
      expect(implementations.locations).toContainEqual(expect.objectContaining({ filePath: 'shapes.ts', startLine: 9 }));
      const jsDefinition = await navigate(runtime, 'get_definition', { filePath: 'esm.mjs', line: 3, character: 23 });
      expect(jsDefinition.locations).toContainEqual(expect.objectContaining({ filePath: 'util.js', startLine: 1 }));

      const log = await readLog(logPath);
      const request = log.find((entry) => entry.direction === 'c2s' && entry.message.method === 'initialize');
      expect(request?.message.params.initializationOptions).toEqual({ disableAutomaticTypingAcquisition: true });
      const reply = log.find((entry) => entry.direction === 's2c' && entry.message.id === request?.message.id);
      expect(reply?.message.result.capabilities.textDocumentSync).toBe(2);
    });

    it('opens all eight extensions with the expected languageId', async () => {
      const { root, logPath, runtime } = await setupReal();
      for (const filePath of Object.keys(EXPECTED_LANGUAGE_IDS)) {
        expect((await navigate(runtime, 'get_definition', { filePath, line: 1, character: 0 })).status, filePath).toBe('ok');
      }
      const opens = byMethod(c2s(await readLog(logPath)), 'textDocument/didOpen');
      const observed = Object.fromEntries(
        opens.map((entry) => [path.relative(root, fileURLToPath(entry.message.params.textDocument.uri)), entry.message.params.textDocument.languageId]),
      );
      expect(observed).toMatchObject(EXPECTED_LANGUAGE_IDS);
    });

    it('PR #345 on the real server: refreshes modified open A before navigating B; restart reopens at version 1', async () => {
      const { root, logPath, runtime, env } = await setupReal();
      await navigate(runtime, 'get_definition', { filePath: 'shapes.ts', line: 5, character: 16 });
      const oldA = TS_JS_PROJECT_FILES['shapes.ts']!;
      const newA = `// moved\n// moved again\n${oldA}`;
      await fs.writeFile(path.join(root, 'shapes.ts'), newA);
      const fromB = await navigate(runtime, 'get_definition', { filePath: 'main.ts', line: 3, character: 21 });
      expect(fromB.locations).toContainEqual(expect.objectContaining({ filePath: 'shapes.ts', startLine: 7, startCharacter: 16 }));
      const log = c2s(await readLog(logPath));
      const change = byMethod(log, 'textDocument/didChange').find(
        (entry) => entry.message.params.textDocument.uri === uriOf(root, 'shapes.ts'),
      );
      expect(change?.message.params.textDocument.version).toBe(2);
      expect(change?.message.params.contentChanges).toEqual([
        { range: { start: { line: 0, character: 0 }, end: documentEnd(oldA) }, text: newA },
      ]);
      const bRequest = byMethod(log, 'textDocument/definition').find(
        (entry) => entry.message.params.textDocument.uri === uriOf(root, 'main.ts'),
      );
      expect(change!.seq).toBeLessThan(bRequest!.seq);

      await closeRuntime(runtime);
      const reopened = await openRuntime(root, env);
      await navigate(reopened, 'get_definition', { filePath: 'main.ts', line: 3, character: 21 });
      const after = c2s(await readLog(logPath));
      const lastPid = after.at(-1)!.pid;
      const reopenedOpens = byMethod(after.filter((entry) => entry.pid === lastPid), 'textDocument/didOpen');
      expect(reopenedOpens.every((entry) => entry.message.params.textDocument.version === 1)).toBe(true);
    });

    it('ATA: no typings cache or @types side effects observed for an inferred JS project (weak evidence)', async () => {
      const { harness, root, runtime } = await setupReal(ATA_PROBE_PROJECT_FILES);
      expect((await navigate(runtime, 'get_definition', { filePath: 'index.js', line: 3, character: 21 })).status).toBe('ok');
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await expect(fs.access(path.join(harness.home, '.cache', 'typescript'))).rejects.toThrow();
      await expect(fs.access(path.join(root, 'node_modules', '@types'))).rejects.toThrow();
    });
  },
);

// The child PATH is fixed by the trust policy (Node runtime dir + system dirs), so no
// controlled npm-execution instrumentation can be injected without weakening that policy.
it.skip('ATA: npm process execution / package download observation — NOT_RUN: no controlled instrumentation available', () => {
  // Intentionally not implemented; reported as skipped, never as PASS.
});
