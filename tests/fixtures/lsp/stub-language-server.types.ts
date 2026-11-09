export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface StubConfig {
  initializeResult?: unknown;
  handlers?: Record<string, (params: unknown, message: JsonRpcMessage) => unknown>;
}

export interface StubServer {
  received: JsonRpcMessage[];
  messages(method: string): JsonRpcMessage[];
  waitFor(predicate: (message: JsonRpcMessage) => boolean): Promise<JsonRpcMessage>;
  request(method: string, params?: unknown): Promise<JsonRpcMessage>;
  notify(method: string, params?: unknown): void;
  close(): void;
}

export interface StubModule {
  startStubLanguageServer(input: {
    input: NodeJS.ReadableStream;
    output: NodeJS.WritableStream;
    config?: StubConfig;
  }): StubServer;
  DEFAULT_INITIALIZE_RESULT: { capabilities: Record<string, unknown>; serverInfo: { name: string; version: string } };
}
