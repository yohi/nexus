import { createServer } from 'node:http';
import { isProcessAlive, releaseOwnedProcessLock } from './process-lock.js';
import { createStreamableHttpHandler } from './transport.js';
import {
  inspectProjectEndpoint,
  writeProjectEndpoint,
  removeProjectEndpointIfMatching,
  type ProjectEndpoint,
} from './project-endpoint.js';
import type { NexusRuntime } from './index.js';

export interface ManagedHttpServerOptions {
  instanceId: string;
  projectRoot: string;
  storageDir: string;
  /**
   * Internal (Nexus #297): `storageTargetsFingerprint()` of the targets this runtime holds a WriterAdmission for. It is
   * published in the Endpoint so a discovery-only Bridge reuses this runtime only for the same three effective targets.
   */
  storageTargetsFingerprint: string;
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

const STALE_ENDPOINT_HEALTH_TIMEOUT_MS = 1_000;

async function endpointAnswersHealth(endpoint: ProjectEndpoint): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STALE_ENDPOINT_HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(new URL('/health', endpoint.url), { signal: controller.signal });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as Record<string, unknown> | null;
    return body !== null && body.instanceId === endpoint.instanceId && body.projectRoot === endpoint.projectRoot;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Nexus #297 (Design §4.4 F-001): only the managed child, while it holds its WriterAdmission for these targets, may
 * clean up a stale SAME-OWNER descriptor, and only by compare-before-delete. A foreign, unverifiable or still-live
 * descriptor is never deleted or overwritten: publication refuses instead. Callers must invoke this only after
 * authentic writer admission (managed mode in `nexus.ts`).
 */
async function clearStaleSameOwnerEndpoint(storageDir: string, projectRoot: string): Promise<void> {
  const existing = await inspectProjectEndpoint(storageDir);
  if (existing.state === 'absent') {
    return;
  }
  if (existing.state === 'invalid') {
    throw new Error('Refusing to replace an unverifiable endpoint descriptor');
  }
  const stale = existing.endpoint;
  if (stale.projectRoot !== projectRoot) {
    throw new Error('Refusing to replace an endpoint descriptor owned by a different project');
  }
  if (isProcessAlive(stale.pid) && (await endpointAnswersHealth(stale))) {
    throw new Error('Refusing to replace the endpoint descriptor of a live managed runtime');
  }
  await removeProjectEndpointIfMatching(storageDir, stale);
  if ((await inspectProjectEndpoint(storageDir)).state !== 'absent') {
    throw new Error('Endpoint descriptor changed during stale cleanup');
  }
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

    // Nexus #297 shutdown order: work has stopped above; remove only the OWNED Endpoint and nexus.pid while the
    // writer lease is still live, then close the runtime, which closes stores and releases the lease last. All of
    // this runs before any process.exit() below, which would otherwise skip the cleanup.
    if (endpoint) {
      await removeProjectEndpointIfMatching(options.storageDir, endpoint).catch((error: unknown) => {
        console.error('[Endpoint Cleanup Error]', error);
      });
    }
    await releaseOwnedProcessLock(options.storageDir).catch(() => {});
    await options.runtime.close().catch((error: unknown) => {
      console.error('[Runtime Close Error]', error);
    });
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

    await clearStaleSameOwnerEndpoint(options.storageDir, options.projectRoot);
    const published: ProjectEndpoint = {
      instanceId: options.instanceId,
      pid: process.pid,
      projectRoot: options.projectRoot,
      url: url.toString(),
      storageTargetsFingerprint: options.storageTargetsFingerprint,
    };
    await writeProjectEndpoint(options.storageDir, published);
    endpoint = published;

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
