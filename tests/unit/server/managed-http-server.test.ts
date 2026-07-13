import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startManagedHttpServer, type ManagedHttpServerOptions } from '../../../src/server/managed-http-server.js';
import { readProjectEndpoint, removeProjectEndpoint } from '../../../src/server/project-endpoint.js';
import type { NexusRuntime } from '../../../src/server/index.js';

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
    await rm(storageDir, { force: true, recursive: true });
  });

  it('writes the resolved loopback endpoint after listening', async () => {
    const server = await startManagedHttpServer(options);

    await expect(readProjectEndpoint(storageDir)).resolves.toMatchObject({
      pid: process.pid,
      projectRoot,
      url: server.url.toString(),
    });

    await server.close();
  });

  it('closes the runtime and removes the descriptor after the final session closes', async () => {
    const server = await startManagedHttpServer({
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

  it('returns health with instanceId and projectRoot', async () => {
    const server = await startManagedHttpServer(options);

    const res = await fetch(`${server.url.toString()}health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      instanceId: options.instanceId,
      projectRoot,
    });

    await server.close();
  });

  it('does not auto-shutdown while sessions are active', async () => {
    const server = await startManagedHttpServer({
      ...options,
      idleShutdownMs: 50,
      sessionIdleTimeoutMs: 5000,
    });

    const sessionId = await connectClient(server.url);

    // Wait long enough that a 50ms idleShutdown would fire if no sessions were open
    await new Promise((resolve) => { setTimeout(resolve, 150); });

    // Server should still be up because we have an active session
    const health = await fetch(`${server.url.toString()}health`);
    expect(health.status).toBe(200);

    await server.close();
  });
});
