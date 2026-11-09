import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Location, LocationLink } from 'vscode-languageserver-protocol';

import type {
  ILspProvider,
  LspCapabilities,
  LspNavigationKind,
  NavigationToolArgs,
  VerifiedSymbolNavigationResult,
} from '../../../src/lsp/contracts.js';
import { LspNavigationService } from '../../../src/lsp/navigation-service.js';
import type { LspProviderAcquisition } from '../../../src/lsp/process-manager.js';
import { RuntimeLocalLspManager } from '../../../src/lsp/process-manager.js';
import {
  LspProtocolError,
  LspRequestTimeoutError,
  LspSyncUnsupportedError,
} from '../../../src/lsp/protocol-client.js';
import { InvalidNavigationArgumentsError } from '../../../src/lsp/target-resolver.js';
import { PathSanitizer } from '../../../src/server/path-sanitizer.js';
import type { SymbolRetrievalService } from '../../../src/structured/retrieval-service.js';

// ---------------------------------------------------------------------------
// Fixtures

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const makeRoot = async (): Promise<string> => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-lsp-nav-')));
  tempDirs.push(dir);
  return dir;
};

const write = async (root: string, relativePath: string, content: string): Promise<void> => {
  const absolute = path.join(root, relativePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content);
};

const sha = (content: string): string => createHash('sha256').update(content).digest('hex');

const uriOf = (root: string, relativePath: string): string => pathToFileURL(path.join(root, relativePath)).href;

const location = (root: string, relativePath: string, line: number, start: number, end: number): Location => ({
  uri: uriOf(root, relativePath),
  range: { start: { line, character: start }, end: { line, character: end } },
});

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

type ProviderEvent =
  | { op: 'sync'; uri: string; languageId: string; text: string }
  | { op: 'close'; uri: string }
  | { op: 'navigate'; uri: string; kind: LspNavigationKind; position: { line: number; character: number } };

type RawResult = null | readonly (Location | LocationLink)[];

/** In-memory provider emulating the Protocol Client's open-document ownership. */
class FakeProvider implements ILspProvider {
  readonly events: ProviderEvent[] = [];
  readonly open = new Map<string, string>();
  readonly syncInputs: Parameters<ILspProvider['syncDocument']>[0][] = [];
  navigateImpl: (input: Parameters<ILspProvider['navigate']>[0]) => Promise<RawResult> = () => Promise.resolve(null);
  syncImpl: ((input: Parameters<ILspProvider['syncDocument']>[0]) => Promise<void>) | undefined;
  closeImpl: ((input: { uri: string }) => Promise<void>) | undefined;
  active = 0;
  maxActive = 0;

  start(): Promise<LspCapabilities> {
    return Promise.resolve({ definition: true, references: true, implementations: true, positionEncoding: 'utf-16' });
  }

  async syncDocument(input: Parameters<ILspProvider['syncDocument']>[0]): Promise<void> {
    this.syncInputs.push(input);
    this.events.push({ op: 'sync', uri: input.uri, languageId: input.languageId, text: input.text });
    await this.track(async () => {
      if (this.syncImpl !== undefined) await this.syncImpl(input);
    });
    this.open.set(input.uri, input.text);
  }

  async closeDocument(input: { uri: string }): Promise<void> {
    this.events.push({ op: 'close', uri: input.uri });
    if (this.closeImpl !== undefined) await this.closeImpl(input);
    this.open.delete(input.uri);
  }

  listOpenDocumentUris(): readonly string[] {
    return [...this.open.keys()];
  }

  navigate(input: Parameters<ILspProvider['navigate']>[0]): Promise<RawResult> {
    this.events.push({ op: 'navigate', uri: input.uri, kind: input.kind, position: input.position });
    return this.track(() => this.navigateImpl(input));
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  private async track<T>(operation: () => Promise<T>): Promise<T> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      return await operation();
    } finally {
      this.active -= 1;
    }
  }
}

type SymbolsMock = Pick<SymbolRetrievalService, 'resolveVerifiedNavigationTarget'> & {
  resolveVerifiedNavigationTarget: ReturnType<typeof vi.fn>;
};

