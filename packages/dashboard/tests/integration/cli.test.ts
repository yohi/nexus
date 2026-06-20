import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { main } from '../../src/cli.js';
import { AggregatorServer } from '../../src/server/aggregator.js';

// We mock ink rendering to check if cli setup succeeds without blocking
vi.mock('ink', () => ({
  render: () => ({
    waitUntilExit: () => Promise.resolve(),
  }),
}));

describe('cli integration', () => {
  let startSpy: ReturnType<typeof vi.spyOn>;
  let stopSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    startSpy = vi.spyOn(AggregatorServer.prototype, 'start').mockResolvedValue(undefined);
    stopSpy = vi.spyOn(AggregatorServer.prototype, 'stop').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts and stops AggregatorServer when running dashboard CLI', async () => {
    process.argv = ['node', 'cli.js', '--project-root', './', '--port', '9500', '--aggregator-port', '9470'];
    await main();

    expect(startSpy).toHaveBeenCalledWith(9470);
    expect(stopSpy).toHaveBeenCalled();
  });

  it('tolerates EADDRINUSE during AggregatorServer startup and continues running', async () => {
    const error = new Error('Address already in use');
    (error as any).code = 'EADDRINUSE';
    startSpy.mockRejectedValue(error);

    process.argv = ['node', 'cli.js', '--project-root', './', '--port', '9500', '--aggregator-port', '9470'];

    // Should not throw, should resolve successfully
    await expect(main()).resolves.toBeUndefined();
    expect(startSpy).toHaveBeenCalledWith(9470);
    expect(stopSpy).toHaveBeenCalled();
  });

  it('exits when aggregator port is invalid', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    process.argv = ['node', 'cli.js', '--project-root', './', '--port', '9500', '--aggregator-port', 'abc'];

    await expect(main()).rejects.toThrow('process.exit');
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid --aggregator-port value "abc"'));
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(startSpy).not.toHaveBeenCalled();
  });
});
