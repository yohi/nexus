import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

export interface StreamableHttpHandlerOptions {
  createServer: () => McpServer;
}

interface SessionEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export const createStreamableHttpHandler = ({ createServer }: StreamableHttpHandlerOptions) => {
  const sessions = new Map<string, SessionEntry>();

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const sessionIdHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;
    const body = await readBody(req);

    try {
      let entry = sessionId ? sessions.get(sessionId) : undefined;

      if (!entry) {
        if (!isInitializeRequest(body)) {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'invalid session' }, id: null }));
          return;
        }

        const server = createServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (createdSessionId) => {
            sessions.set(createdSessionId, { server, transport });
          },
        });

        transport.onclose = () => {
          const activeId = transport.sessionId;
          if (activeId) {
            sessions.delete(activeId);
          }
          void server.close();
        };

        await server.connect(transport);
        entry = { server, transport };
      }

      await entry.transport.handleRequest(req, res, body);
    } catch (error) {
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
          id: null,
        }),
      );
    }
  };
};

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  if (req.method === 'GET' || req.method === 'DELETE') {
    return undefined;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return undefined;
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
};
