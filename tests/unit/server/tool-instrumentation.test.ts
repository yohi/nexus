import { describe, it, expect, vi } from 'vitest';
import { withToolMetrics } from '../../../src/server/tool-instrumentation.js';
import { createMockMetricsHooks } from '../../shared/test-helpers.js';

describe('withToolMetrics', () => {
  it('logs success status and records latency for successful tool calls', async () => {
    const mockHooks = createMockMetricsHooks();
    const handler = vi.fn().mockResolvedValue({ isError: false, content: [] });
    
    const instrumented = withToolMetrics('test_tool', mockHooks, handler);
    const result = await instrumented('arg1', 2);

    expect(result).toEqual({ isError: false, content: [] });
    expect(handler).toHaveBeenCalledWith('arg1', 2);
    expect(mockHooks.onToolCall).toHaveBeenCalledWith('test_tool', 'success', expect.any(Number));
  });

  it('logs error status when tool handler returns an object with isError: true', async () => {
    const mockHooks = createMockMetricsHooks();
    const handler = vi.fn().mockResolvedValue({ isError: true, content: [] });

    const instrumented = withToolMetrics('test_tool', mockHooks, handler);
    const result = await instrumented('arg1');

    expect(result).toEqual({ isError: true, content: [] });
    expect(mockHooks.onToolCall).toHaveBeenCalledWith('test_tool', 'error', expect.any(Number));
  });

  it('logs error status and records latency for failed tool calls that throw', async () => {
    const mockHooks = createMockMetricsHooks();
    const handler = vi.fn().mockRejectedValue(new Error('failure'));

    const instrumented = withToolMetrics('test_tool', mockHooks, handler);
    await expect(instrumented('arg1')).rejects.toThrow('failure');
    expect(mockHooks.onToolCall).toHaveBeenCalledWith('test_tool', 'error', expect.any(Number));
  });

  it('passes through directly if hooks are undefined', async () => {
    const handler = vi.fn().mockResolvedValue({ isError: false, content: [] });
    const instrumented = withToolMetrics('test_tool', undefined, handler);
    const result = await instrumented('arg1');
    expect(result).toEqual({ isError: false, content: [] });
  });
});
