import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as ProtocolNode from 'vscode-languageserver-protocol/node';
import type { InitializeParams } from 'vscode-languageserver-protocol/node';

import type { ILspProvider, LspDocumentLanguageId } from '../../../src/lsp/contracts.js';
import {
  createLspProtocolClient,
  LspCapabilityUnsupportedError,
  LspProtocolError,
  LspRequestCancelledError,
  LspRequestTimeoutError,
  LspServerVersionMismatchError,
  LspSyncUnsupportedError,
} from '../../../src/lsp/protocol-client.js';
import { lspDocumentLanguageIdForPath } from '../../../src/lsp/target-resolver.js';

// Count every Connection / reader / writer / listen() created through the protocol Node exports.
// The stub server uses its own independent framing, so all counts belong to the Protocol Client.
const transportCounters = vi.hoisted(() => ({ connections: 0, listens: 0, readers: 0, writers: 0 }));

vi.mock('vscode-languageserver-protocol/node', async (importOriginal) => {
  const actual = await importOriginal<typeof ProtocolNode>();
  class CountingReader extends actual.StreamMessageReader {
    constructor(...args: ConstructorParameters<typeof actual.StreamMessageReader>) {
      super(...args);
      transportCounters.readers += 1;
    }
  }
  class CountingWriter extends actual.StreamMessageWriter {
    constructor(...args: ConstructorParameters<typeof actual.StreamMessageWriter>) {
      super(...args);
      transportCounters.writers += 1;
    }
  }
  const createMessageConnection = ((...args: Parameters<typeof actual.createMessageConnection>) => {
    transportCounters.connections += 1;
    const connection = actual.createMessageConnection(...args);
    const listen = connection.listen.bind(connection);
    connection.listen = () => {
      transportCounters.listens += 1;
      listen();
    };
    return connection;
  }) as typeof actual.createMessageConnection;
  return {
    ...actual,
    StreamMessageReader: CountingReader,
    StreamMessageWriter: CountingWriter,
    createMessageConnection,
  };
});

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface StubServer {
  received: JsonRpcMessage[];
  messages(method: string): JsonRpcMessage[];
  waitFor(predicate: (message: JsonRpcMessage) => boolean): Promise<JsonRpcMessage>;
  request(method: string, params?: unknown): Promise<JsonRpcMessage>;
  notify(method: string, params?: unknown): void;
  close(): void;
}

interface StubConfig {
  initializeResult?: unknown;
  handlers?: Record<string, (params: unknown, message: JsonRpcMessage) => unknown>;
}

interface StubModule {
  startStubLanguageServer(input: {
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
    config?: StubConfig;
  }): StubServer;
  DEFAULT_INITIALIZE_RESULT: { capabilities: Record<string, unknown>; serverInfo: { name: string; version: string } };
}

let stubModule: StubModule;

beforeAll(async () => {
  const stubUrl = new URL('../../fixtures/lsp/stub-language-server.mjs', import.meta.url).href;
  stubModule = (await import(stubUrl)) as StubModule;
});

const tempDirs: string[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const dir of tempDirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

const ROOT_URI = 'file:///workspace/project';
const fileUri = (name: string): string => `${ROOT_URI}/${name}`;

interface Harness {
  client: ILspProvider;
  stub: StubServer;
  clientToServer: PassThrough;
  serverToClient: PassThrough;
}

const createHarness = (
  config: StubConfig = {},
  options: { rootUri?: string; requestTimeoutMs?: number; stdin?: NodeJS.WritableStream } = {},
): Harness => {
  const clientToServer = new PassThrough();
  const serverToClient = new PassThrough();
  const stub = stubModule.startStubLanguageServer({ input: clientToServer, output: serverToClient, config });
  const client = createLspProtocolClient({
    stdin: options.stdin ?? clientToServer,
    stdout: serverToClient,
    rootUri: options.rootUri ?? ROOT_URI,
    ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }),
  });
  cleanups.push(async () => {
    await client.shutdown();
    stub.close();
    clientToServer.end();
    serverToClient.end();
  });
  return { client, stub, clientToServer, serverToClient };
};

const startHarness = async (config: StubConfig = {}, options: Parameters<typeof createHarness>[1] = {}) => {
  const harness = createHarness(config, options);
  const capabilities = await harness.client.start({ rootUri: options.rootUri ?? ROOT_URI, expectedServerVersion: '6.0.2' });
  return { ...harness, capabilities };
};

const initializeResultWith = (overrides: Record<string, unknown>, serverInfo?: unknown): unknown => ({
  capabilities: { ...stubModule.DEFAULT_INITIALIZE_RESULT.capabilities, ...overrides },
  ...(serverInfo === undefined ? { serverInfo: stubModule.DEFAULT_INITIALIZE_RESULT.serverInfo } : { serverInfo }),
});

const methodsOf = (stub: StubServer): string[] =>
  stub.received.map((message) => message.method ?? '<response>');

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

const location = (name: string, line = 0) => ({
  uri: fileUri(name),
  range: { start: { line, character: 0 }, end: { line, character: 3 } },
});

