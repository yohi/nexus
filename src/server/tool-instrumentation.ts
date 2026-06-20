import type { MetricsHooks } from '../observability/types.js';

export function withToolMetrics<TArgs extends unknown[], TResult extends { isError?: boolean }>(
  toolName: string,
  hooks: MetricsHooks | undefined,
  handler: (...args: TArgs) => Promise<TResult>,
): (...args: TArgs) => Promise<TResult> {
  if (!hooks) return handler;

  return async (...args: TArgs): Promise<TResult> => {
    const start = performance.now();
    try {
      const result = await handler(...args);
      const status = result.isError ? 'error' : 'success';
      hooks.onToolCall(toolName, status, (performance.now() - start) / 1000);
      return result;
    } catch (error) {
      hooks.onToolCall(toolName, 'error', (performance.now() - start) / 1000);
      throw error;
    }
  };
}
