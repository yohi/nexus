import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startManagedHttpServer, type ManagedHttpServer, type ManagedHttpServerOptions } from '../../../src/server/managed-http-server.js';
import { readProjectEndpoint, writeProjectEndpoint } from '../../../src/server/project-endpoint.js';
import type { NexusRuntime } from '../../../src/server/index.js';

const trackedServers: ManagedHttpServer[] = [];

function createMockRuntime(): NexusRuntime {
  return {
    createServer: () => new McpServer({ name: 'test', version: '1.0.0' }),
    orchestrator: {} as unknown as NexusRuntime['orchestrator'],
    sanitizer: {} as unknown as NexusRuntime['sanitizer'],
    initialize: async () => {},
    close: async () => {},
    reindex: async () => {},
    registrationClient: null,
  };
}

async function trackServer(options: ManagedHttpServerOptions): Promise<ManagedHttpServer> {
  const server = await startManagedHttpServer(options);
  trackedServers.push(server);
  return server;
}

async function closeTrackedServers(): Promise<void> {
  await Promise.all(trackedServers.map((server) => server.close().catch(() => {})));
  trackedServers.length = 0;
}

async function connectClient(url: URL): Promise<string> {
  const initRes = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '1.0.0' },
      },
    }),
  });
  expect(initRes.status).toBe(200);
  const sessionId = initRes.headers.get('mcp-session-id');
  expect(sessionId).toBeTruthy();
  return sessionId!;
}

async function connectAndCloseClient(url: URL): Promise<void> {
  const sessionId = await connectClient(url);
  // Explicitly terminate the MCP session the same way src/server/transport.ts
  // handles it: a DELETE carrying the mcp-session-id header is routed to the
  // StreamableHTTPServerTransport, which tears the session down and returns 200.
  // This synchronously fires the onSessionClose callback wired up in
  // managed-http-server.ts, rather than waiting for sessionIdleTimeoutMs to fire.
  const closeRes = await fetch(url.toString(), {
    method: 'DELETE',
    headers: {
      'mcp-session-id': sessionId,
    },
  });
  expect(closeRes.status).toBe(200);
}

