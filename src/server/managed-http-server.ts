import { createServer } from 'node:http';
import { releaseProcessLock } from './process-lock.js';
import { createStreamableHttpHandler } from './transport.js';
import {
  writeProjectEndpoint,
  removeProjectEndpointIfMatching,
  type ProjectEndpoint,
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
  let endpoint: ProjectEndpoint | undefined;

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
      if (startupGraceTimer) {
        clearTimeout(startupGraceTimer);
        startupGraceTimer = undefined;
      }
      if (shutdownTimer) {
        clearTimeout(shutdownTimer);
        shutdownTimer = undefined;
      }
    },
    onSessionClose: () => {
      activeSessions = Math.max(0, activeSessions - 1);
      if (activeSessions === 0 && !isClosing && options.idleShutdownMs !== undefined && options.idleShutdownMs > 0) {
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

    if (req.method === 'GET' && req.url === '/') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Allow', 'POST, DELETE');
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
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
    await mcpHandler.dispose();

    await options.runtime.close();
    if (endpoint) {
      await removeProjectEndpointIfMatching(options.storageDir, endpoint);
    }

    // Release the process-level single-instance lock (nexus.pid) before any
    // process.exit() call below. process.exit() terminates synchronously and
    // would otherwise skip this cleanup entirely, leaving a stale lock file
    // behind (design requirement: descriptor AND process lock must both be
    // removed on shutdown).
    await releaseProcessLock(options.storageDir).catch(() => {});
    resolveClosed();

    if (options.exitOnShutdown) {
      process.exit(0);
    }
  };

  const listenPromise = new Promise<URL>((resolve, reject) => {
    httpServer.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = httpServer.address();
      if (!address || typeof address !== 'object') {
        reject(new Error('Failed to determine server address'));
        return;
      }

      resolve(new URL(`http://127.0.0.1:${address.port}`));
    });

    httpServer.on('error', (error) => {
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });

  try {
    const url = await listenPromise;

    endpoint = {
      instanceId: options.instanceId,
      pid: process.pid,
      projectRoot: options.projectRoot,
      url: url.toString(),
    };
    await writeProjectEndpoint(options.storageDir, endpoint);

    if (options.startupGraceMs !== undefined) {
      startupGraceTimer = setTimeout(() => {
        if (activeSessions === 0) {
          void close();
        }
      }, options.startupGraceMs);
    }

    return {
      url,
      instanceId: options.instanceId,
      closed,
      close,
    };
  } catch (error) {
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    throw error instanceof Error ? error : new Error(String(error));
  }
}
