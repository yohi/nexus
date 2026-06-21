import { describe, it, expect, afterEach, vi } from 'vitest';
import { createServer } from 'node:http';
import { AggregatorServer } from '../../src/server/aggregator.js';

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
    const serverPort = (server as any).server.address().port;

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
    const port = (blocker.address() as any).port;

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
    const serverPort = (server as any).server.address().port;

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
});
