import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RegistrationClient } from '../../../src/observability/registration-client.js';

describe('RegistrationClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers(); // Restore real timers
  });

  it('triggers immediate registration on start and sends periodic heartbeats', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    const payload = { projectId: 'test', metricsPort: 8080, pid: 123 };
    const config = { aggregatorPort: 9470, heartbeatIntervalMs: 1000, requestTimeoutMs: 200 };

    const client = new RegistrationClient(payload, config, mockFetch);
    client.start();

    // Verify immediate registration trigger
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:9470/api/discovery/register',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(payload)
      })
    );

    // Verify heartbeat tick
    await vi.advanceTimersByTimeAsync(1000);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    client.stop();
  });
});
