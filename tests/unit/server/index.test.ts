
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createNexusServer, errorResult, toolResult, initializeNexusRuntime, type NexusRuntimeOptions } from '../../../src/server/index.js';
import { PathSanitizer, PathTraversalError } from '../../../src/server/path-sanitizer.js';

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
      expect(result.structuredContent.message).toBe('Internal server error');
    });

    it('sanitizes messages containing Windows-style absolute paths', () => {
      const error = new Error('Failed to read C:\\Users\\user\\secret.txt');
      const result = errorResult(error);
      expect(result.structuredContent.message).toBe('Internal server error');
    });

    it('sanitizes messages containing directory traversal', () => {
      const error = new Error('Invalid path: ../../etc/passwd');
      const result = errorResult(error);
      expect(result.structuredContent.message).toBe('Internal server error');
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

    it('returns isError: true and sanitized message when JSON.stringify fails', () => {
      // BigInt cannot be serialized to JSON and will throw
      const input = { value: 100n };
      const result = toolResult(input as any);
      
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain('Failed to serialize structuredContent');
      expect(result.content[0]!.text).toContain('BigInt');
      expect(result.structuredContent.error).toBe(true);
      expect(result.structuredContent.originalType).toBe('object');
    });
  });

  describe('initializeNexusRuntime shutdown', () => {
    it('throws AggregateError if both watcher and server fail to close', async () => {
      const mockOptions = {
        metadataStore: { initialize: async () => {} },
        vectorStore: { initialize: async () => {} },
        pipeline: {
          reconcileOnStartup: async () => ({}),
          start: vi.fn(),
          stop: vi.fn().mockResolvedValue(undefined),
        },
        watcher: {
          start: async () => {},
          stop: async () => { throw new Error('watcher stop failed'); }
        },
        projectRoot: '/tmp',
        sanitizer: {} as any,
        semanticSearch: {} as any,
        grepEngine: {} as any,
        orchestrator: {} as any,
        pluginRegistry: {} as any,
        runReindex: async () => [],
        loadFileContent: async () => '',
      } as unknown as NexusRuntimeOptions;

      const runtime = await initializeNexusRuntime(mockOptions);
      
      // Mock server.close to fail
      // Since createNexusServer is called internally, we can't easily mock the server instance
      // But we can verify it calls close on the server.
      // Actually, createNexusServer returns a real McpServer.
      // We can use vi.spyOn on McpServer prototype or just trust the logic if we can't easily mock it.
      
      // Let's try to mock the server.close by patching the runtime object
      const originalServerClose = runtime.server.close;
      runtime.server.close = async () => { throw new Error('server close failed'); };

      try {
        await runtime.close();
        expect.fail('Should have thrown AggregateError');
      } catch (error) {
        expect(error).toBeInstanceOf(AggregateError);
        const aggErr = error as AggregateError;
        expect(aggErr.errors).toHaveLength(2);
        expect(aggErr.errors[0].message).toBe('watcher stop failed');
        expect(aggErr.errors[1].message).toBe('server close failed');
      } finally {
        runtime.server.close = originalServerClose;
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
      };
      const mockWatcher = {
        start: vi.fn().mockRejectedValue(new Error('init failure')),
        stop: vi.fn().mockResolvedValue(undefined),
      };

      const mockOptions = {
        metadataStore: { initialize: vi.fn().mockResolvedValue(undefined) },
        vectorStore: { initialize: vi.fn().mockResolvedValue(undefined) },
        pipeline: mockPipeline,
        watcher: mockWatcher,
        projectRoot: '/tmp',
        sanitizer: {} as any,
        semanticSearch: {} as any,
        grepEngine: {} as any,
        orchestrator: {} as any,
        pluginRegistry: {} as any,
        runReindex: vi.fn(),
        loadFileContent: vi.fn(),
      } as any;

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
});