describe('createLspProtocolClient: initialize handshake (§7.2)', () => {
  it('sends initialize with the root folder before initialized and returns UTF-16 capabilities', async () => {
    const { stub, capabilities } = await startHarness();
    await stub.waitFor((message) => message.method === 'initialized');

    expect(methodsOf(stub).slice(0, 2)).toEqual(['initialize', 'initialized']);
    const params = stub.messages('initialize')[0]?.params as InitializeParams;
    expect(params.rootUri).toBe(ROOT_URI);
    expect(params.workspaceFolders).toEqual([{ uri: ROOT_URI, name: 'project' }]);
    expect(params.capabilities.general?.positionEncodings).toEqual(['utf-16']);
    expect(params.capabilities.workspace?.configuration).toBe(true);
    expect(params.capabilities.textDocument?.definition?.dynamicRegistration).toBe(false);
    expect(params.capabilities.textDocument?.references?.dynamicRegistration).toBe(false);
    expect(params.capabilities.textDocument?.implementation?.dynamicRegistration).toBe(false);
    expect(params.capabilities.textDocument?.synchronization?.dynamicRegistration).toBe(false);
    expect(capabilities).toEqual({
      definition: true,
      references: true,
      implementations: true,
      positionEncoding: 'utf-16',
    });
  });

  it('always sends disableAutomaticTypingAcquisition:true without npmLocation or config override (PR #345)', async () => {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();
    const stub = stubModule.startStubLanguageServer({ input: clientToServer, output: serverToClient });
    const client = createLspProtocolClient({
      stdin: clientToServer,
      stdout: serverToClient,
      rootUri: ROOT_URI,
      // Attempted overrides must be ignored: the ATA setting is a fixed security default.
      initializationOptions: { disableAutomaticTypingAcquisition: false, npmLocation: '/tmp/npm' },
      npmLocation: '/tmp/npm',
    } as unknown as Parameters<typeof createLspProtocolClient>[0]);
    cleanups.push(async () => {
      await client.shutdown();
      stub.close();
    });
    await client.start({ rootUri: ROOT_URI, expectedServerVersion: '6.0.2' });

    const initialize = stub.messages('initialize')[0];
    const params = initialize?.params as Record<string, unknown>;
    expect(params.initializationOptions).toEqual({ disableAutomaticTypingAcquisition: true });
    expect(JSON.stringify(initialize)).not.toContain('npmLocation');
  });

  it('accepts a matching serverInfo.version 6.0.2', async () => {
    const { capabilities } = await startHarness({
      initializeResult: initializeResultWith({}, { name: 'typescript-language-server', version: '6.0.2' }),
    });
    expect(capabilities.definition).toBe(true);
  });

  it('rejects an explicitly mismatching serverInfo.version before navigation without reflecting it', async () => {
    const harness = createHarness({
      initializeResult: initializeResultWith({}, { name: 'typescript-language-server', version: '6.0.1' }),
    });
    const error = await harness.client
      .start({ rootUri: ROOT_URI, expectedServerVersion: '6.0.2' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LspServerVersionMismatchError);
    expect((error as LspServerVersionMismatchError).reasonCode).toBe('LSP_EXECUTABLE_NOT_APPROVED');
    expect((error as Error).message).not.toContain('6.0.1');
    expect(error).not.toBeInstanceOf(LspProtocolError);

    await expect(
      harness.client.navigate({ kind: 'definition', uri: fileUri('a.ts'), position: { line: 0, character: 0 } }),
    ).rejects.toThrow();
    await settle();
    expect(harness.stub.messages('initialized')).toHaveLength(0);
    expect(harness.stub.messages('textDocument/definition')).toHaveLength(0);
  });

  it.each([[602], [null], [{ major: 6 }]])('treats a malformed reported version %j as a mismatch', async (version) => {
    const harness = createHarness({ initializeResult: initializeResultWith({}, { name: 'tls', version }) });
    await expect(harness.client.start({ rootUri: ROOT_URI, expectedServerVersion: '6.0.2' })).rejects.toBeInstanceOf(
      LspServerVersionMismatchError,
    );
  });

  it.each([
    ['serverInfo without version', { name: 'typescript-language-server' }],
    ['omitted serverInfo', null],
  ])('accepts %s without version attestation', async (_label, serverInfo) => {
    const initializeResult =
      serverInfo === null
        ? { capabilities: stubModule.DEFAULT_INITIALIZE_RESULT.capabilities }
        : initializeResultWith({}, serverInfo);
    const { capabilities, stub } = await startHarness({ initializeResult });
    expect(capabilities.positionEncoding).toBe('utf-16');
    await stub.waitFor((message) => message.method === 'initialized');
  });

  it('maps other malformed initialize replies to LSP_PROTOCOL_ERROR', async () => {
    const harness = createHarness({ initializeResult: { serverInfo: { version: '6.0.2' } } });
    const error = await harness.client
      .start({ rootUri: ROOT_URI, expectedServerVersion: '6.0.2' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LspProtocolError);
    expect((error as LspProtocolError).reasonCode).toBe('LSP_PROTOCOL_ERROR');
  });

  it('rejects a non-UTF-16 negotiated position encoding', async () => {
    const harness = createHarness({ initializeResult: initializeResultWith({ positionEncoding: 'utf-8' }) });
    await expect(harness.client.start({ rootUri: ROOT_URI, expectedServerVersion: '6.0.2' })).rejects.toBeInstanceOf(
      LspProtocolError,
    );
  });

  it('reports unsupported navigation capabilities separately and refuses those requests', async () => {
    const { client, stub, capabilities } = await startHarness({
      initializeResult: initializeResultWith({
        definitionProvider: false,
        referencesProvider: {},
        implementationProvider: undefined,
      }),
    });
    expect(capabilities).toEqual({
      definition: false,
      references: true,
      implementations: false,
      positionEncoding: 'utf-16',
    });
    await client.syncDocument({ uri: fileUri('a.ts'), languageId: 'typescript', text: 'x' });
    const error = await client
      .navigate({ kind: 'definition', uri: fileUri('a.ts'), position: { line: 0, character: 0 } })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LspCapabilityUnsupportedError);
    expect((error as LspCapabilityUnsupportedError).reasonCode).toBe('LSP_CAPABILITY_UNSUPPORTED');
    await expect(
      client.navigate({ kind: 'implementations', uri: fileUri('a.ts'), position: { line: 0, character: 0 } }),
    ).rejects.toBeInstanceOf(LspCapabilityUnsupportedError);
    await settle();
    expect(stub.messages('textDocument/definition')).toHaveLength(0);
    expect(stub.messages('textDocument/implementation')).toHaveLength(0);
  });

  it('owns exactly one Connection, reader, writer and listen() per child (F-007)', async () => {
    const before = { ...transportCounters };
    const { client } = await startHarness();
    expect(transportCounters.connections - before.connections).toBe(1);
    expect(transportCounters.readers - before.readers).toBe(1);
    expect(transportCounters.writers - before.writers).toBe(1);
    expect(transportCounters.listens - before.listens).toBe(1);

    await expect(client.start({ rootUri: ROOT_URI, expectedServerVersion: '6.0.2' })).rejects.toThrow();
    expect(transportCounters.connections - before.connections).toBe(1);
    expect(transportCounters.listens - before.listens).toBe(1);
  });
});

describe('createLspProtocolClient: synchronization capability (§6.3)', () => {
  it.each([
    ['missing', undefined],
    ['None (0)', 0],
    ['unknown numeric kind', 3],
    ['options with openClose:false', { openClose: false, change: 2 }],
    ['options with omitted openClose', { change: 2 }],
    ['options with change None', { openClose: true, change: 0 }],
    ['options with omitted change', { openClose: true }],
  ])('throws LspSyncUnsupportedError for %s before any semantic request', async (_label, textDocumentSync) => {
    const harness = createHarness({ initializeResult: initializeResultWith({ textDocumentSync }) });
    const error = await harness.client
      .start({ rootUri: ROOT_URI, expectedServerVersion: '6.0.2' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LspSyncUnsupportedError);
    expect((error as LspSyncUnsupportedError).reasonCode).toBe('LSP_SYNC_UNSUPPORTED');

    await expect(
      harness.client.syncDocument({ uri: fileUri('a.ts'), languageId: 'typescript', text: 'x' }),
    ).rejects.toThrow();
    await expect(
      harness.client.navigate({ kind: 'definition', uri: fileUri('a.ts'), position: { line: 0, character: 0 } }),
    ).rejects.toThrow();
    await settle();
    expect(harness.stub.messages('textDocument/didOpen')).toHaveLength(0);
    expect(harness.stub.messages('textDocument/definition')).toHaveLength(0);
  });
});

describe('createLspProtocolClient: document synchronization (F-006)', () => {
  it('opens at version 1, suppresses identical repeats and changes at versions 2 then 3', async () => {
    const { client, stub } = await startHarness();
    const uri = fileUri('a.ts');
    await client.syncDocument({ uri, languageId: 'typescript', text: 'one' });
    await client.syncDocument({ uri, languageId: 'typescript', text: 'one' });
    await client.syncDocument({ uri, languageId: 'typescript', text: 'two' });
    await client.syncDocument({ uri, languageId: 'typescript', text: 'two' });
    await client.syncDocument({ uri, languageId: 'typescript', text: 'three' });
    await stub.waitFor(
      (message) =>
        message.method === 'textDocument/didChange' &&
        (message.params as { textDocument: { version: number } }).textDocument.version === 3,
    );

    expect(stub.messages('textDocument/didOpen').map((message) => message.params)).toEqual([
      { textDocument: { uri, languageId: 'typescript', version: 1, text: 'one' } },
    ]);
    expect(
      stub
        .messages('textDocument/didChange')
        .map((message) => (message.params as { textDocument: { version: number } }).textDocument.version),
    ).toEqual([2, 3]);
  });

  it('ignores caller-supplied kind/version fields', async () => {
    const { client, stub } = await startHarness();
    const uri = fileUri('a.ts');
    await client.syncDocument({ uri, languageId: 'typescript', text: 'x', kind: 'change', version: 99 } as never);
    const open = await stub.waitFor((message) => message.method === 'textDocument/didOpen');
    expect((open.params as { textDocument: { version: number } }).textDocument.version).toBe(1);
  });

  it.each([
    ['a.ts', 'typescript'],
    ['b.tsx', 'typescriptreact'],
    ['c.js', 'javascript'],
    ['d.jsx', 'javascriptreact'],
  ])('opens %s with the extension-derived LSP document ID %s', async (name, expected) => {
    const { client, stub } = await startHarness();
    const languageId = lspDocumentLanguageIdForPath(name) as LspDocumentLanguageId;
    expect(languageId).toBe(expected);
    await client.syncDocument({ uri: fileUri(name), languageId, text: '' });
    const open = await stub.waitFor((message) => message.method === 'textDocument/didOpen');
    expect((open.params as { textDocument: { languageId: string } }).textDocument.languageId).toBe(expected);
  });

  it('refuses a language ID contradiction for an open URI and blocks navigation until resynchronized', async () => {
    const { client, stub } = await startHarness();
    const uri = fileUri('a.ts');
    await client.syncDocument({ uri, languageId: 'typescript', text: 'x' });
    await expect(client.syncDocument({ uri, languageId: 'javascript', text: 'x' })).rejects.toThrow();
    await expect(
      client.navigate({ kind: 'definition', uri, position: { line: 0, character: 0 } }),
    ).rejects.toBeInstanceOf(LspProtocolError);
    await settle();
    expect(stub.messages('textDocument/didOpen')).toHaveLength(1);
    expect(stub.messages('textDocument/definition')).toHaveLength(0);
  });

  it.each([
    ['numeric Full (1)', 1],
    ['options-based Full', { openClose: true, change: 1 }],
  ])('%s sends the whole new text without a range', async (_label, textDocumentSync) => {
    const { client, stub } = await startHarness({ initializeResult: initializeResultWith({ textDocumentSync }) });
    const uri = fileUri('a.ts');
    await client.syncDocument({ uri, languageId: 'typescript', text: 'old\r\ntext' });
    await client.syncDocument({ uri, languageId: 'typescript', text: 'new' });
    const change = await stub.waitFor((message) => message.method === 'textDocument/didChange');
    expect(change.params).toEqual({ textDocument: { uri, version: 2 }, contentChanges: [{ text: 'new' }] });
  });

  it.each([
    ['numeric Incremental (2)', 2, 'abc\ndef', { line: 1, character: 3 }],
    ['options-based Incremental', { openClose: true, change: 2 }, 'abc\ndef', { line: 1, character: 3 }],
    ['CRLF line breaks', 2, 'one\r\ntwo\r\nlast', { line: 2, character: 4 }],
    ['trailing CRLF', 2, 'one\r\n', { line: 1, character: 0 }],
    ['lone CR line break', 2, 'a\rbc', { line: 1, character: 2 }],
    ['non-BMP code points', 2, 'x\r\nb😀', { line: 1, character: 3 }],
    ['empty previous text', 2, '', { line: 0, character: 0 }],
  ])('%s replaces the previous document using its UTF-16 end', async (_label, textDocumentSync, previous, end) => {
    const { client, stub } = await startHarness({ initializeResult: initializeResultWith({ textDocumentSync }) });
    const uri = fileUri('a.ts');
    await client.syncDocument({ uri, languageId: 'typescript', text: previous });
    await client.syncDocument({ uri, languageId: 'typescript', text: 'replacement😀\r\n' });
    const change = await stub.waitFor((message) => message.method === 'textDocument/didChange');
    expect(change.params).toEqual({
      textDocument: { uri, version: 2 },
      contentChanges: [{ range: { start: { line: 0, character: 0 }, end }, text: 'replacement😀\r\n' }],
    });
  });

  it('computes the next Incremental range from the previously synchronized text', async () => {
    const { client, stub } = await startHarness();
    const uri = fileUri('a.ts');
    await client.syncDocument({ uri, languageId: 'typescript', text: 'a' });
    await client.syncDocument({ uri, languageId: 'typescript', text: 'line1\nline2' });
    await client.syncDocument({ uri, languageId: 'typescript', text: 'z' });
    await stub.waitFor(
      (message) =>
        message.method === 'textDocument/didChange' &&
        (message.params as { textDocument: { version: number } }).textDocument.version === 3,
    );
    const ranges = stub
      .messages('textDocument/didChange')
      .map((message) => (message.params as { contentChanges: { range: unknown }[] }).contentChanges[0]?.range);
    expect(ranges).toEqual([
      { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      { start: { line: 0, character: 0 }, end: { line: 1, character: 5 } },
    ]);
  });

  it('closes once, is idempotent, and reopens a new lifetime at version 1', async () => {
    const { client, stub } = await startHarness();
    const uri = fileUri('a.ts');
    await client.closeDocument({ uri });
    await client.syncDocument({ uri, languageId: 'typescript', text: 'one' });
    await client.syncDocument({ uri, languageId: 'typescript', text: 'two' });
    expect(client.listOpenDocumentUris()).toEqual([uri]);
    await client.closeDocument({ uri });
    await client.closeDocument({ uri });
    expect(client.listOpenDocumentUris()).toEqual([]);
    await client.syncDocument({ uri, languageId: 'typescript', text: 'two' });
    await stub.waitFor((message) => message.method === 'textDocument/didOpen' && stub.messages('textDocument/didOpen').length === 2);

    expect(stub.messages('textDocument/didClose').map((message) => message.params)).toEqual([{ textDocument: { uri } }]);
    expect(
      stub
        .messages('textDocument/didOpen')
        .map((message) => (message.params as { textDocument: { version: number } }).textDocument.version),
    ).toEqual([1, 1]);
  });

  it('exposes a read-only open-URI snapshot without text or version', async () => {
    const { client } = await startHarness();
    await client.syncDocument({ uri: fileUri('b.ts'), languageId: 'typescript', text: 'secret-b' });
    await client.syncDocument({ uri: fileUri('a.ts'), languageId: 'typescript', text: 'secret-a' });
    const snapshot = client.listOpenDocumentUris();

    expect(snapshot).toEqual([fileUri('a.ts'), fileUri('b.ts')]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('secret');
    expect(snapshot.every((entry) => typeof entry === 'string')).toBe(true);

    await client.closeDocument({ uri: fileUri('a.ts') });
    expect(snapshot).toEqual([fileUri('a.ts'), fileUri('b.ts')]);
    expect(client.listOpenDocumentUris()).toEqual([fileUri('b.ts')]);
  });

  it('starts a fresh map on a new Connection after process restart (didOpen at version 1)', async () => {
    const uri = fileUri('a.ts');
    const first = await startHarness();
    await first.client.syncDocument({ uri, languageId: 'typescript', text: 'one' });
    await first.client.syncDocument({ uri, languageId: 'typescript', text: 'two' });
    await first.client.shutdown();

    const second = await startHarness();
    expect(second.client.listOpenDocumentUris()).toEqual([]);
    await second.client.syncDocument({ uri, languageId: 'typescript', text: 'two' });
    const open = await second.stub.waitFor((message) => message.method === 'textDocument/didOpen');
    expect((open.params as { textDocument: { version: number } }).textDocument.version).toBe(1);
    expect(second.stub.messages('textDocument/didChange')).toHaveLength(0);
  });

  it('poisons the session after a local send failure and blocks navigation', async () => {
    const clientToServer = new PassThrough();
    let failWrites = false;
    const stdin = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        if (failWrites) {
          callback(new Error('simulated broken pipe'));
          return;
        }
        clientToServer.write(chunk, callback);
      },
    });
    stdin.on('error', () => undefined);
    const serverToClient = new PassThrough();
    const stub = stubModule.startStubLanguageServer({ input: clientToServer, output: serverToClient });
    const client = createLspProtocolClient({ stdin, stdout: serverToClient, rootUri: ROOT_URI });
    cleanups.push(async () => {
      await client.shutdown();
      stub.close();
    });
    await client.start({ rootUri: ROOT_URI, expectedServerVersion: '6.0.2' });
    const uri = fileUri('a.ts');
    await client.syncDocument({ uri, languageId: 'typescript', text: 'one' });

    failWrites = true;
    await expect(client.syncDocument({ uri, languageId: 'typescript', text: 'two' })).rejects.toThrow();
    failWrites = false;
    const error = await client
      .navigate({ kind: 'definition', uri, position: { line: 0, character: 0 } })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LspProtocolError);
    await expect(client.syncDocument({ uri: fileUri('b.ts'), languageId: 'typescript', text: 'b' })).rejects.toBeInstanceOf(
      LspProtocolError,
    );
    await settle();
    expect(stub.messages('textDocument/definition')).toHaveLength(0);
    expect(stub.messages('textDocument/didChange')).toHaveLength(0);
  });

  it('times out a stalled notification and poisons the session', async () => {
    const clientToServer = new PassThrough();
    let stallWrites = false;
    let releaseStalledWrite: (() => void) | undefined;
    const stdin = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        if (stallWrites) {
          releaseStalledWrite = () => clientToServer.write(chunk, callback);
          return;
        }
        clientToServer.write(chunk, callback);
      },
    });
    stdin.on('error', () => undefined);
    const serverToClient = new PassThrough();
    const stub = stubModule.startStubLanguageServer({ input: clientToServer, output: serverToClient });
    const client = createLspProtocolClient({ stdin, stdout: serverToClient, rootUri: ROOT_URI, requestTimeoutMs: 30 });
    cleanups.push(async () => {
      stallWrites = false;
      releaseStalledWrite?.();
      await client.shutdown();
      stub.close();
    });
    await client.start({ rootUri: ROOT_URI, expectedServerVersion: '6.0.2' });

    stallWrites = true;
    await expect(client.syncDocument({ uri: fileUri('a.ts'), languageId: 'typescript', text: 'x' })).rejects.toBeInstanceOf(
      LspProtocolError,
    );
    await expect(client.navigate({ kind: 'definition', uri: fileUri('a.ts'), position: { line: 0, character: 0 } })).rejects.toBeInstanceOf(
      LspProtocolError,
    );
  });
});