describe('managed-http-server', () => {
  let storageDir: string;
  let projectRoot: string;
  let options: ManagedHttpServerOptions;

  beforeEach(async () => {
    storageDir = await mkdtemp(join(tmpdir(), 'nexus-managed-http-server-'));
    projectRoot = storageDir;
    options = {
      instanceId: `test-instance-${randomUUID()}`,
      projectRoot,
      storageDir,
      runtime: createMockRuntime(),
    };
  });

  afterEach(async () => {
    await closeTrackedServers();
    await rm(storageDir, { force: true, recursive: true });
  });

  it('writes the resolved loopback endpoint after listening', async () => {
    const server = await trackServer(options);

    await expect(readProjectEndpoint(storageDir)).resolves.toMatchObject({
      pid: process.pid,
      projectRoot,
      url: server.url.toString(),
    });
  });

  it('closes the runtime and removes the descriptor after the final session closes', async () => {
    const server = await trackServer({
      ...options,
      // The explicit DELETE in connectAndCloseClient fires onSessionClose
      // synchronously, which schedules auto-shutdown after idleShutdownMs. A
      // small non-zero grace lets the DELETE's 200 response flush before
      // close() calls httpServer.closeAllConnections(); idleShutdownMs: 0 races
      // the teardown against the in-flight DELETE response and resets it.
      // Shutdown is thus driven by the explicit close, not sessionIdleTimeoutMs.
      idleShutdownMs: 50,
    });
    await connectAndCloseClient(server.url);

    await server.closed;
    await expect(readProjectEndpoint(storageDir)).resolves.toBeUndefined();
  });

  it('shuts down immediately after the final session closes when idleShutdownMs is zero', async () => {
    const server = await trackServer({
      ...options,
      idleShutdownMs: 0,
    });

    await connectAndCloseClient(server.url);
    await expect(
      Promise.race([
        server.closed.then(() => true as const),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
      ]),
    ).resolves.toBe(true);
    await expect(readProjectEndpoint(storageDir)).resolves.toBeUndefined();
  });

  it('completes shutdown when runtime close rejects', async () => {
    const runtime = createMockRuntime();
    runtime.close = async () => {
      throw new Error('runtime close failed');
    };
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const server = await trackServer({
        ...options,
        runtime,
        exitOnShutdown: false,
      });
      await expect(readProjectEndpoint(storageDir)).resolves.toMatchObject({
        instanceId: options.instanceId,
      });

      await expect(server.close()).resolves.toBeUndefined();
      await expect(server.closed).resolves.toBeUndefined();
      await expect(readProjectEndpoint(storageDir)).resolves.toBeUndefined();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      consoleError.mockRestore();
    }
  });

  it('preserves a descriptor published by a replacement instance during shutdown', async () => {
    const server = await trackServer(options);
    const replacement = {
      instanceId: `replacement-${randomUUID()}`,
      pid: process.pid + 1,
      projectRoot,
      url: 'http://127.0.0.1:43124',
    };

    await writeProjectEndpoint(storageDir, replacement);

    await server.close();

    await expect(readProjectEndpoint(storageDir)).resolves.toEqual(replacement);
  });

  it('returns health with instanceId and projectRoot', async () => {
    const server = await trackServer(options);

    const res = await fetch(new URL('/health', server.url).toString());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      instanceId: options.instanceId,
      projectRoot,
    });
  });

  it('does not auto-shutdown while sessions are active', async () => {
    const server = await trackServer({
      ...options,
      idleShutdownMs: 50,
      sessionIdleTimeoutMs: 5000,
    });

    const sessionId = await connectClient(server.url);

    // Wait long enough that a 50ms idleShutdown would fire if no sessions were open
    await new Promise((resolve) => { setTimeout(resolve, 150); });

    // Server should still be up because we have an active session
    const health = await fetch(new URL('/health', server.url).toString());
    expect(health.status).toBe(200);

    await fetch(server.url.toString(), {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId },
    });
  });

  it('shuts down after startupGraceMs when no client connects', async () => {
    const server = await trackServer({
      ...options,
      startupGraceMs: 50,
      exitOnShutdown: false,
    });

    await server.closed;
    await expect(readProjectEndpoint(storageDir)).resolves.toBeUndefined();
  });

  it('cancels startupGraceMs when a client connects', async () => {
    const server = await trackServer({
      ...options,
      startupGraceMs: 1_000,
      idleShutdownMs: 5000,
    });

    const sessionId = await connectClient(server.url);

    await new Promise((resolve) => { setTimeout(resolve, 1_200); });

    const health = await fetch(new URL('/health', server.url).toString());
    expect(health.status).toBe(200);

    await fetch(server.url.toString(), {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId },
    });
  });

  // Nexus #297: owned Endpoint and PID are removed under the live writer lease, i.e. BEFORE runtime.close() (which
  // closes stores and releases the lease last). Foreign descriptors/PIDs are never removed.
  describe('owner-safe shutdown order (Nexus #297)', () => {
    const exists = async (p: string): Promise<boolean> => await lstat(p).then(() => true, () => false);
    const endpointPath = () => join(storageDir, 'endpoint.json');
    const pidPath = () => join(storageDir, 'nexus.pid');

    it('removes the owned Endpoint and PID before closing the runtime', async () => {
      const observed: Array<{ endpoint: boolean; pid: boolean }> = [];
      const runtime = { ...createMockRuntime(), close: vi.fn(async () => {
        observed.push({ endpoint: await exists(endpointPath()), pid: await exists(pidPath()) });
      }) };
      const server = await trackServer({ ...options, runtime });
      await writeFile(pidPath(), `${process.pid}\n`);
      expect(await exists(endpointPath())).toBe(true);
      await server.close();
      expect(runtime.close).toHaveBeenCalledOnce();
      expect(observed).toEqual([{ endpoint: false, pid: false }]);
    });

    it('swallows Endpoint/PID cleanup and runtime close errors and still closes the runtime', async () => {
      const runtime = { ...createMockRuntime(), close: vi.fn(() => Promise.reject(new Error('close failed'))) };
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const server = await trackServer({ ...options, runtime });
      await rm(endpointPath());
      await mkdir(endpointPath()); // reading the descriptor now fails (EISDIR)
      await mkdir(pidPath()); // reading the PID file now fails (EISDIR)
      await expect(server.close()).resolves.toBeUndefined();
      await expect(server.closed).resolves.toBeUndefined();
      expect(runtime.close).toHaveBeenCalledOnce();
      expect(await exists(endpointPath())).toBe(true);
      expect(await exists(pidPath())).toBe(true);
      consoleError.mockRestore();
    });

    it('keeps a foreign Endpoint and a foreign PID on managed close', async () => {
      const runtime = { ...createMockRuntime(), close: vi.fn(async () => {}) };
      const server = await trackServer({ ...options, runtime });
      await writeProjectEndpoint(storageDir, {
        instanceId: 'foreign-instance', pid: 2_147_483_000, projectRoot, url: 'http://127.0.0.1:9/',
      });
      await writeFile(pidPath(), '2147483000\n');
      const foreignEndpoint = await readFile(endpointPath(), 'utf8');
      await server.close();
      expect(runtime.close).toHaveBeenCalledOnce();
      expect(await readFile(endpointPath(), 'utf8')).toBe(foreignEndpoint);
      expect(await readFile(pidPath(), 'utf8')).toBe('2147483000\n');
    });
  });
});
