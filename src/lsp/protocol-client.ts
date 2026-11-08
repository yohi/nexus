import path from 'node:path';

import {
  ApplyWorkspaceEditRequest,
  CancellationTokenSource,
  ConfigurationRequest,
  createMessageConnection,
  DefinitionRequest,
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  ErrorCodes,
  ExitNotification,
  ImplementationRequest,
  InitializedNotification,
  InitializeRequest,
  LogMessageNotification,
  PublishDiagnosticsNotification,
  ReferencesRequest,
  RegistrationRequest,
  ResponseError,
  ShowDocumentRequest,
  ShowMessageNotification,
  ShowMessageRequest,
  ShutdownRequest,
  StreamMessageReader,
  StreamMessageWriter,
  UnregistrationRequest,
  WorkDoneProgressCreateRequest,
  WorkspaceFoldersRequest,
} from 'vscode-languageserver-protocol/node';
import type {
  CancellationToken,
  ClientCapabilities,
  InitializeParams,
  Location,
  LocationLink,
  MessageConnection,
  Position,
  Range,
  TextDocumentContentChangeEvent,
} from 'vscode-languageserver-protocol/node';

import type { ILspProvider, LspCapabilities, LspDocumentLanguageId, LspNavigationKind } from './contracts.js';

/**
 * Raised when the server explicitly reports a `serverInfo.version` that differs from (or is a
 * malformed form of) the Owner-approved version. The untrusted reported value is never reflected.
 * The Process Manager maps it to public `unavailable` / `LSP_EXECUTABLE_NOT_APPROVED`.
 */
export class LspServerVersionMismatchError extends Error {
  readonly reasonCode = 'LSP_EXECUTABLE_NOT_APPROVED' as const;
  constructor() {
    super('Language server reported a version that is not the Owner-approved version');
    this.name = 'LspServerVersionMismatchError';
  }
}

/**
 * Internal: the server's advertised textDocumentSync cannot support full-document replacement
 * with explicit open/close. Mapped by the Process Manager to `unavailable` / `LSP_SYNC_UNSUPPORTED`.
 */
export class LspSyncUnsupportedError extends Error {
  readonly reasonCode = 'LSP_SYNC_UNSUPPORTED' as const;
  constructor() {
    super('Language server does not support the required document synchronization');
    this.name = 'LspSyncUnsupportedError';
  }
}

/** Sanitized protocol/transport/session failure; never carries server-provided text. */
export class LspProtocolError extends Error {
  readonly reasonCode = 'LSP_PROTOCOL_ERROR' as const;
  constructor(message = 'Language server protocol error') {
    super(message);
    this.name = 'LspProtocolError';
  }
}

export class LspCapabilityUnsupportedError extends Error {
  readonly reasonCode = 'LSP_CAPABILITY_UNSUPPORTED' as const;
  constructor() {
    super('Language server does not support the requested navigation');
    this.name = 'LspCapabilityUnsupportedError';
  }
}

export class LspRequestTimeoutError extends Error {
  readonly reasonCode = 'LSP_REQUEST_TIMEOUT' as const;
  constructor() {
    super('Language server request timed out');
    this.name = 'LspRequestTimeoutError';
  }
}

export class LspRequestCancelledError extends Error {
  readonly reasonCode = 'REQUEST_CANCELLED' as const;
  constructor() {
    super('Language server request was cancelled');
    this.name = 'LspRequestCancelledError';
  }
}

export interface LspProtocolClientInput {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  rootUri: string;
  /** Finite per-request deadline (initialize, navigation, shutdown). */
  requestTimeoutMs?: number;
}

export const LSP_DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Fixed security default (not project/env/user overridable): prevents typescript-language-server
 * from triggering tsserver Automatic Type Acquisition (npm downloads). `npmLocation` is never sent.
 * This does not constitute an OS-level egress boundary.
 */
const FIXED_INITIALIZATION_OPTIONS = Object.freeze({ disableAutomaticTypingAcquisition: true });

const APPLY_EDIT_REFUSAL = Object.freeze({ applied: false, failureReason: 'Nexus LSP is read-only' });

const LSP_DOCUMENT_LANGUAGE_IDS: ReadonlySet<string> = new Set([
  'typescript',
  'typescriptreact',
  'javascript',
  'javascriptreact',
]);