describe('createLspProtocolClient: per-URI FIFO and Task 7 coordination (F-006)', () => {
  it('orders simultaneous syncDocument/navigate/closeDocument operations per URI', async () => {
    const { client, stub } = await startHarness();
    const uri = fileUri('a.ts');
    const operations = [
      client.syncDocument({ uri, languageId: 'typescript', text: 'v1' }),
      client.syncDocument({ uri, languageId: 'typescript', text: 'v2' }),
      client.navigate({ kind: 'definition', uri, position: { line: 0, character: 1 } }),
      client.syncDocument({ uri, languageId: 'typescript', text: 'v3' }),
      client.closeDocument({ uri }),
    ];
    await Promise.all(operations);

    const relevant = stub.received
      .filter((message) => message.method?.startsWith('textDocument/'))
      .map((message) => {
        const params = message.params as { textDocument: { version?: number } };
        return `${message.method}@${params.textDocument.version ?? '-'}`;
      });
    expect(relevant).toEqual([
      'textDocument/didOpen@1',
      'textDocument/didChange@2',
      'textDocument/definition@-',
      'textDocument/didChange@3',
      'textDocument/didClose@-',
    ]);
  });

  it('never navigates after a failed queued sync', async () => {
    const { client, stub } = await startHarness();
    const uri = fileUri('a.ts');
    await client.syncDocument({ uri, languageId: 'typescript', text: 'x' });
    const failedSync = client.syncDocument({ uri, languageId: 'javascriptreact', text: 'y' });
    const navigation = client.navigate({ kind: 'definition', uri, position: { line: 0, character: 0 } });
    await expect(failedSync).rejects.toThrow();
    await expect(navigation).rejects.toBeInstanceOf(LspProtocolError);
    await settle();
    expect(stub.messages('textDocument/definition')).toHaveLength(0);
  });

  it('refuses to navigate a URI that was never synchronized', async () => {
    const { client, stub } = await startHarness();
    await expect(
      client.navigate({ kind: 'definition', uri: fileUri('never.ts'), position: { line: 0, character: 0 } }),
    ).rejects.toBeInstanceOf(LspProtocolError);
    await settle();
    expect(stub.messages('textDocument/definition')).toHaveLength(0);
  });

  it('serializes single operations but gives separate calls no atomic multi-call transaction', async () => {
    // The per-URI FIFO orders each operation only. A caller issuing sync then navigate as two
    // calls can have another caller's sync interleave between them; Task 7 owns the request lock
    // that makes read -> sync -> navigate -> validate atomic.
    const { client, stub } = await startHarness();
    const uri = fileUri('a.ts');
    await client.syncDocument({ uri, languageId: 'typescript', text: 'v1' });

    const callerXSync = client.syncDocument({ uri, languageId: 'typescript', text: 'caller-x' });
    const callerYSync = client.syncDocument({ uri, languageId: 'typescript', text: 'caller-y' });
    const callerXNavigate = client.navigate({ kind: 'definition', uri, position: { line: 0, character: 0 } });
    await Promise.all([callerXSync, callerYSync, callerXNavigate]);

    const order = stub.received
      .filter((message) => message.method?.startsWith('textDocument/'))
      .map((message) => {
        const params = message.params as { textDocument: { version?: number }; contentChanges?: { text: string }[] };
        return `${message.method}@${params.textDocument.version ?? '-'}:${params.contentChanges?.[0]?.text ?? ''}`;
      });
    // Each operation is FIFO, yet caller X's navigation runs against caller Y's version 3 text.
    expect(order).toEqual([
      'textDocument/didOpen@1:',
      'textDocument/didChange@2:caller-x',
      'textDocument/didChange@3:caller-y',
      'textDocument/definition@-:',
    ]);
  });

  it('under a Task 7-style external lock, versions advance 1->2->3 without stale-snapshot rollback', async () => {
    const { client, stub } = await startHarness();
    const uri = fileUri('a.ts');
    let disk = 'v1';
    // Minimal stand-in for the Task 7 request lock (owned by Task 7, not by the Protocol Client).
    let lockTail: Promise<void> = Promise.resolve();
    const withLock = async <T>(work: () => Promise<T>): Promise<T> => {
      const previous = lockTail;
      let release!: () => void;
      lockTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    };
    const navigationRequest = () =>
      withLock(async () => {
        const text = disk; // re-read inside the lock; never a pre-lock snapshot
        await client.syncDocument({ uri, languageId: 'typescript', text });
        return client.navigate({ kind: 'definition', uri, position: { line: 0, character: 0 } });
      });

    await navigationRequest();
    const staleSnapshot = disk;
    disk = 'v2';
    const second = navigationRequest();
    disk = 'v3';
    const third = navigationRequest();
    await Promise.all([second, third]);
    expect(staleSnapshot).toBe('v1');

    const synced = stub.received
      .filter((message) => message.method === 'textDocument/didOpen' || message.method === 'textDocument/didChange')
      .map((message) => {
        const params = message.params as {
          textDocument: { version: number; text?: string };
          contentChanges?: { text: string }[];
        };
        return [params.textDocument.version, params.textDocument.text ?? params.contentChanges?.[0]?.text];
      });
    // Both later requests re-read disk inside the lock and saw v3; no rollback to v1/v2 occurs.
    expect(synced).toEqual([
      [1, 'v1'],
      [2, 'v3'],
    ]);
    await client.syncDocument({ uri, languageId: 'typescript', text: 'v4' });
    const last = stub.messages('textDocument/didChange').at(-1)?.params as { textDocument: { version: number } };
    expect(last.textDocument.version).toBe(3);
  });

  it('lets Task 7 refresh previously open A before navigating B (PR #345 cross-file freshness)', async () => {
    const { client, stub } = await startHarness();
    const uriA = fileUri('a.ts');
    const uriB = fileUri('b.ts');
    const disk = new Map([
      [uriA, 'export const a = 1;'],
      [uriB, 'import { a } from "./a";'],
    ]);
    await client.syncDocument({ uri: uriA, languageId: 'typescript', text: disk.get(uriA) ?? '' });
    disk.set(uriA, 'export const a = 2;');

    for (const openUri of client.listOpenDocumentUris()) {
      await client.syncDocument({ uri: openUri, languageId: 'typescript', text: disk.get(openUri) ?? '' });
    }
    await client.syncDocument({ uri: uriB, languageId: 'typescript', text: disk.get(uriB) ?? '' });
    await client.navigate({ kind: 'definition', uri: uriB, position: { line: 0, character: 9 } });

    const order = stub.received
      .filter((message) => message.method?.startsWith('textDocument/'))
      .map((message) => `${message.method}:${(message.params as { textDocument: { uri: string } }).textDocument.uri}`);
    expect(order).toEqual([
      `textDocument/didOpen:${uriA}`,
      `textDocument/didChange:${uriA}`,
      `textDocument/didOpen:${uriB}`,
      `textDocument/definition:${uriB}`,
    ]);
  });
});

