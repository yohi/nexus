// TEST-ONLY stub language server for the Nexus LSP Protocol Client unit tests.
//
// It speaks LSP base-protocol framing (Content-Length headers + JSON-RPC 2.0)
// over arbitrary byte streams so the Protocol Client can be exercised through
// real stream-backed transport without spawning `typescript-language-server`.
// The framing here is intentionally independent from vscode-jsonrpc so that the
// production Protocol Client remains the only creator of a MessageConnection
// in the test process. This file is never imported by production code.
//
// Usage (in-process):
//   const stub = startStubLanguageServer({ input, output, config });
//   stub.received            // every message received from the client, in order
//   await stub.request(method, params)  // server -> client request
//   stub.notify(method, params)         // server -> client notification
//   await stub.waitFor((msg) => msg.method === 'initialized')
//
// Usage (child process, e.g. for Process Manager tests):
//   node stub-language-server.mjs   (config JSON in NEXUS_LSP_STUB_CONFIG)

import { pathToFileURL } from 'node:url';

const HEADER_SEPARATOR = Buffer.from('\r\n\r\n', 'ascii');

export const DEFAULT_INITIALIZE_RESULT = Object.freeze({
  capabilities: {
    textDocumentSync: 2,
    definitionProvider: true,
    referencesProvider: true,
    implementationProvider: true,
  },
  serverInfo: { name: 'typescript-language-server', version: '6.0.2' },
});

const METHOD_NOT_FOUND = -32601;

/**
 * @param {{
 *   input: NodeJS.ReadableStream,
 *   output: NodeJS.WritableStream,
 *   config?: {
 *     initializeResult?: unknown,
 *     handlers?: Record<string, (params: unknown, message: unknown) => unknown>,
 *   },
 * }} options
 */
export function startStubLanguageServer({ input, output, config = {} }) {
  const received = [];
  const waiters = [];
  const pendingServerRequests = new Map();
  let buffer = Buffer.alloc(0);
  let nextServerRequestId = 1000;
  let closed = false;

  const write = (message) => {
    if (closed) return;
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    output.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
  };

  const respond = (id, result) => write({ jsonrpc: '2.0', id, result });
  const respondError = (id, code, message) => write({ jsonrpc: '2.0', id, error: { code, message } });

  const settleWaiters = () => {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      const match = received.find(waiter.predicate);
      if (match !== undefined) {
        waiters.splice(i, 1);
        waiter.resolve(match);
      }
    }
  };

  const handleRequest = async (message) => {
    const handler = config.handlers?.[message.method];
    try {
      if (handler !== undefined) {
        respond(message.id, (await handler(message.params, message)) ?? null);
        return;
      }
      switch (message.method) {
        case 'initialize':
          respond(message.id, config.initializeResult ?? DEFAULT_INITIALIZE_RESULT);
          return;
        case 'shutdown':
        case 'textDocument/definition':
        case 'textDocument/references':
        case 'textDocument/implementation':
          respond(message.id, null);
          return;
        default:
          respondError(message.id, METHOD_NOT_FOUND, 'Method not found');
      }
    } catch (error) {
      respondError(message.id, -32603, error instanceof Error ? error.message : 'stub failure');
    }
  };

  const dispatch = (message) => {
    received.push(message);
    settleWaiters();
    if (typeof message.method === 'string' && message.id !== undefined) {
      void handleRequest(message);
      return;
    }
    if (message.method === undefined && message.id !== undefined) {
      const pending = pendingServerRequests.get(message.id);
      if (pending !== undefined) {
        pendingServerRequests.delete(message.id);
        pending(message);
      }
    }
  };

  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    while (true) {
      const headerEnd = buffer.indexOf(HEADER_SEPARATOR);
      if (headerEnd < 0) return;
      const header = buffer.subarray(0, headerEnd).toString('ascii');
      const match = /Content-Length: (\d+)/i.exec(header);
      if (match === null) throw new Error('stub: missing Content-Length');
      const length = Number(match[1]);
      const bodyStart = headerEnd + HEADER_SEPARATOR.length;
      if (buffer.length < bodyStart + length) return;
      const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      buffer = buffer.subarray(bodyStart + length);
      dispatch(JSON.parse(body));
    }
  };

  input.on('data', onData);

  return {
    received,
    /** Messages received with the given method, in arrival order. */
    messages(method) {
      return received.filter((message) => message.method === method);
    },
    waitFor(predicate) {
      const match = received.find(predicate);
      if (match !== undefined) return Promise.resolve(match);
      return new Promise((resolve) => waiters.push({ predicate, resolve }));
    },
    /** Server -> client request; resolves with the raw JSON-RPC response message. */
    request(method, params) {
      const id = nextServerRequestId;
      nextServerRequestId += 1;
      return new Promise((resolve) => {
        pendingServerRequests.set(id, resolve);
        write({ jsonrpc: '2.0', id, method, params });
      });
    },
    notify(method, params) {
      write({ jsonrpc: '2.0', method, params });
    },
    /** Raw frame writer for malformed-message tests. */
    writeRaw(message) {
      write(message);
    },
    close() {
      closed = true;
      input.removeListener('data', onData);
    },
  };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const rawConfig = process.env.NEXUS_LSP_STUB_CONFIG;
  const config = rawConfig === undefined ? {} : JSON.parse(rawConfig);
  const stub = startStubLanguageServer({ input: process.stdin, output: process.stdout, config });
  void stub.waitFor((message) => message.method === 'exit').then(() => process.exit(0));
}
