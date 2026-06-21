export interface RegistrationConfig {
  aggregatorPort: number;
  heartbeatIntervalMs: number;
  requestTimeoutMs: number;
}

export class RegistrationClient {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly payload: {
      projectId: string;
      metricsPort: number;
      pid: number;
    },
    private readonly config: RegistrationConfig,
    private readonly fetchFn: typeof fetch = globalThis.fetch,
    private readonly logger?: { debug: (...args: unknown[]) => void },
  ) {}

  start(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    void this.register();
    this.timer = setInterval(() => void this.register(), this.config.heartbeatIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async register(): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const response = await this.fetchFn(
        `http://127.0.0.1:${this.config.aggregatorPort}/api/discovery/register`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(this.payload),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        throw new Error(`Aggregator registration failed with status ${response.status} ${response.statusText}`.trim());
      }
    } catch (error) {
      this.logger?.debug?.('Aggregator registration failed (non-fatal):', error);
    } finally {
      clearTimeout(timeout);
    }
  }
}