describe('createLspProtocolClient: navigation requests (§7.2)', () => {
  const position = { line: 2, character: 4 };

  it('sends definition, references (includeDeclaration:true) and implementation requests', async () => {
    const { client, stub } = await startHarness();
    const uri = fileUri('a.ts');
    await client.syncDocument({ uri, languageId: 'typescript', text: 'x' });
    await client.navigate({ kind: 'definition', uri, position });
    await client.navigate({ kind: 'references', uri, position });
    await client.navigate({ kind: 'implementations', uri, position });

    expect(stub.messages('textDocument/definition')[0]?.params).toEqual({ textDocument: { uri }, position });
    expect(stub.messages('textDocument/references')[0]?.params).toEqual({
      textDocument: { uri },
      position,
      context: { includeDeclaration: true },
    });
    expect(stub.messages('textDocument/implementation')[0]?.params).toEqual({ textDocument: { uri }, position });
  });

  it.each([
    ['null', null, null],
    ['a single Location', location('b.ts'), [location('b.ts')]],
    ['Location[]', [location('b.ts'), location('c.ts', 1)], [location('b.ts'), location('c.ts', 1)]],
    [
      'LocationLink[]',
      [
        {
          targetUri: fileUri('b.ts'),
          targetRange: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } },
          targetSelectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
        },
      ],
      [
        {
          targetUri: fileUri('b.ts'),
          targetRange: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } },
          targetSelectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
        },
      ],
    ],
  ])('returns definition result %s', async (_label, reply, expected) => {
    const { client } = await startHarness({ handlers: { 'textDocument/definition': () => reply } });
    const uri = fileUri('a.ts');
    await client.syncDocument({ uri, languageId: 'typescript', text: 'x' });
    await expect(client.navigate({ kind: 'definition', uri, position })).resolves.toEqual(expected);
  });

  it.each([
    ['definition', 'textDocument/definition', [location('b.ts'), { targetUri: fileUri('c.ts') }]],
    ['definition', 'textDocument/definition', { foo: 1 }],
    ['definition', 'textDocument/definition', 'file:///etc/passwd'],
    ['references', 'textDocument/references', location('b.ts')],
    [
      'references',
      'textDocument/references',
      [
        {
          targetUri: fileUri('b.ts'),
          targetRange: location('b.ts').range,
          targetSelectionRange: location('b.ts').range,
        },
      ],
    ],
  ] as const)('maps malformed %s reply to LSP_PROTOCOL_ERROR', async (kind, method, reply) => {
    const { client } = await startHarness({ handlers: { [method]: () => reply } });
    const uri = fileUri('a.ts');
    await client.syncDocument({ uri, languageId: 'typescript', text: 'x' });
    const error = await client.navigate({ kind, uri, position }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LspProtocolError);
    expect((error as LspProtocolError).reasonCode).toBe('LSP_PROTOCOL_ERROR');
  });

  it('maps a server error response to a sanitized LSP_PROTOCOL_ERROR', async () => {
    const { client } = await startHarness({
      handlers: {
        'textDocument/definition': () => {
          throw new Error('server-secret-detail');
        },
      },
    });
    const uri = fileUri('a.ts');
    await client.syncDocument({ uri, languageId: 'typescript', text: 'x' });
    const error = await client.navigate({ kind: 'definition', uri, position }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LspProtocolError);
    expect((error as Error).message).not.toContain('server-secret-detail');
  });

  it('times out, cancels the actual request ID, ignores the late reply and stays usable', async () => {
    let delayNext = true;
    const { client, stub } = await startHarness(
      {
        handlers: {
          'textDocument/definition': async () => {
            if (delayNext) {
              delayNext = false;
              await new Promise((resolve) => setTimeout(resolve, 150));
              return location('late.ts');
            }
            return location('fresh.ts');
          },
        },
      },
      { requestTimeoutMs: 40 },
    );
    const uri = fileUri('a.ts');
    await client.syncDocument({ uri, languageId: 'typescript', text: 'x' });

    const error = await client.navigate({ kind: 'definition', uri, position }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LspRequestTimeoutError);
    expect((error as LspRequestTimeoutError).reasonCode).toBe('LSP_REQUEST_TIMEOUT');
    const cancel = await stub.waitFor((message) => message.method === '$/cancelRequest');
    const requestId = stub.messages('textDocument/definition')[0]?.id;
    expect(cancel.params).toEqual({ id: requestId });

    await new Promise((resolve) => setTimeout(resolve, 200));
    await expect(client.navigate({ kind: 'definition', uri, position })).resolves.toEqual([location('fresh.ts')]);
  });

  it('cancels an in-flight request through its AbortSignal with the actual request ID', async () => {
    const { client, stub } = await startHarness({
      handlers: {
        'textDocument/definition': async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return null;
        },
      },
    });
    const uri = fileUri('a.ts');
    await client.syncDocument({ uri, languageId: 'typescript', text: 'x' });
    const controller = new AbortController();
    const navigation = client.navigate({ kind: 'definition', uri, position, signal: controller.signal });
    const request = await stub.waitFor((message) => message.method === 'textDocument/definition');
    controller.abort();

    const error = await navigation.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LspRequestCancelledError);
    expect((error as LspRequestCancelledError).reasonCode).toBe('REQUEST_CANCELLED');
    const cancel = await stub.waitFor((message) => message.method === '$/cancelRequest');
    expect(cancel.params).toEqual({ id: request.id });
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

  it('does not send a request for an already-aborted signal', async () => {
    const { client, stub } = await startHarness();
    const uri = fileUri('a.ts');
    await client.syncDocument({ uri, languageId: 'typescript', text: 'x' });
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.navigate({ kind: 'definition', uri, position, signal: controller.signal }),
    ).rejects.toBeInstanceOf(LspRequestCancelledError);
    await settle();
    expect(stub.messages('textDocument/definition')).toHaveLength(0);
  });

  it('refuses start with an already-aborted signal before sending initialize', async () => {
    const harness = createHarness();
    const controller = new AbortController();
    controller.abort();
    await expect(
      harness.client.start({ rootUri: ROOT_URI, expectedServerVersion: '6.0.2', signal: controller.signal }),
    ).rejects.toBeInstanceOf(LspRequestCancelledError);
    await settle();
    expect(harness.stub.messages('initialize')).toHaveLength(0);
  });

  it('rejects pending and future operations when the server stream closes', async () => {
    const { client, serverToClient } = await startHarness({
      handlers: { 'textDocument/definition': () => new Promise(() => undefined) },
    });
    const uri = fileUri('a.ts');
    await client.syncDocument({ uri, languageId: 'typescript', text: 'x' });
    const navigation = client.navigate({ kind: 'definition', uri, position });
    await settle();
    serverToClient.end();
    await expect(navigation).rejects.toBeInstanceOf(LspProtocolError);
    await expect(client.navigate({ kind: 'definition', uri, position })).rejects.toBeInstanceOf(LspProtocolError);
  });
});

