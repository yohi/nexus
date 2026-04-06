import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

export interface StreamableHttpHandlerOptions {
  createServer: () => McpServer;
  sessionIdleTimeoutMs?: number;
  sessionCleanupIntervalMs?: number;
}

export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

interface SessionEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
  inFlightRequests: number;
  closed: boolean;
}

export const createStreamableHttpHandler = ({
  createServer,
  sessionIdleTimeoutMs = 30 * 60 * 1000,
  sessionCleanupIntervalMs = 5 * 60 * 1000,
}: StreamableHttpHandlerOptions) => {
  const sessions = new Map<string, SessionEntry>();

  const closeEntry = async (sessionId: string, entry: SessionEntry): Promise<void> => {
    if (entry.closed) {
      sessions.delete(sessionId);
      return;
    }

    entry.closed = true;
    sessions.delete(sessionId);
    await entry.server.close();
  };

  const interval = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, entry] of sessions.entries()) {
      if (entry.inFlightRequests === 0 && now - entry.lastActivity > sessionIdleTimeoutMs) {
        void closeEntry(sessionId, entry);
      }
    }
  }, sessionCleanupIntervalMs);

  interval.unref();

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const sessionIdHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

    let body: unknown;
    try {
      body = await readBody(req);
    } catch (error) {
      const statusCode = error instanceof HttpError ? error.statusCode : 400;
      const message = error instanceof Error ? error.message : 'Invalid request body';
      res.statusCode = statusCode;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message }, id: null }));
      return;
    }

    try {
      let entry = sessionId ? sessions.get(sessionId) : undefined;

      if (entry) {
        if (entry.closed) {
          sessions.delete(sessionId!);
          entry = undefined;
        } else {
        entry.lastActivity = Date.now();
        }
      } else {
        if (!isInitializeRequest(body)) {
          res.statusCode = 400;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'invalid session' }, id: null }));
          return;
        }

        const server = createServer();
        let createdEntry: SessionEntry | undefined;
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (createdSessionId) => {
            if (createdEntry) {
              sessions.set(createdSessionId, createdEntry);
            }
          },
        });

        createdEntry = {
          server,
          transport,
          lastActivity: Date.now(),
          inFlightRequests: 0,
          closed: false,
        };

        transport.onclose = () => {
          createdEntry.closed = true;
          const activeId = transport.sessionId;
          if (activeId) {
            sessions.delete(activeId);
          }
        };

        await server.connect(transport);
        entry = createdEntry;
      }

      if (!entry) {
        throw new HttpError(400, 'invalid session');
      }

      entry.inFlightRequests += 1;
      try {
        await entry.transport.handleRequest(req, res, body);
      } finally {
        entry.inFlightRequests = Math.max(0, entry.inFlightRequests - 1);
        entry.lastActivity = Date.now();

        const activeSessionId = entry.transport.sessionId;
        if (activeSessionId && !entry.closed) {
          sessions.set(activeSessionId, entry);
        }
      }
    } catch (error) {
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      res.statusCode = statusCode;
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

const MAX_BODY_SIZE = 1 * 1024 * 1024; // 1 MB

const readBody = async (req: IncomingMessage): Promise<unknown> => {
  if (req.method === 'GET' || req.method === 'DELETE') {
    return undefined;
  }

  const chunks: Buffer[] = [];
  let totalSize = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalSize += buffer.length;

    if (totalSize > MAX_BODY_SIZE) {
      throw new HttpError(413, 'Payload Too Large: Request body exceeds 1MB limit');
    }

    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return undefined;
  }

  const rawBody = Buffer.concat(chunks as Uint8Array[]).toString('utf8');
  try {
    return JSON.parse(rawBody) as unknown;
  } catch (error) {
    throw new HttpError(400, `Invalid JSON body: ${error instanceof Error ? error.message : String(error)}`);
  }
};