const symbolsReturning = (
  impl: (input: { symbolId: string; signal?: AbortSignal }, call: number) => VerifiedSymbolNavigationResult,
): SymbolsMock => {
  let call = 0;
  return {
    resolveVerifiedNavigationTarget: vi.fn((input: { symbolId: string; signal?: AbortSignal }) => {
      call += 1;
      const current = call;
      return Promise.resolve().then(() => impl(input, current));
    }),
  };
};

const unusedSymbols = (): SymbolsMock =>
  symbolsReturning(() => {
    throw new Error('symbol service must not be called');
  });

const SYMBOL_ID = 'symbol_v1_1234567890123456789012345678901234567890123';

const okSymbol = (filePath: string, content: string, generationId = 'gen-1'): VerifiedSymbolNavigationResult => ({
  status: 'ok',
  target: {
    symbolId: SYMBOL_ID,
    filePath,
    languageId: 'typescript',
    position: { line: 1, character: 16 },
    fileSha256: sha(content),
    generationId,
  },
});

const A_TEXT = 'export function alpha(): number {\n  return 1;\n}\n';
const B_TEXT = "import { alpha } from './a.js';\nexport const beta = alpha();\n";

interface Harness {
  root: string;
  provider: FakeProvider;
  service: LspNavigationService;
  acquire: ReturnType<typeof vi.fn>;
}

const createHarness = async (
  options: {
    symbols?: SymbolsMock;
    acquisition?: () => LspProviderAcquisition;
    capabilities?: Partial<LspCapabilities>;
    isExcluded?: (filePath: string) => boolean;
    lockTimeoutMs?: number;
    root?: string;
  } = {},
): Promise<Harness> => {
  const root = options.root ?? (await makeRoot());
  if (options.root === undefined) {
    await write(root, 'src/a.ts', A_TEXT);
    await write(root, 'src/b.ts', B_TEXT);
  }
  const sanitizer = await PathSanitizer.create(root);
  const provider = new FakeProvider();
  const capabilities: LspCapabilities = {
    definition: true,
    references: true,
    implementations: true,
    positionEncoding: 'utf-16',
    ...options.capabilities,
  };
  const acquire = vi.fn(
    (_input: { signal?: AbortSignal }): Promise<LspProviderAcquisition> =>
      Promise.resolve(options.acquisition?.() ?? { status: 'ok', provider, capabilities }),
  );
  const service = new LspNavigationService({
    projectRoot: root,
    sanitizer,
    symbols: options.symbols ?? unusedSymbols(),
    isExcluded: options.isExcluded ?? (() => false),
    acquireProvider: acquire,
    ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
  });
  return { root, provider, service, acquire };
};

const fileArgs = (filePath: string, line = 2, character = 15): NavigationToolArgs => ({ filePath, line, character });

const navigationsOf = (provider: FakeProvider) => provider.events.filter((e) => e.op === 'navigate');

// ---------------------------------------------------------------------------

describe('LspNavigationService argument handling', () => {
  it.each<[string, NavigationToolArgs]>([
    ['mixed target', { symbolId: SYMBOL_ID, filePath: 'src/a.ts', line: 1, character: 0 }],
    ['partial file target', { filePath: 'src/a.ts', line: 1 }],
    ['missing target', {}],
    ['line zero', { filePath: 'src/a.ts', line: 0, character: 0 }],
    ['negative character', { filePath: 'src/a.ts', line: 1, character: -1 }],
  ])('rejects %s before acquiring a provider or calling the symbol service', async (_label, args) => {
    const symbols = unusedSymbols();
    const { service, acquire, provider } = await createHarness({ symbols });
    await expect(service.navigate({ kind: 'definition', args })).rejects.toBeInstanceOf(
      InvalidNavigationArgumentsError,
    );
    expect(acquire).not.toHaveBeenCalled();
    expect(symbols.resolveVerifiedNavigationTarget).not.toHaveBeenCalled();
    expect(provider.events).toEqual([]);
  });

  it('accepts character 0 and converts the 1-based line to an LSP zero-based position', async () => {
    const { service, provider, root } = await createHarness();
    const response = await service.navigate({ kind: 'definition', args: fileArgs('src/b.ts', 1, 0) });
    expect(response).toMatchObject({ status: 'ok', capability: 'supported', locations: [] });
    expect(navigationsOf(provider)).toEqual([
      { op: 'navigate', uri: uriOf(root, 'src/b.ts'), kind: 'definition', position: { line: 0, character: 0 } },
    ]);
  });
});

