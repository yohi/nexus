
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createNexusServer, errorResult, toolResult, initializeNexusRuntime } from '../../../src/server/index.js';
import { PathSanitizer, PathTraversalError } from '../../../src/server/path-sanitizer.js';
import * as metricsPortUtils from '../../../src/server/metrics-port.js';
import { createMockNexusRuntimeOptions, createMockRegistry } from '../../shared/test-helpers.js';

vi.mock('../../../src/observability/metrics-server.js', () => {
  return {
    MetricsHttpServer: vi.fn().mockImplementation(() => ({
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getPort: vi.fn().mockReturnValue(undefined),
    })),
  };
});

describe('NexusServer helpers', () => {
  const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    consoleSpy.mockClear();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  describe('errorResult', () => {
    it('returns a standardized error response with isError: true', () => {
      const result = errorResult(new Error('test error'));
      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: test error' }],
        isError: true,
        structuredContent: { error: true, message: 'test error' },
      });
      expect(consoleSpy).toHaveBeenCalled();
    });

    it('sanitizes PathTraversalError to a generic message', () => {
      const error = new PathTraversalError('Access denied: path /etc/passwd is outside project root');
      const result = errorResult(error);
      expect(result.structuredContent.message).toBe('Access denied: path is outside project root');
      expect(result.content[0]!.text).toBe('Error: Access denied: path is outside project root');
    });

    it('sanitizes messages containing absolute paths', () => {
      const error = new Error('Failed to read /home/user/secret.txt');
      const result = errorResult(error);
      expect(result.structuredContent.message).toBe('Internal server error (potential path leak prevented)');
      expect(result.content[0]!.text).toBe('Error: Internal server error (potential path leak prevented)');
    });

    it('sanitizes messages containing Windows-style absolute paths', () => {
      const error = new Error('Failed to read C:\\Users\\user\\secret.txt');
      const result = errorResult(error);
      expect(result.structuredContent.message).toBe('Internal server error (potential path leak prevented)');
      expect(result.content[0]!.text).toBe('Error: Internal server error (potential path leak prevented)');
    });

    it('sanitizes messages containing directory traversal', () => {
      const error = new Error('Invalid path: ../../etc/passwd');
      const result = errorResult(error);
      expect(result.structuredContent.message).toBe('Internal server error (potential path leak prevented)');
      expect(result.content[0]!.text).toBe('Error: Internal server error (potential path leak prevented)');
    });

    it('handles non-Error objects gracefully', () => {
      const result = errorResult('string error');
      expect(result).toEqual({
        content: [{ type: 'text', text: 'Error: string error' }],
        isError: true,
        structuredContent: { error: true, message: 'string error' },
      });
    });
  });

  describe('toolResult', () => {
    it('returns a standardized response on success', () => {
      const result = toolResult({ success: true, data: [1, 2, 3] });
      expect(result).toEqual({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, data: [1, 2, 3] }, null, 2),
          },
        ],
        structuredContent: { success: true, data: [1, 2, 3] },
      });
    });

    it('handles BigInt by converting them to strings', () => {
      const input = { value: 100n, nested: { id: 200n } };
      const result = toolResult(input as any);
      
      expect(result.isError).toBeUndefined();
      expect(result.content[0]!.text).toContain('"value": "100"');
      expect(result.content[0]!.text).toContain('"id": "200"');
      expect((result.structuredContent as any).value).toBe("100");
    });

    it('returns isError: true and sanitized message when JSON.stringify fails (e.g., circular reference)', () => {
      const input: any = { a: 1 };
      input.self = input; // Circular reference
      const result = toolResult(input);
      
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('Failed to serialize structuredContent');
      expect(result.structuredContent.error).toBe(true);
    });
  });

  describe('initializeNexusRuntime shutdown', () => {
    it('throws when watcher fails to close', async () => {
      const mockOptions = createMockNexusRuntimeOptions({
        watcher: {
          start: async () => {},
          stop: async () => { throw new Error('watcher stop failed'); }
        },
        projectRoot: '/tmp',
        runReindex: async () => [],
        loadFileContent: async () => '',
      });

      const runtime = await initializeNexusRuntime(mockOptions);
      
      // Mock server.close is no longer needed because runtime.close() does not
      // close individual MCP servers; each HTTP session manages its own.

      try {
        await runtime.close();
        expect.fail('Should have thrown error');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    });
  });

  describe('initializeNexusRuntime rollback', () => {
    it('awaits pipeline.stop and watcher.stop when initialization fails', async () => {
      const stopDeferred = {
        promise: null as any as Promise<void>,
        resolve: null as any as () => void,
        called: false,
      };
      stopDeferred.promise = new Promise((resolve) => {
        stopDeferred.resolve = () => {
          stopDeferred.called = true;
          resolve();
        };
      });

      const mockPipeline = {
        start: vi.fn(),
        stop: vi.fn().mockImplementation(() => stopDeferred.promise),
        reconcileOnStartup: vi.fn().mockResolvedValue({}),
        reindex: vi.fn().mockResolvedValue({ status: 'success' as const, processed: 0, skipped: 0 }),
        getSkippedFiles: vi.fn().mockReturnValue(new Map()),
        getProgress: vi.fn().mockReturnValue({ status: 'idle' as const, processed: 0, total: 0 }),
      };
      const mockWatcher = {
        start: vi.fn().mockRejectedValue(new Error('init failure')),
        stop: vi.fn().mockResolvedValue(undefined),
      };

      const mockOptions = createMockNexusRuntimeOptions({
        pipeline: mockPipeline,
        watcher: mockWatcher,
        projectRoot: '/tmp',
      });

      const initPromise = initializeNexusRuntime(mockOptions);

      // Give it a tick to hit the catch block
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(mockPipeline.stop).toHaveBeenCalled();
      
      let rejected = false;
      initPromise.catch(() => { rejected = true; });

      await new Promise(resolve => setTimeout(resolve, 0));
      expect(rejected, 'Should not have rejected yet if pipeline.stop is awaited').toBe(false);

      stopDeferred.resolve();
      await initPromise.catch(() => {});
      expect(stopDeferred.called).toBe(true);
    });
  });

  describe('initializeNexusRuntime metricsPort cleanup', () => {
    it('calls removeMetricsPort when metrics server fails to start', async () => {
      const removeSpy = vi.spyOn(metricsPortUtils, 'removeMetricsPort').mockResolvedValue(undefined);
      const mockOptions = createMockNexusRuntimeOptions({
        metricsCollectorRegistry: createMockRegistry(), // Trigger metricsServer creation
        storageDir: '/fake/storage',
        projectRoot: '/tmp',
      });

      // We need to mock MetricsHttpServer to fail or return undefined port.
      // Since it's instantiated inside, we can't easily mock the instance.
      // But we can verify the behavior if we mock the module.
      // For now, let's assume it fails to start (throws error in start or returns undefined in getPort)
      
      // Actually, if metricsCollectorRegistry is provided, it tries to start.
      // If we don't mock MetricsHttpServer, it might actually try to start a real server.
      
      // Let's mock the module '../observability/metrics-server.js' if possible.
      // But in Vitest, we use vi.mock().
      
      // Alternatively, we can just check if removeMetricsPort is called when resolvedPort is undefined.
      // By default, our mock doesn't have a getPort method that returns something, so it will be undefined.
      
      const runtime = await initializeNexusRuntime(mockOptions);
      expect(removeSpy).toHaveBeenCalledWith('/fake/storage');
      await runtime.close();
      removeSpy.mockRestore();
    });
  });

});