describe('createLspProtocolClient: server-originated messages (§7.3)', () => {
  const makeWorkspace = async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-lsp-protocol-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'a.ts');
    await fs.writeFile(file, 'export const a = 1;\n');
    return { dir, file, rootUri: pathToFileURL(dir).href };
  };

  it('answers workspace/configuration with one null per item and workspaceFolders with the single root', async () => {
    const { dir, rootUri } = await makeWorkspace();
    const { stub } = await startHarness({}, { rootUri });

    const configuration = await stub.request('workspace/configuration', {
      items: [{ section: 'typescript' }, { section: 'env' }, { scopeUri: rootUri }],
    });
    expect(configuration.result).toEqual([null, null, null]);

    const folders = await stub.request('workspace/workspaceFolders');
    expect(folders.result).toEqual([{ uri: rootUri, name: path.basename(dir) }]);
  });

  it('refuses workspace/applyEdit and never edits files', async () => {
    const { file, rootUri } = await makeWorkspace();
    const before = await fs.readFile(file, 'utf8');
    const { stub } = await startHarness({}, { rootUri });
    const fileUriValue = pathToFileURL(file).href;

    const response = await stub.request('workspace/applyEdit', {
      label: 'rename',
      edit: {
        changes: {
          [fileUriValue]: [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, newText: 'HACKED' },
          ],
        },
        documentChanges: [{ kind: 'delete', uri: fileUriValue }],
      },
    });
    expect(response.result).toEqual({ applied: false, failureReason: 'Nexus LSP is read-only' });
    await settle();
    await expect(fs.readFile(file, 'utf8')).resolves.toBe(before);
    await expect(fs.readdir(path.dirname(file))).resolves.toEqual(['a.ts']);
  });

  it('answers showMessageRequest with null and showDocument with success:false', async () => {
    const { stub } = await startHarness();
    const message = await stub.request('window/showMessageRequest', {
      type: 1,
      message: 'Install?',
      actions: [{ title: 'Yes' }],
    });
    expect(message.result).toBeNull();
    const document = await stub.request('window/showDocument', { uri: 'https://example.invalid', external: true });
    expect(document.result).toEqual({ success: false });
  });

  it.each([
    'client/registerCapability',
    'client/unregisterCapability',
    'window/workDoneProgress/create',
    'workspace/executeCommand',
    'custom/unknownRequest',
  ])('rejects %s with MethodNotFound', async (method) => {
    const { stub } = await startHarness();
    const response = await stub.request(method, {
      registrations: [{ id: '1', method: 'workspace/didChangeWatchedFiles' }],
    });
    expect(response.error?.code).toBe(-32601);
    expect(response.result).toBeUndefined();
  });

  it('consumes diagnostics, log, message and progress notifications without side effects', async () => {
    const { client, stub } = await startHarness();
    stub.notify('textDocument/publishDiagnostics', { uri: fileUri('a.ts'), diagnostics: [] });
    stub.notify('window/logMessage', { type: 3, message: 'log' });
    stub.notify('window/showMessage', { type: 1, message: 'show' });
    stub.notify('$/progress', { token: 'x', value: { kind: 'begin', title: 'Indexing' } });
    stub.notify('custom/unknownNotification', {});
    await settle();

    const uri = fileUri('a.ts');
    await client.syncDocument({ uri, languageId: 'typescript', text: 'x' });
    await expect(client.navigate({ kind: 'definition', uri, position: { line: 0, character: 0 } })).resolves.toBeNull();
  });
});

