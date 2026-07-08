import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeNexusRuntime } from '../../../src/server/index.js';
import { createMockNexusRuntimeOptions, createMockRegistry } from '../../shared/test-helpers.js';

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
const mockMetricsStart = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../../../src/observability/metrics-server.js', () => {
  return {
    MetricsHttpServer: vi.fn().mockImplementation(() => ({
      start: mockMetricsStart,
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

describe('initializeNexusRuntime aggregator registration in package mode', () => {
  beforeEach(() => {
    mockState.metricsPort = undefined;
    mockState.registrationConfigs = [];
    mockRegistrationStart.mockClear();
    mockRegistrationStop.mockClear();
    mockMetricsStart.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('skips aggregator registration when packageMode is true (metrics port still resolves)', async () => {
    // metrics port resolves, so WITHOUT the guard the RegistrationClient would be created.
    mockState.metricsPort = 43123;
    const mockOptions = createMockNexusRuntimeOptions({
      projectRoot: path.join(process.cwd(), 'test-project'),
      metricsCollectorRegistry: createMockRegistry(),
      packageMode: true,
    });

    const runtime = await initializeNexusRuntime(mockOptions);

    expect(mockState.registrationConfigs).toEqual([]);
    expect(mockRegistrationStart).not.toHaveBeenCalled();
    expect(runtime.registrationClient ?? null).toBeNull();
    // Constraint (c): the local metrics HTTP server must still start in package mode
    // (only the external aggregator registration is skipped).
    expect(mockMetricsStart).toHaveBeenCalled();
    await runtime.close();
  });

  it('registers with the aggregator when packageMode is false', async () => {
    mockState.metricsPort = 43123;
    const mockOptions = createMockNexusRuntimeOptions({
      projectRoot: path.join(process.cwd(), 'test-project'),
      metricsCollectorRegistry: createMockRegistry(),
      packageMode: false,
    });

    const runtime = await initializeNexusRuntime(mockOptions);

    expect(mockState.registrationConfigs).toHaveLength(1);
    expect(mockRegistrationStart).toHaveBeenCalledTimes(1);
    await runtime.close();
  });
});