type SyncKind = 'full' | 'incremental';

interface SynchronizedDocument {
  readonly languageId: LspDocumentLanguageId;
  readonly text: string;
  readonly version: number;
}

type ClientState = 'idle' | 'starting' | 'ready' | 'failed' | 'closed';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isPosition = (value: unknown): value is Position =>
  isObject(value) && isNonNegativeInteger(value.line) && isNonNegativeInteger(value.character);

const isRange = (value: unknown): value is Range => isObject(value) && isPosition(value.start) && isPosition(value.end);

const isLocation = (value: unknown): value is Location =>
  isObject(value) && typeof value.uri === 'string' && isRange(value.range);

const isLocationLink = (value: unknown): value is LocationLink =>
  isObject(value) &&
  typeof value.targetUri === 'string' &&
  isRange(value.targetRange) &&
  isRange(value.targetSelectionRange) &&
  (value.originSelectionRange === undefined || isRange(value.originSelectionRange));

const isAdvertised = (value: unknown): boolean => value === true || isObject(value);

/** Zero-based UTF-16 end position of `text`; CRLF, LF and CR each count as one line break. */
export const lspDocumentEnd = (text: string): Position => {
  let line = 0;
  let character = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x0d) {
      if (text.charCodeAt(index + 1) === 0x0a) index += 1;
      line += 1;
      character = 0;
    } else if (code === 0x0a) {
      line += 1;
      character = 0;
    } else {
      // JS strings are UTF-16: a non-BMP code point contributes its two code units.
      character += 1;
    }
  }
  return { line, character };
};

const parseTextDocumentSync = (value: unknown): SyncKind => {
  const kindOf = (kind: unknown): SyncKind | null => (kind === 1 ? 'full' : kind === 2 ? 'incremental' : null);
  if (typeof value === 'number') {
    const kind = kindOf(value);
    if (kind !== null) return kind;
  } else if (isObject(value) && value.openClose === true) {
    const kind = kindOf(value.change);
    if (kind !== null) return kind;
  }
  throw new LspSyncUnsupportedError();
};

const workspaceFolderName = (rootUri: string): string => {
  try {
    const name = path.posix.basename(decodeURIComponent(new URL(rootUri).pathname));
    return name === '' ? 'workspace' : name;
  } catch {
    return 'workspace';
  }
};

const CLIENT_CAPABILITIES: ClientCapabilities = {
  general: { positionEncodings: ['utf-16'] },
  workspace: {
    applyEdit: false,
    configuration: true,
    workspaceFolders: true,
    didChangeConfiguration: { dynamicRegistration: false },
    didChangeWatchedFiles: { dynamicRegistration: false },
  },
  textDocument: {
    synchronization: { dynamicRegistration: false, willSave: false, willSaveWaitUntil: false, didSave: false },
    definition: { dynamicRegistration: false, linkSupport: true },
    references: { dynamicRegistration: false },
    implementation: { dynamicRegistration: false, linkSupport: true },
  },
  window: { workDoneProgress: false, showDocument: { support: false } },
};

const validateNavigationResult = (
  kind: LspNavigationKind,
  result: unknown,
): null | readonly (Location | LocationLink)[] => {
  if (result === null) return null;
  if (kind === 'references') {
    if (Array.isArray(result) && result.every(isLocation)) return Object.freeze([...result]);
    throw new LspProtocolError('Language server returned a malformed navigation result');
  }
  if (isLocation(result)) return Object.freeze([result]);
  if (Array.isArray(result)) {
    if (result.every(isLocation)) return Object.freeze([...result]);
    if (result.every(isLocationLink)) return Object.freeze([...result]);
  }
  throw new LspProtocolError('Language server returned a malformed navigation result');
};

/**
 * Read-only Microsoft LSP/JSON-RPC client for one language-server child process.
 *
 * Sole owner of the process's MessageConnection (one reader, one writer, one `listen()`), of
 * inbound request policy (deny by default, never mutate files or execute commands), and of the
 * per-URI synchronized `{languageId,text,version}` state. Its per-URI FIFO orders individual
 * protocol operations only: it does NOT make a caller's read -> sync -> navigate -> validate
 * sequence atomic. The Task 7 navigation service owns that request lock and the disk re-read.
 */