describe('LspNavigationService dispatch and result mapping', () => {
  it.each<LspNavigationKind>(['definition', 'references', 'implementations'])(
    'dispatches %s independently with the synchronized current disk text',
    async (kind) => {
      const { service, provider, root } = await createHarness();
      provider.navigateImpl = () => Promise.resolve([location(root, 'src/a.ts', 0, 16, 21)]);
      const response = await service.navigate({ kind, args: fileArgs('src/b.ts', 2, 21) });
      expect(response).toEqual({
        status: 'ok',
        capability: 'supported',
        locations: [{ filePath: 'src/a.ts', startLine: 1, startCharacter: 16, endLine: 1, endCharacter: 21 }],
        truncated: false,
        sourceValidation: 'verified',
      });
      expect(provider.syncInputs).toEqual([{ uri: uriOf(root, 'src/b.ts'), languageId: 'typescript', text: B_TEXT }]);
      expect(navigationsOf(provider).map((e) => e.kind)).toEqual([kind]);
    },
  );

  it('normalizes a null reply to ok with empty verified locations', async () => {
    const { service } = await createHarness();
    await expect(service.navigate({ kind: 'implementations', args: fileArgs('src/a.ts', 1, 16) })).resolves.toEqual({
      status: 'ok',
      capability: 'supported',
      locations: [],
      truncated: false,
      sourceValidation: 'verified',
    });
  });

  it('returns unsupported without synchronizing when the negotiated capability is absent', async () => {
    const { service, provider } = await createHarness({ capabilities: { implementations: false } });
    const response = await service.navigate({ kind: 'implementations', args: fileArgs('src/a.ts', 1, 16) });
    expect(response).toMatchObject({
      status: 'unsupported',
      capability: 'unsupported',
      reasonCode: 'LSP_CAPABILITY_UNSUPPORTED',
      locations: [],
    });
    expect(provider.events).toEqual([]);
  });

  it('maps a provider acquisition failure (missing trust) to unavailable without LSP calls', async () => {
    const { service, provider } = await createHarness({
      acquisition: () => ({ status: 'unavailable', reasonCode: 'LSP_TRUST_REQUIRED' }),
    });
    await expect(service.navigate({ kind: 'definition', args: fileArgs('src/a.ts', 1, 16) })).resolves.toEqual({
      status: 'unavailable',
      capability: 'unavailable',
      locations: [],
      truncated: false,
      sourceValidation: 'unknown',
      reasonCode: 'LSP_TRUST_REQUIRED',
    });
    expect(provider.events).toEqual([]);
  });

  it('reports missing trust through a real RuntimeLocalLspManager without spawning', async () => {
    const root = await makeRoot();
    await write(root, 'src/a.ts', A_TEXT);
    const spawnProcess = vi.fn();
    const manager = new RuntimeLocalLspManager({
      projectRoot: root,
      lsp: {
        enabled: true,
        typescript: { executable: '/nonexistent/typescript-language-server', args: ['--stdio'] },
        startupTimeoutMs: 1000,
        requestTimeoutMs: 1000,
        idleTimeoutMs: 60_000,
      },
      env: { XDG_CONFIG_HOME: path.join(root, 'no-such-config') },
      spawnProcess,
    });
    try {
      const service = new LspNavigationService({
        projectRoot: root,
        sanitizer: await PathSanitizer.create(root),
        symbols: unusedSymbols(),
        isExcluded: () => false,
        acquireProvider: (input) => manager.acquire(input),
      });
      const response = await service.navigate({ kind: 'definition', args: fileArgs('src/a.ts', 1, 16) });
      expect(response).toMatchObject({ status: 'unavailable', capability: 'unavailable', locations: [] });
      expect(['LSP_TRUST_REQUIRED', 'LSP_EXECUTABLE_NOT_APPROVED']).toContain(response.reasonCode);
      expect(spawnProcess).not.toHaveBeenCalled();
    } finally {
      await manager.close();
    }
  });

  it('fails closed on a stale symbolId before acquiring the provider', async () => {
    const symbols = symbolsReturning(() => ({
      status: 'stale_identity',
      reasonCode: 'SYMBOL_RETIRED',
      reindexRequired: true,
    }));
    const { service, acquire } = await createHarness({ symbols });
    await expect(service.navigate({ kind: 'references', args: { symbolId: SYMBOL_ID } })).resolves.toEqual({
      status: 'stale_identity',
      capability: 'not_checked',
      locations: [],
      truncated: false,
      sourceValidation: 'unknown',
      reasonCode: 'SYMBOL_RETIRED',
      reindexRequired: true,
    });
    expect(acquire).not.toHaveBeenCalled();
  });

  it('navigates a verified symbolId from its in-lock source position', async () => {
    const symbols = symbolsReturning(() => okSymbol('src/a.ts', A_TEXT));
    const { service, provider, root } = await createHarness({ symbols });
    const response = await service.navigate({ kind: 'references', args: { symbolId: SYMBOL_ID } });
    expect(response).toMatchObject({ status: 'ok', sourceValidation: 'verified' });
    expect(navigationsOf(provider)).toEqual([
      { op: 'navigate', uri: uriOf(root, 'src/a.ts'), kind: 'references', position: { line: 0, character: 16 } },
    ]);
  });

  it('fails closed when an unexpected symbol-service error occurs during the final recheck', async () => {
    const symbols = symbolsReturning((_input, call) => {
      if (call >= 3) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return okSymbol('src/a.ts', A_TEXT);
    });
    const { service } = await createHarness({ symbols });
    const response = await service.navigate({ kind: 'definition', args: { symbolId: SYMBOL_ID } });
    expect(response).toMatchObject({ status: 'error', reasonCode: 'INVARIANT_VIOLATION', locations: [] });
    expect(response.sourceValidation).not.toBe('verified');
  });

  it('returns stale when the symbol generation changes during navigation', async () => {
    const symbols = symbolsReturning((_input, call) => okSymbol('src/a.ts', A_TEXT, call >= 3 ? 'gen-2' : 'gen-1'));
    const { service } = await createHarness({ symbols });
    const response = await service.navigate({ kind: 'definition', args: { symbolId: SYMBOL_ID } });
    expect(response).toMatchObject({
      status: 'stale',
      reasonCode: 'INDEX_FILE_HASH_MISMATCH',
      locations: [],
      sourceValidation: 'unknown',
    });
  });

  it('truncates references to maxResults and reports truncated', async () => {
    const { service, provider, root } = await createHarness();
    provider.navigateImpl = () =>
      Promise.resolve([
        location(root, 'src/a.ts', 0, 16, 21),
        location(root, 'src/b.ts', 0, 9, 14),
        location(root, 'src/b.ts', 1, 20, 25),
      ]);
    const response = await service.navigate({ kind: 'references', args: { ...fileArgs('src/a.ts', 1, 16), maxResults: 2 } });
    expect(response.status).toBe('ok');
    expect(response.truncated).toBe(true);
    expect(response.locations.map((l) => l.filePath)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('rejects LocationLink shapes for references as a protocol error', async () => {
    const { service, provider, root } = await createHarness();
    const range = { start: { line: 0, character: 16 }, end: { line: 0, character: 21 } };
    provider.navigateImpl = () =>
      Promise.resolve([{ targetUri: uriOf(root, 'src/a.ts'), targetRange: range, targetSelectionRange: range }]);
    const response = await service.navigate({ kind: 'references', args: fileArgs('src/a.ts', 1, 16) });
    expect(response).toMatchObject({ status: 'error', reasonCode: 'LSP_PROTOCOL_ERROR', locations: [] });
  });

  it('reports out-of-root locations as partial with excludedResultCount', async () => {
    const { service, provider, root } = await createHarness();
    provider.navigateImpl = () =>
      Promise.resolve([location(root, 'src/a.ts', 0, 16, 21), { uri: 'file:///etc/hosts', range: location(root, 'x', 0, 0, 1).range }]);
    const response = await service.navigate({ kind: 'definition', args: fileArgs('src/a.ts', 1, 16) });
    expect(response).toMatchObject({ status: 'ok', sourceValidation: 'partial', excludedResultCount: 1 });
  });

  it('never navigates after a sync failure', async () => {
    const { service, provider } = await createHarness();
    provider.syncImpl = () => Promise.reject(new LspProtocolError());
    const response = await service.navigate({ kind: 'definition', args: fileArgs('src/a.ts', 1, 16) });
    expect(response).toMatchObject({ status: 'error', reasonCode: 'LSP_PROTOCOL_ERROR', locations: [] });
    expect(navigationsOf(provider)).toEqual([]);
  });

  it('maps an unsupported synchronization failure to unavailable/LSP_SYNC_UNSUPPORTED', async () => {
    const { service, provider } = await createHarness();
    provider.syncImpl = () => Promise.reject(new LspSyncUnsupportedError());
    const response = await service.navigate({ kind: 'definition', args: fileArgs('src/a.ts', 1, 16) });
    expect(response).toMatchObject({ status: 'unavailable', reasonCode: 'LSP_SYNC_UNSUPPORTED' });
    expect(navigationsOf(provider)).toEqual([]);
  });

  it.each<[string, unknown, string, string]>([
    ['typed timeout', new LspRequestTimeoutError(), 'timeout', 'LSP_REQUEST_TIMEOUT'],
    ['undefined lease failure', undefined, 'error', 'LSP_PROTOCOL_ERROR'],
    ['unknown error', new TypeError('boom'), 'error', 'LSP_PROTOCOL_ERROR'],
  ])('maps a navigate %s fail-closed', async (_label, error, status, reasonCode) => {
    const { service, provider } = await createHarness();
    provider.navigateImpl = () => Promise.reject(error);
    const response = await service.navigate({ kind: 'definition', args: fileArgs('src/a.ts', 1, 16) });
    expect(response).toMatchObject({ status, reasonCode, locations: [], sourceValidation: 'unknown' });
  });

  it('returns cancelled when the request is aborted during navigation', async () => {
    const { service, provider } = await createHarness();
    const controller = new AbortController();
    provider.navigateImpl = (input) => {
      controller.abort();
      expect(input.signal).toBeDefined();
      return Promise.resolve(null);
    };
    const response = await service.navigate({
      kind: 'definition',
      args: fileArgs('src/a.ts', 1, 16),
      signal: controller.signal,
    });
    expect(response).toMatchObject({ status: 'cancelled', reasonCode: 'REQUEST_CANCELLED', locations: [] });
  });
});

describe('LspNavigationService cross-file freshness (runtime navigation gate)', () => {
  it('refreshes open documents in locale-aware URI order', async () => {
    const { service, provider, root } = await createHarness();
    const uppercasePath = 'src/A.ts';
    const lowercasePath = 'src/a.ts';
    await write(root, uppercasePath, 'export const upper = 1;\n');
    await provider.syncDocument({ uri: uriOf(root, lowercasePath), languageId: 'typescript', text: A_TEXT });
    await provider.syncDocument({ uri: uriOf(root, uppercasePath), languageId: 'typescript', text: 'export const upper = 1;\n' });
    provider.events.length = 0;

    await service.navigate({ kind: 'definition', args: fileArgs('src/b.ts', 2, 21) });

    expect(provider.events.filter((event) => event.op === 'sync').map((event) => event.uri)).toEqual([
      uriOf(root, lowercasePath),
      uriOf(root, uppercasePath),
      uriOf(root, 'src/b.ts'),
    ]);
  });

  it('re-syncs a changed open document A before navigating from B', async () => {
    const { service, provider, root } = await createHarness();
    await service.navigate({ kind: 'definition', args: fileArgs('src/a.ts', 1, 16) });
    const changedA = 'export function alpha(): number {\n  return 2;\n}\n';
    await write(root, 'src/a.ts', changedA);
    provider.events.length = 0;
    provider.navigateImpl = () => Promise.resolve([location(root, 'src/a.ts', 0, 16, 21)]);

    const response = await service.navigate({ kind: 'definition', args: fileArgs('src/b.ts', 2, 21) });

    expect(response).toMatchObject({ status: 'ok', sourceValidation: 'verified' });
    expect(provider.events.map((e) => [e.op, e.uri])).toEqual([
      ['sync', uriOf(root, 'src/a.ts')],
      ['sync', uriOf(root, 'src/b.ts')],
      ['navigate', uriOf(root, 'src/b.ts')],
    ]);
    expect(provider.events[0]).toMatchObject({ text: changedA, languageId: 'typescript' });
  });

  it.each<[string, (root: string) => Promise<void>, string]>([
    ['deleted', (root) => fs.rm(path.join(root, 'src/a.ts')), 'INDEX_FILE_MISSING'],
    ['replaced by an escaping symlink', async (root) => {
      await fs.rm(path.join(root, 'src/a.ts'));
      await fs.symlink('/etc/hosts', path.join(root, 'src/a.ts'));
    }, 'INDEX_FILE_HASH_MISMATCH'],
  ])('aborts navigation when open document A was %s, closing it first', async (_label, mutate, reasonCode) => {
    const { service, provider, root } = await createHarness();
    await service.navigate({ kind: 'definition', args: fileArgs('src/a.ts', 1, 16) });
    await mutate(root);
    provider.events.length = 0;

    const response = await service.navigate({ kind: 'definition', args: fileArgs('src/b.ts', 2, 21) });

    expect(response).toMatchObject({ status: 'stale', reasonCode, locations: [] });
    expect(response.sourceValidation).not.toBe('verified');
    expect(provider.events).toEqual([{ op: 'close', uri: uriOf(root, 'src/a.ts') }]);
  });

  it('aborts navigation when open document A became excluded', async () => {
    let excludeA = false;
    const { service, provider, root } = await createHarness({ isExcluded: (p) => excludeA && p === 'src/a.ts' });
    await service.navigate({ kind: 'definition', args: fileArgs('src/a.ts', 1, 16) });
    excludeA = true;
    provider.events.length = 0;
    const response = await service.navigate({ kind: 'definition', args: fileArgs('src/b.ts', 2, 21) });
    expect(response.status).toBe('stale');
    expect(navigationsOf(provider)).toEqual([]);
    expect(provider.events).toEqual([{ op: 'close', uri: uriOf(root, 'src/a.ts') }]);
  });

  it('maps a failed close of an unsafe open document to LSP_PROTOCOL_ERROR', async () => {
    const { service, provider, root } = await createHarness();
    await service.navigate({ kind: 'definition', args: fileArgs('src/a.ts', 1, 16) });
    await fs.rm(path.join(root, 'src/a.ts'));
    provider.closeImpl = () => Promise.reject(new LspProtocolError());
    const response = await service.navigate({ kind: 'definition', args: fileArgs('src/b.ts', 2, 21) });
    expect(response).toMatchObject({ status: 'error', reasonCode: 'LSP_PROTOCOL_ERROR' });
    expect(navigationsOf(provider)).toHaveLength(1);
  });

  it('returns stale when open document A changes on disk during B navigation', async () => {
    const { service, provider, root } = await createHarness();
    await service.navigate({ kind: 'definition', args: fileArgs('src/a.ts', 1, 16) });
    provider.navigateImpl = async () => {
      await write(root, 'src/a.ts', 'export function alpha(): string {\n  return "x";\n}\n');
      return [location(root, 'src/a.ts', 0, 16, 21)];
    };
    const response = await service.navigate({ kind: 'definition', args: fileArgs('src/b.ts', 2, 21) });
    expect(response).toMatchObject({
      status: 'stale',
      reasonCode: 'INDEX_FILE_HASH_MISMATCH',
      locations: [],
      sourceValidation: 'unknown',
    });
  });

  it('returns stale when the target changes on disk during navigation', async () => {
    const { service, provider, root } = await createHarness();
    provider.navigateImpl = async () => {
      await write(root, 'src/b.ts', `${B_TEXT}// edited\n`);
      return [location(root, 'src/a.ts', 0, 16, 21)];
    };
    const response = await service.navigate({ kind: 'definition', args: fileArgs('src/b.ts', 2, 21) });
    expect(response).toMatchObject({ status: 'stale', reasonCode: 'INDEX_FILE_HASH_MISMATCH', locations: [] });
  });

  it('serializes same-runtime cross-URI requests through one gate', async () => {
    const { service, provider } = await createHarness();
    const release = deferred();
    let first = true;
    provider.navigateImpl = async () => {
      if (first) {
        first = false;
        await release.promise;
      }
      return null;
    };
    const a = service.navigate({ kind: 'definition', args: fileArgs('src/a.ts', 1, 16) });
    await tick();
    const b = service.navigate({ kind: 'definition', args: fileArgs('src/b.ts', 2, 21) });
    await tick();
    // B has not touched the provider while A holds the gate.
    expect(provider.events.map((e) => e.op)).toEqual(['sync', 'navigate']);
    release.resolve();
    await expect(Promise.all([a, b])).resolves.toMatchObject([{ status: 'ok' }, { status: 'ok' }]);
    expect(provider.maxActive).toBe(1);
  });

  it('keeps independent worktrees concurrent', async () => {
    const one = await createHarness();
    const two = await createHarness();
    const bothStarted = deferred();
    let started = 0;
    const gate = deferred();
    const impl = async () => {
      started += 1;
      if (started === 2) bothStarted.resolve();
      await gate.promise;
      return null;
    };
    one.provider.navigateImpl = impl;
    two.provider.navigateImpl = impl;
    const a = one.service.navigate({ kind: 'definition', args: fileArgs('src/a.ts', 1, 16) });
    const b = two.service.navigate({ kind: 'definition', args: fileArgs('src/a.ts', 1, 16) });
    await bothStarted.promise;
    gate.resolve();
    await expect(Promise.all([a, b])).resolves.toMatchObject([{ status: 'ok' }, { status: 'ok' }]);
  });
});

describe('LspNavigationService same-URI request lock', () => {
  it('rereads on acquiring the lock instead of syncing a pre-lock stale snapshot', async () => {
    const { service, provider, root } = await createHarness();
    const holdGate = deferred();
    provider.navigateImpl = async (input) => {
      if (input.uri === uriOf(root, 'src/b.ts')) await holdGate.promise;
      return null;
    };
    // X holds the runtime gate on another URI.
    const x = service.navigate({ kind: 'definition', args: fileArgs('src/b.ts', 2, 21) });
    await tick();
    // A captures its pre-lock view of v1 and waits.
    const a = service.navigate({ kind: 'definition', args: fileArgs('src/a.ts', 1, 16) });
    await tick();
    const v2 = 'export function alpha(): number {\n  return 22;\n}\n';
    await write(root, 'src/a.ts', v2);
    // B (same URI) starts after the change and sees v2.
    const b = service.navigate({ kind: 'definition', args: fileArgs('src/a.ts', 1, 16) });
    await tick();
    holdGate.resolve();
    const [, ra, rb] = await Promise.all([x, a, b]);
    expect(ra).toMatchObject({ status: 'ok', sourceValidation: 'verified' });
    expect(rb).toMatchObject({ status: 'ok', sourceValidation: 'verified' });
    const aSyncs = provider.syncInputs.filter((s) => s.uri === uriOf(root, 'src/a.ts'));
    expect(aSyncs.length).toBeGreaterThan(0);
    expect(aSyncs.every((s) => s.text === v2)).toBe(true);
    // No caller-supplied kind/version reaches the provider.
    for (const input of provider.syncInputs) expect(Object.keys(input).sort()).toEqual(['languageId', 'text', 'uri']);
  });

  it('runs same-URI requests in FIFO order', async () => {
    const { service, provider } = await createHarness();
    const release = deferred();
    const order: number[] = [];
    let calls = 0;
    provider.navigateImpl = async (input) => {
      calls += 1;
      if (calls === 1) await release.promise;
      order.push(input.position.character);
      return null;
    };
    const requests = [16, 17, 18].map((character) =>
      service.navigate({ kind: 'definition', args: fileArgs('src/a.ts', 1, character) }),
    );
    await tick();
    release.resolve();
    await Promise.all(requests);
    expect(order).toEqual([16, 17, 18]);
  });

  it('releases the locks after a navigation error', async () => {
    const { service, provider } = await createHarness();
    provider.navigateImpl = () => Promise.reject(new LspProtocolError());
    await expect(service.navigate({ kind: 'definition', args: fileArgs('src/a.ts', 1, 16) })).resolves.toMatchObject({
      status: 'error',
    });
    provider.navigateImpl = () => Promise.resolve(null);
    await expect(service.navigate({ kind: 'definition', args: fileArgs('src/a.ts', 1, 16) })).resolves.toMatchObject({
      status: 'ok',
    });
  });

  it('cancels a waiting request without any LSP call and keeps the queue moving', async () => {
    const { service, provider, acquire } = await createHarness();
    const release = deferred();
    let first = true;
    provider.navigateImpl = async () => {
      if (first) {
        first = false;
        await release.promise;
      }
      return null;
    };
    const holder = service.navigate({ kind: 'definition', args: fileArgs('src/a.ts', 1, 16) });
    await tick();
    const controller = new AbortController();
    const waiter = service.navigate({
      kind: 'definition',
      args: fileArgs('src/a.ts', 1, 17),
      signal: controller.signal,
    });
    const next = service.navigate({ kind: 'definition', args: fileArgs('src/b.ts', 2, 21) });
    await tick();
    controller.abort();
    await expect(waiter).resolves.toMatchObject({ status: 'cancelled', reasonCode: 'REQUEST_CANCELLED' });
    expect(acquire).toHaveBeenCalledTimes(1);
    release.resolve();
    await expect(holder).resolves.toMatchObject({ status: 'ok' });
    await expect(next).resolves.toMatchObject({ status: 'ok' });
    expect(navigationsOf(provider).map((e) => e.position.character)).toEqual([16, 21]);
  });

  it('times out a bounded lock wait without any LSP call, then recovers', async () => {
    const { service, provider, acquire } = await createHarness({ lockTimeoutMs: 20 });
    const release = deferred();
    let first = true;
    provider.navigateImpl = async () => {
      if (first) {
        first = false;
        await release.promise;
      }
      return null;
    };
    const holder = service.navigate({ kind: 'definition', args: fileArgs('src/a.ts', 1, 16) });
    await tick();
    const waiter = await service.navigate({ kind: 'definition', args: fileArgs('src/a.ts', 1, 17) });
    expect(waiter).toMatchObject({ status: 'timeout', reasonCode: 'LSP_REQUEST_TIMEOUT', locations: [] });
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(navigationsOf(provider)).toHaveLength(1);
    release.resolve();
    await holder;
    await expect(service.navigate({ kind: 'definition', args: fileArgs('src/a.ts', 1, 16) })).resolves.toMatchObject({
      status: 'ok',
    });
  });

  it('does not resend unchanged text as a duplicate open on repeated same-URI navigation', async () => {
    const { service, provider, root } = await createHarness();
    await service.navigate({ kind: 'definition', args: fileArgs('src/a.ts', 1, 16) });
    await service.navigate({ kind: 'references', args: fileArgs('src/a.ts', 1, 16) });
    // Every sync carries identical text, so the Protocol Client suppresses notifications.
    const aSyncs = provider.syncInputs.filter((s) => s.uri === uriOf(root, 'src/a.ts'));
    expect(new Set(aSyncs.map((s) => s.text))).toEqual(new Set([A_TEXT]));
    expect(provider.open.size).toBe(1);
  });
});
