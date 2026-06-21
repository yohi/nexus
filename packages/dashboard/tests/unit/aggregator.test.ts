import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { AggregatorServer } from '../../src/server/aggregator.js';

const getListeningPort = (server: AggregatorServer): number => {
  const port = server.listeningPort;
  if (port === undefined) {
    throw new Error('AggregatorServer is not listening');
  }
  return port;
};

const getServerAddressPort = (address: string | AddressInfo | null): number => {
  if (address && typeof address === 'object') {
    return address.port;
  }
  throw new Error('Server is not listening on a TCP port');
};

describe('AggregatorServer', () => {
  let server: AggregatorServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = null;
    }
  });

  it('accepts node registrations and exposes node information', async () => {
    server = new AggregatorServer();
    await server.start(0);
    const serverPort = getListeningPort(server);

    const registerRes = await fetch(`http://127.0.0.1:${serverPort}/api/discovery/register`, {
      method: 'POST',
      body: JSON.stringify({
        projectId: 'test-project',
        metricsPort: 9500,
        pid: 999
      })
    });
    expect(registerRes.status).toBe(201);

    const nodesRes = await fetch(`http://127.0.0.1:${serverPort}/api/discovery/nodes`);
    const nodes = await nodesRes.json();
    expect(nodes).toEqual([
      {
        projectId: 'test-project',
        metricsPort: 9500,
        pid: 999,
        registeredAt: expect.any(Number)
      }
    ]);
  });

  it('tolerates stop() calls when start() failed and server is partially initialized', async () => {
    // We start on an in-use port to cause failure
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()));
    const port = getServerAddressPort(blocker.address());

    server = new AggregatorServer();
    // Start should reject due to EADDRINUSE (port already bound)
    await expect(server.start(port)).rejects.toThrow();

    // Now stop() should resolve safely without throwing EADDRINUSE or server not listening errors
    await expect(server.stop()).resolves.toBeUndefined();

    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });

  it('skips nodes that return non-array metrics JSON', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue(null),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue([
          {
            name: 'nexus_valid_metric_total',
            help: 'Valid metric',
            type: 'counter',
            values: [{ labels: { project: 'test-project', pid: '999' }, value: 1 }],
          },
        ]),
      });
    server = new AggregatorServer(mockFetch);
    await server.start(0);
    const serverPort = getListeningPort(server);

    await fetch(`http://127.0.0.1:${serverPort}/api/discovery/register`, {
      method: 'POST',
      body: JSON.stringify({
        projectId: 'test-project',
        metricsPort: 9500,
        pid: 999,
      }),
    });

    await fetch(`http://127.0.0.1:${serverPort}/api/discovery/register`, {
      method: 'POST',
      body: JSON.stringify({
        projectId: 'test-project',
        metricsPort: 9501,
        pid: 1000,
      }),
    });

    const metricsRes = await fetch(`http://127.0.0.1:${serverPort}/metrics`);
    expect(metricsRes.status).toBe(200);
    expect(await metricsRes.text()).toContain('nexus_valid_metric_total');
  });

  it('rejects oversized registration payloads with 413', async () => {
    server = new AggregatorServer();
    await server.start(0);
    const serverPort = getListeningPort(server);

    const payload = 'x'.repeat(70 * 1024);
    const response = await fetch(`http://127.0.0.1:${serverPort}/api/discovery/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });

    expect(response.status).toBe(413);

    const nodesRes = await fetch(`http://127.0.0.1:${serverPort}/api/discovery/nodes`);
    expect(await nodesRes.json()).toEqual([]);
  });

  it('skips malformed metric values and keeps valid metrics', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue([
          {
            name: 'nexus_invalid_metric_total',
            help: 'Invalid metric',
            type: 'counter',
            values: [{ labels: { project: 'test-project', pid: '999' }, value: 'NaN' }],
          },
        ]),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue([
          {
            name: 'nexus_valid_metric_total',
            help: 'Valid metric',
            type: 'counter',
            values: [{ labels: { project: 'test-project', pid: '1000' }, value: 1 }],
          },
        ]),
      });

    server = new AggregatorServer(mockFetch);
    await server.start(0);
    const serverPort = getListeningPort(server);

    await fetch(`http://127.0.0.1:${serverPort}/api/discovery/register`, {
      method: 'POST',
      body: JSON.stringify({ projectId: 'test-project', metricsPort: 9500, pid: 999 }),
    });
    await fetch(`http://127.0.0.1:${serverPort}/api/discovery/register`, {
      method: 'POST',
      body: JSON.stringify({ projectId: 'test-project', metricsPort: 9501, pid: 1000 }),
    });

    const metricsRes = await fetch(`http://127.0.0.1:${serverPort}/metrics`);
    const body = await metricsRes.text();

    expect(metricsRes.status).toBe(200);
    expect(body).toContain('nexus_valid_metric_total');
    expect(body).not.toContain('nexus_invalid_metric_total');
  });
});