class LspProtocolClient implements ILspProvider {
  private readonly connection: MessageConnection;
  private readonly rootUri: string;
  private readonly requestTimeoutMs: number;
  private readonly documents = new Map<string, SynchronizedDocument>();
  private readonly failedSyncUris = new Set<string>();
  private readonly queues = new Map<string, Promise<void>>();
  /** Aborted once the session is unusable (send failure, transport close/error, shutdown). */
  private readonly session = new AbortController();
  private state: ClientState = 'idle';
  private syncKind: SyncKind = 'incremental';
  private capabilities: LspCapabilities | null = null;
  private shutdownPromise: Promise<void> | null = null;

  constructor(input: LspProtocolClientInput) {
    this.rootUri = input.rootUri;
    this.requestTimeoutMs =
      input.requestTimeoutMs !== undefined && input.requestTimeoutMs > 0
        ? input.requestTimeoutMs
        : LSP_DEFAULT_REQUEST_TIMEOUT_MS;

    this.connection = createMessageConnection(
      new StreamMessageReader(input.stdout),
      new StreamMessageWriter(input.stdin),
    );
    this.registerInboundHandlers();
    this.connection.onClose(() => this.invalidateSession());
    this.connection.onError(() => this.invalidateSession());
    // Handlers are registered above; this is the single listen() for this child.
    this.connection.listen();
  }

  async start(input: {
    rootUri: string;
    expectedServerVersion: '6.0.2';
    signal?: AbortSignal;
  }): Promise<LspCapabilities> {
    if (this.state !== 'idle') throw new LspProtocolError('Language server session was already started');
    if (input.rootUri !== this.rootUri) {
      this.state = 'failed';
      throw new LspProtocolError('Language server root does not match the client root');
    }
    if (input.signal?.aborted === true) {
      this.state = 'failed';
      throw new LspRequestCancelledError();
    }
    this.state = 'starting';
    try {
      const params: InitializeParams = {
        processId: process.pid,
        clientInfo: { name: 'nexus' },
        rootUri: this.rootUri,
        workspaceFolders: [{ uri: this.rootUri, name: workspaceFolderName(this.rootUri) }],
        capabilities: CLIENT_CAPABILITIES,
        initializationOptions: { ...FIXED_INITIALIZATION_OPTIONS },
      };
      const result: unknown = await this.request(
        (token) => this.connection.sendRequest(InitializeRequest.type, params, token),
        input.signal,
      );
      if (!isObject(result)) throw new LspProtocolError('Language server returned a malformed initialize result');

      // Version attestation precedes any capability negotiation: absence is accepted, an explicit
      // unequal or malformed value is a contradiction of the Owner-approved executable.
      const serverInfo = result.serverInfo;
      if (serverInfo !== undefined) {
        if (!isObject(serverInfo)) throw new LspProtocolError('Language server returned malformed serverInfo');
        if (Object.hasOwn(serverInfo, 'version') && serverInfo.version !== input.expectedServerVersion) {
          throw new LspServerVersionMismatchError();
        }
      }

      const serverCapabilities = result.capabilities;
      if (!isObject(serverCapabilities)) {
        throw new LspProtocolError('Language server returned malformed capabilities');
      }
      if (serverCapabilities.positionEncoding !== undefined && serverCapabilities.positionEncoding !== 'utf-16') {
        throw new LspProtocolError('Language server negotiated an unsupported position encoding');
      }
      this.syncKind = parseTextDocumentSync(serverCapabilities.textDocumentSync);

      await this.notify(() => this.connection.sendNotification(InitializedNotification.type, {}));
      this.capabilities = Object.freeze({
        definition: isAdvertised(serverCapabilities.definitionProvider),
        references: isAdvertised(serverCapabilities.referencesProvider),
        implementations: isAdvertised(serverCapabilities.implementationProvider),
        positionEncoding: 'utf-16',
      });
      this.state = 'ready';
      return this.capabilities;
    } catch (error) {
      if (this.state === 'starting') this.state = 'failed';
      throw error;
    }
  }