describe('createLspProtocolClient: shutdown', () => {
  it('sends shutdown then exit once and rejects later operations', async () => {
    const { client, stub } = await startHarness();
    await client.shutdown();
    await client.shutdown();
    await stub.waitFor((message) => message.method === 'exit');

    const tail = methodsOf(stub).filter((method) => method === 'shutdown' || method === 'exit');
    expect(tail).toEqual(['shutdown', 'exit']);
    await expect(
      client.syncDocument({ uri: fileUri('a.ts'), languageId: 'typescript', text: 'x' }),
    ).rejects.toBeInstanceOf(LspProtocolError);
  });

  it('completes shutdown even when the server never answers', async () => {
    const { client, stub } = await startHarness(
      { handlers: { shutdown: () => new Promise(() => undefined) } },
      { requestTimeoutMs: 30 },
    );
    await expect(client.shutdown()).resolves.toBeUndefined();
    await stub.waitFor((message) => message.method === 'exit');
  });

  it('completes shutdown when the exit notification write stalls', async () => {
    const clientToServer = new PassThrough();
    let stallExit = false;
    let releaseExit: (() => void) | undefined;
    const stdin = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        if (stallExit && chunk.toString().includes('"method":"exit"')) {
          releaseExit = () => clientToServer.write(chunk, callback);
          return;
        }
        clientToServer.write(chunk, callback);
      },
    });
    stdin.on('error', () => undefined);
    const serverToClient = new PassThrough();
    const stub = stubModule.startStubLanguageServer({ input: clientToServer, output: serverToClient });
    const client = createLspProtocolClient({ stdin, stdout: serverToClient, rootUri: ROOT_URI, requestTimeoutMs: 30 });
    cleanups.push(async () => {
      releaseExit?.();
      await client.shutdown();
      stub.close();
    });
    await client.start({ rootUri: ROOT_URI, expectedServerVersion: '6.0.2' });
    stallExit = true;

    await expect(client.shutdown()).resolves.toBeUndefined();
  });

  it('does not return capabilities or restore ready after shutdown interrupts startup', async () => {
    const clientToServer = new PassThrough();
    let releaseInitialized: (() => void) | undefined;
    let initializedWriteStarted: (() => void) | undefined;
    const initializedStarted = new Promise<void>((resolve) => {
      initializedWriteStarted = resolve;
    });
    const stdin = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        if (chunk.toString().includes('"method":"initialized"')) {
          initializedWriteStarted?.();
          releaseInitialized = () => clientToServer.write(chunk, callback);
          return;
        }
        clientToServer.write(chunk, callback);
      },
    });
    stdin.on('error', () => undefined);
    const serverToClient = new PassThrough();
    const stub = stubModule.startStubLanguageServer({ input: clientToServer, output: serverToClient });
    const client = createLspProtocolClient({ stdin, stdout: serverToClient, rootUri: ROOT_URI, requestTimeoutMs: 30 });
    cleanups.push(async () => {
      releaseInitialized?.();
      await client.shutdown();
      stub.close();
    });
    const starting = client.start({ rootUri: ROOT_URI, expectedServerVersion: '6.0.2' });
    await initializedStarted;
    const shutdown = client.shutdown();

    await expect(starting).rejects.toBeInstanceOf(LspProtocolError);
    await expect(shutdown).resolves.toBeUndefined();
    expect(releaseInitialized).toBeDefined();
  });
});
