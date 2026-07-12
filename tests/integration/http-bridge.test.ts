import { createServer } from 'node:http';
import { PassThrough } from 'node:stream';

import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { JSONRPCMessageSchema, LATEST_PROTOCOL_VERSION, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runHttpBridge } from '../../src/bin/http-bridge.js';
import { createStreamableHttpHandler } from '../../src/server/transport.js';

interface OutputCapture {
  readonly stream: PassThrough;
  readonly text: () => string;
}

interface BridgeResult {
  readonly errorOutput: string;
  readonly output: string;
}

const createOutputCapture = (): OutputCapture => {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });

  return {
    stream,
    text: () => Buffer.concat(chunks).toString('utf8'),
  };
};

const createTestMcpServer = (): McpServer => {
  const server = new McpServer({ name: 'http-bridge-integration-test', version: '1.0.0' });
  server.registerTool('ping', { description: 'Returns a pong response.' }, async () => ({
    content: [{ type: 'text', text: JSON.stringify({ message: 'pong' }) }],
  }));

  return server;
};

const initializeRequest = {
  id: 1,
  jsonrpc: '2.0',
  method: 'initialize',
  params: {
    capabilities: {},
    clientInfo: { name: 'http-bridge-integration-test', version: '1.0.0' },
    protocolVersion: LATEST_PROTOCOL_VERSION,
  },
};

const initializedNotification = {
  jsonrpc: '2.0',
  method: 'notifications/initialized',
  params: {},
};

const toolsListRequest = {
  id: 2,
  jsonrpc: '2.0',
  method: 'tools/list',
  params: {},
};

const outputRecords = (output: string): JSONRPCMessage[] => {
  const lines = output.split('\n');
  if (lines.at(-1) !== '') {
    throw new Error('stdout did not end with a newline');
  }

  return lines.slice(0, -1).map((line) => JSONRPCMessageSchema.parse(JSON.parse(line)));
};

const responseWithId = (messages: readonly JSONRPCMessage[], id: number): JSONRPCMessage => {
  const response = messages.find((message) => 'id' in message && message.id === id);
  if (response === undefined) {
    throw new Error(`response ${id} was not emitted`);
  }

  return response;
};

const resultOf = (message: JSONRPCMessage): Record<string, unknown> => {
  if (!('result' in message)) {
    throw new Error('expected a JSON-RPC result response');
  }

  return message.result;
};

describe('HTTP bridge integration', () => {
  let endpoint: URL;
  let httpServer: ReturnType<typeof createServer>;

  beforeEach(async () => {
    const handler = createStreamableHttpHandler({ createServer: createTestMcpServer });
    httpServer = createServer((request, response) => {
      void handler(request, response);
    });

    await new Promise<void>((resolve) => {
      httpServer.listen(0, '127.0.0.1', resolve);
    });

    const address = httpServer.address();
    if (address === null || typeof address === 'string') {
      throw new Error('failed to bind test HTTP server');
    }

    endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => {
        if (error === undefined) {
          resolve();
          return;
        }

        reject(error);
      });
    });
  });

  const runBridge = async (inputText: string): Promise<BridgeResult> => {
    const input = new PassThrough();
    const output = createOutputCapture();
    const errorOutput = createOutputCapture();
    const bridge = runHttpBridge({
      url: endpoint,
      input,
      output: output.stream,
      errorOutput: errorOutput.stream,
      createTransport: (url) => new StreamableHTTPClientTransport(url),
    });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    input.end(inputText);
    await bridge;

    return { output: output.text(), errorOutput: errorOutput.text() };
  };

  it('forwards initialize, initialized, and tools/list through one HTTP session', async () => {
    // Given
    const input = [initializeRequest, initializedNotification, toolsListRequest]
      .map((message) => `${JSON.stringify(message)}\n`)
      .join('');

    // When
    const bridgeResult = await runBridge(input);
    const messages = outputRecords(bridgeResult.output);

    // Then
    expect(bridgeResult.errorOutput).toBe('');
    expect(resultOf(responseWithId(messages, 1))).toMatchObject({
      protocolVersion: LATEST_PROTOCOL_VERSION,
    });
    expect(resultOf(responseWithId(messages, 2))).toMatchObject({
      tools: [expect.objectContaining({ name: 'ping' })],
    });
  });

  it('reports malformed input and still forwards the following initialize request', async () => {
    // Given
    const input = `not valid JSON\n${JSON.stringify(initializeRequest)}\n`;

    // When
    const bridgeResult = await runBridge(input);
    const messages = outputRecords(bridgeResult.output);

    // Then
    expect(bridgeResult.errorOutput).toContain('Invalid JSON input');
    expect(resultOf(responseWithId(messages, 1))).toMatchObject({
      protocolVersion: LATEST_PROTOCOL_VERSION,
    });
  });

  it('writes every response as a newline-delimited valid JSON-RPC record', async () => {
    // Given
    const input = [initializeRequest, initializedNotification, toolsListRequest]
      .map((message) => `${JSON.stringify(message)}\n`)
      .join('');

    // When
    const bridgeResult = await runBridge(input);
    const lines = bridgeResult.output.split('\n');
    const records = lines.slice(0, -1);

    // Then
    expect(bridgeResult.output.endsWith('\n')).toBe(true);
    expect(records).toHaveLength(2);
    for (const record of records) {
      expect(JSONRPCMessageSchema.safeParse(JSON.parse(record)).success).toBe(true);
    }
  });
});
