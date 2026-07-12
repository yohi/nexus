import { createServer } from 'node:http';
import { releaseProcessLock } from './process-lock.js';
import { createStreamableHttpHandler } from './transport.js';
import {
  writeProjectEndpoint,
  removeProjectEndpoint,
} from './project-endpoint.js';
import type { NexusRuntime } from './index.js';

export interface ManagedHttpServerOptions {
  instanceId: string;
  projectRoot: string;
  storageDir: string;
  runtime: NexusRuntime;
  port?: number;
  idleShutdownMs?: number;
  startupGraceMs?: number;
  sessionIdleTimeoutMs?: number;
  sessionCleanupIntervalMs?: number;
  exitOnShutdown?: boolean;
}

export interface ManagedHttpServer {
  url: URL;
  instanceId: string;
  closed: Promise<void>;
  close(): Promise<void>;
}

export async function startManagedHttpServer(
  options: ManagedHttpServerOptions,
): Promise<ManagedHttpServer> {
  let activeSessions = 0;
  let shutdownTimer: NodeJS.Timeout | undefined;
  let startupGraceTimer: NodeJS.Timeout | undefined;
  let isClosing = false;

  let resolveClosed: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const mcpHandler = createStreamableHttpHandler({
    createServer: () => options.runtime.createServer(),
    sessionIdleTimeoutMs: options.sessionIdleTimeoutMs,
    sessionCleanupIntervalMs: options.sessionCleanupIntervalMs,
    onSessionOpen: () => {
      activeSessions += 1;
      if (shutdownTimer) {
        clearTimeout(shutdownTimer);
        shutdownTimer = undefined;
      }
    },
    onSessionClose: () => {
      activeSessions = Math.max(0, activeSessions - 1);
      if (activeSessions === 0 && !isClosing && options.idleShutdownMs !== undefined) {
        shutdownTimer = setTimeout(() => {
          void close();
        }, options.idleShutdownMs);
      }
    },
  });

  const httpServer = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        instanceId: options.instanceId,
        projectRoot: options.projectRoot,
      }));
      return;
    }

    mcpHandler(req, res).catch((error: unknown) => {
      console.error('[MCP Handler Unhandled Error]', error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });
  });

  const close = async (): Promise<void> => {
    if (isClosing) {
      return;
    }
    isClosing = true;

    if (shutdownTimer) {
      clearTimeout(shutdownTimer);
      shutdownTimer = undefined;
    }
    if (startupGraceTimer) {
      clearTimeout(startupGraceTimer);
      startupGraceTimer = undefined;
    }

    httpServer.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });

    await options.runtime.close();
    await removeProjectEndpoint(options.storageDir);
    await releaseProcessLock(options.storageDir).catch(() => {});

    resolveClosed();

    if (options.exitOnShutdown) {
      process.exit(0);
    }
  };

  return new Promise<ManagedHttpServer>((resolve, reject) => {
    httpServer.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = httpServer.address();
      if (!address || typeof address !== 'object') {
        reject(new Error('Failed to determine server address'));
        return;
      }

      const url = new URL(`http://127.0.0.1:${address.port}`);

      writeProjectEndpoint(options.storageDir, {
        instanceId: options.instanceId,
        pid: process.pid,
        projectRoot: options.projectRoot,
        url: url.toString(),
      })
        .then(() => {
          if (options.startupGraceMs !== undefined) {
            startupGraceTimer = setTimeout(() => {
              if (activeSessions === 0) {
                void close();
              }
            }, options.startupGraceMs);
          }

          resolve({
            url,
            instanceId: options.instanceId,
            closed,
            close,
          });
        })
        .catch((error) => {
          httpServer.close(() => {
            reject(error instanceof Error ? error : new Error(String(error)));
          });
        });
    });

    httpServer.on('error', (error) => {
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}
