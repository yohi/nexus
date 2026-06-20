import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HealthChecker } from '../../src/server/aggregator.js';

describe('HealthChecker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers(); // Restore real timers
  });

  it('evicts unhealthy nodes from the mapping', async () => {
    const nodes = new Map<number, any>([
      [9001, { projectId: 'foo', metricsPort: 9001, pid: 123 }],
      [9002, { projectId: 'bar', metricsPort: 9002, pid: 456 }],
    ]);

    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('9001')) {
        return { ok: true };
      }
      throw new Error('Network timeout');
    });

    const checker = new HealthChecker(nodes, 1000, 200, mockFetch);
    checker.start();

    // Advance time to trigger checkAll
    await vi.advanceTimersByTimeAsync(1000);

    expect(nodes.has(9001)).toBe(true);
    expect(nodes.has(9002)).toBe(false); // Evicted

    checker.stop();
  });

  it('evicts nodes that respond with non-ok status', async () => {
    const nodes = new Map<number, any>([
      [9001, { projectId: 'foo', metricsPort: 9001, pid: 123 }],
    ]);

    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });

    const checker = new HealthChecker(nodes, 1000, 200, mockFetch);
    checker.start();

    await vi.advanceTimersByTimeAsync(1000);

    expect(nodes.has(9001)).toBe(false); // Evicted due to status error
    checker.stop();
  });
});