  syncDocument(input: { uri: string; languageId: LspDocumentLanguageId; text: string }): Promise<void> {
    // Only uri/languageId/text are read; caller-supplied kind/version are never accepted.
    const { uri, languageId, text } = input;
    if (typeof uri !== 'string' || uri === '' || typeof text !== 'string' || !LSP_DOCUMENT_LANGUAGE_IDS.has(languageId)) {
      return Promise.reject(new TypeError('Invalid LSP document synchronization input'));
    }
    return this.enqueue(uri, async () => {
      this.assertUsable();
      const current = this.documents.get(uri);
      try {
        if (current === undefined) {
          await this.notify(() =>
            this.connection.sendNotification(DidOpenTextDocumentNotification.type, {
              textDocument: { uri, languageId, version: 1, text },
            }),
          );
          this.documents.set(uri, { languageId, text, version: 1 });
        } else if (current.languageId !== languageId) {
          throw new LspProtocolError('Language ID contradicts the open document');
        } else if (current.text !== text) {
          const version = current.version + 1;
          const contentChanges: TextDocumentContentChangeEvent[] =
            this.syncKind === 'full'
              ? [{ text }]
              : [{ range: { start: { line: 0, character: 0 }, end: lspDocumentEnd(current.text) }, text }];
          await this.notify(() =>
            this.connection.sendNotification(DidChangeTextDocumentNotification.type, {
              textDocument: { uri, version },
              contentChanges,
            }),
          );
          this.documents.set(uri, { languageId, text, version });
        }
        this.failedSyncUris.delete(uri);
      } catch (error) {
        this.failedSyncUris.add(uri);
        throw error;
      }
    });
  }

  closeDocument(input: { uri: string }): Promise<void> {
    const { uri } = input;
    return this.enqueue(uri, async () => {
      if (!this.documents.has(uri)) {
        this.failedSyncUris.delete(uri);
        return;
      }
      this.assertUsable();
      await this.notify(() =>
        this.connection.sendNotification(DidCloseTextDocumentNotification.type, { textDocument: { uri } }),
      );
      this.documents.delete(uri);
      this.failedSyncUris.delete(uri);
    });
  }

  listOpenDocumentUris(): readonly string[] {
    return Object.freeze([...this.documents.keys()].sort());
  }

  navigate(input: {
    kind: LspNavigationKind;
    uri: string;
    position: { line: number; character: number };
    signal?: AbortSignal;
  }): Promise<null | readonly (Location | LocationLink)[]> {
    const { kind, uri, signal } = input;
    if (!isPosition(input.position)) return Promise.reject(new TypeError('Invalid LSP position'));
    const position: Position = { line: input.position.line, character: input.position.character };
    return this.enqueue(uri, async () => {
      this.assertUsable();
      if (!this.documents.has(uri) || this.failedSyncUris.has(uri)) {
        throw new LspProtocolError('Document is not synchronized for navigation');
      }
      const capabilities = this.capabilities;
      if (capabilities === null || !capabilities[kind]) throw new LspCapabilityUnsupportedError();
      const textDocument = { uri };
      const result: unknown = await this.request((token) => {
        switch (kind) {
          case 'definition':
            return this.connection.sendRequest(DefinitionRequest.type, { textDocument, position }, token);
          case 'references':
            return this.connection.sendRequest(
              ReferencesRequest.type,
              { textDocument, position, context: { includeDeclaration: true } },
              token,
            );
          case 'implementations':
            return this.connection.sendRequest(ImplementationRequest.type, { textDocument, position }, token);
        }
      }, signal);
      return validateNavigationResult(kind, result);
    });
  }

  shutdown(): Promise<void> {
    this.shutdownPromise ??= this.performShutdown();
    return this.shutdownPromise;
  }

  private async performShutdown(): Promise<void> {
    const wasReady = this.state === 'ready' && !this.session.signal.aborted;
    const transportOpen = !this.session.signal.aborted;
    this.state = 'closed';
    if (wasReady) {
      try {
        await this.request((token) => this.connection.sendRequest(ShutdownRequest.type, token), undefined);
      } catch {
        // Best effort: the Process Manager applies bounded force termination.
      }
    }
    if (transportOpen || wasReady) {
      try {
        await this.connection.sendNotification(ExitNotification.type);
      } catch {
        // Transport already gone.
      }
    }
    this.invalidateSession();
    this.connection.dispose();
  }

