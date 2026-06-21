import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeNexusRuntime } from '../../../src/server/index.js';
import { createMockNexusRuntimeOptions } from '../../shared/test-helpers.js';

interface MockState {
  metricsPort: number | undefined;
  registrationConfigs: unknown[];
}

const mockState = vi.hoisted<MockState>(() => ({
  metricsPort: undefined,
  registrationConfigs: [],
}));

const mockRegistrationStart = vi.hoisted(() => vi.fn());
const mockRegistrationStop = vi.hoisted(() => vi.fn());

vi.mock('../../../src/observability/metrics-server.js', () => {
  return {
    MetricsHttpServer: vi.fn().mockImplementation(() => ({
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getPort: vi.fn(() => mockState.metricsPort),
    })),
  };
});

vi.mock('../../../src/observability/registration-client.js', () => {
  return {
    RegistrationClient: vi.fn().mockImplementation((_payload: unknown, config: unknown) => {
      mockState.registrationConfigs.push(config);
      return {
        start: mockRegistrationStart,
        stop: mockRegistrationStop,
      };
    }),
  };
});

describe('initializeNexusRuntime telemetry registration defaults', () => {
  beforeEach(() => {
    mockState.metricsPort = undefined;
    mockState.registrationConfigs = [];
    mockRegistrationStart.mockClear();
    mockRegistrationStop.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses default aggregator port when metrics server resolves a port and config omits aggregatorPort', async () => {
    mockState.metricsPort = 43123;
    const mockOptions = createMockNexusRuntimeOptions({
      projectRoot: path.join(process.cwd(), 'test-project'),
      metricsCollectorRegistry: {} as any,
    });

    const runtime = await initializeNexusRuntime(mockOptions);

    expect(mockState.registrationConfigs).toEqual([
      { aggregatorPort: 9470, heartbeatIntervalMs: 30000, requestTimeoutMs: 1000 },
    ]);
    expect(mockRegistrationStart).toHaveBeenCalledTimes(1);
    await runtime.close();
  });
});