  private registerInboundHandlers(): void {
    const connection = this.connection;
    // Read-only answers: no env/config/secret disclosure, single canonical worktree folder.
    connection.onRequest(ConfigurationRequest.type, (params) =>
      Array.isArray(params?.items) ? params.items.map(() => null) : [],
    );
    connection.onRequest(WorkspaceFoldersRequest.type, () => [
      { uri: this.rootUri, name: workspaceFolderName(this.rootUri) },
    ]);
    // Refusals: never apply edits, show UI, or launch documents.
    connection.onRequest(ApplyWorkspaceEditRequest.type, () => ({ ...APPLY_EDIT_REFUSAL }));
    connection.onRequest(ShowMessageRequest.type, () => null);
    connection.onRequest(ShowDocumentRequest.type, () => ({ success: false }));
    const methodNotFound = () => new ResponseError(ErrorCodes.MethodNotFound, 'Method not found');
    connection.onRequest(RegistrationRequest.type, methodNotFound);
    connection.onRequest(UnregistrationRequest.type, methodNotFound);
    connection.onRequest(WorkDoneProgressCreateRequest.type, methodNotFound);
    // Unknown/unadvertised server requests are denied by default.
    connection.onRequest(methodNotFound);

    // Consume notifications with no side effects.
    connection.onNotification(PublishDiagnosticsNotification.type, () => undefined);
    connection.onNotification(LogMessageNotification.type, () => undefined);
    connection.onNotification(ShowMessageNotification.type, () => undefined);
    connection.onNotification(() => undefined);
    connection.onUnhandledProgress(() => undefined);
  }

  private enqueue<T>(uri: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(uri) ?? Promise.resolve();
    const run = previous.then(operation);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(uri, tail);
    void tail.then(() => {
      if (this.queues.get(uri) === tail) this.queues.delete(uri);
    });
    return run;
  }

  private assertUsable(): void {
    if (this.state !== 'ready' || this.session.signal.aborted) {
      throw new LspProtocolError('Language server session is not usable');
    }
  }

  private invalidateSession(): void {
    if (!this.session.signal.aborted) this.session.abort();
  }

  /** Sends a notification; a local send failure poisons the session. */
  private async notify(send: () => Promise<void>): Promise<void> {
    if (this.session.signal.aborted) throw new LspProtocolError('Language server session is not usable');
    try {
      await send();
    } catch {
      this.invalidateSession();
      throw new LspProtocolError('Failed to send a message to the language server');
    }
  }

  /**
   * Sends a request bounded by the request deadline, the caller's signal and session liveness.
   * On deadline/cancellation the library sends `$/cancelRequest` for the actual request ID; a
   * late reply is ignored.
   */
  private async request<T>(send: (token: CancellationToken) => Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (this.session.signal.aborted) throw new LspProtocolError('Language server session is not usable');
    if (signal?.aborted === true) throw new LspRequestCancelledError();
    const source = new CancellationTokenSource();
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    let onSessionEnd: (() => void) | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        timer = setTimeout(() => {
          source.cancel();
          reject(new LspRequestTimeoutError());
        }, this.requestTimeoutMs);
        onAbort = () => {
          source.cancel();
          reject(new LspRequestCancelledError());
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        onSessionEnd = () => reject(new LspProtocolError('Language server connection closed'));
        this.session.signal.addEventListener('abort', onSessionEnd, { once: true });
        const fail = () => reject(new LspProtocolError('Language server request failed'));
        try {
          // Sanitized: never reflect server-provided error text.
          send(source.token).then(resolve, fail);
        } catch {
          fail();
        }
      });
    } finally {
      clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort);
      if (onSessionEnd !== undefined) this.session.signal.removeEventListener('abort', onSessionEnd);
      source.dispose();
    }
  }
}

export const createLspProtocolClient = (input: LspProtocolClientInput): ILspProvider =>
  new LspProtocolClient({
    stdin: input.stdin,
    stdout: input.stdout,
    rootUri: input.rootUri,
    ...(input.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: input.requestTimeoutMs }),
  });
