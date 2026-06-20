import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';

export interface RegisteredNode {
  projectId: string;
  metricsPort: number;
  pid: number;
  registeredAt: number;
}

export interface MetricValue {
  value: number;
  labels: Record<string, string>;
  metricName?: string;
}

export interface MetricObject {
  name: string;
  help: string;
  type: string;
  values: MetricValue[];
}

export class HealthChecker {
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly nodes: Map<number, RegisteredNode>,
    private readonly intervalMs: number = 15_000,
    private readonly timeoutMs: number = 2_000,
    private readonly fetchFn: typeof fetch = globalThis.fetch,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.checkAll(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async checkAll(): Promise<void> {
    const checks = [...this.nodes.entries()].map(async ([port]) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchFn(`http://127.0.0.1:${port}/health`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error('Unhealthy');
        }
      } catch {
        this.nodes.delete(port);
      } finally {
        clearTimeout(timeout);
      }
    });
    await Promise.allSettled(checks);
  }
}

export function serializeToPrometheus(metricsLists: MetricObject[][]): string {
  const mergedMap = new Map<string, { help: string; type: string; values: MetricValue[] }>();

  for (const list of metricsLists) {
    for (const metric of list) {
      if (!mergedMap.has(metric.name)) {
        mergedMap.set(metric.name, {
          help: metric.help,
          type: metric.type,
          values: [],
        });
      }
      const entry = mergedMap.get(metric.name)!;
      entry.values.push(...metric.values);
    }
  }

  const escapeLabelValue = (val: string): string => {
    return val.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
  };
  const escapeHelpText = (val: string): string => {
    return val.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
  };

  const lines: string[] = [];
  const sortedEntries = [...mergedMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [name, metric] of sortedEntries) {
    lines.push(`# HELP ${name} ${escapeHelpText(metric.help)}`);
    lines.push(`# TYPE ${name} ${metric.type}`);
    for (const val of metric.values) {
      const labelsStr = Object.keys(val.labels).length > 0
        ? `{${Object.entries(val.labels).map(([k, v]) => `${k}="${escapeLabelValue(v)}"`).join(',')}}`
        : '';
      const metricName = val.metricName || name;
      lines.push(`${metricName}${labelsStr} ${val.value}`);
    }
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
}

export class AggregatorServer {
  private server: Server | null = null;
  private healthChecker: HealthChecker | null = null;
  readonly nodes = new Map<number, RegisteredNode>();

  constructor(private readonly fetchFn: typeof fetch = fetch) {}

  async start(port: number): Promise<void> {
    this.server = createServer((req, res) => {
      this.handleRequest(req, res);
    });

    return new Promise((resolve, reject) => {
      this.server!.on('error', (err) => {
        reject(err);
      });
      this.server!.listen(port, '127.0.0.1', () => {
        this.healthChecker = new HealthChecker(this.nodes, 15_000, 2_000, this.fetchFn);
        this.healthChecker.start();
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    this.healthChecker?.stop();
    this.nodes.clear();
    if (this.server) {
      await new Promise<void>((resolve) => {
        // ERR_SERVER_NOT_RUNNING (server not listening yet) is expected
        // if stop() is called after a failed start(), so we ignore it safely.
        // (未listen状態の ERR_SERVER_NOT_RUNNING は正常な cleanup として無視する)
        this.server!.close((err) => {
          resolve();
        });
      });
      this.server = null;
    }
  }

  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    
    if (req.method === 'POST' && url.pathname === '/api/discovery/register') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          if (typeof payload.projectId !== 'string' || typeof payload.metricsPort !== 'number' || typeof payload.pid !== 'number') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid payload' }));
            return;
          }
          const isNew = !this.nodes.has(payload.metricsPort);
          this.nodes.set(payload.metricsPort, {
            projectId: payload.projectId,
            metricsPort: payload.metricsPort,
            pid: payload.pid,
            registeredAt: Date.now(),
          });
          res.writeHead(isNew ? 201 : 200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Bad request' }));
        }
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/metrics') {
      void this.handleMetrics(res).catch(() => {
        if (!res.headersSent && !res.destroyed) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        }
        if (!res.destroyed) {
          res.end('Internal Server Error');
        }
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', nodes: this.nodes.size }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/discovery/nodes') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([...this.nodes.values()]));
      return;
    }

    res.writeHead(404);
    res.end();
  }

  private async handleMetrics(res: ServerResponse): Promise<void> {
    const fetchPromises = [...this.nodes.values()].map(async (node) => {
      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), 3000);
      try {
        const response = await this.fetchFn(`http://127.0.0.1:${node.metricsPort}/metrics/json`, {
          signal: controller.signal
        });
        if (!response.ok) throw new Error('Not OK');
        return await response.json();
      } finally {
        clearTimeout(id);
      }
    });

    const results = await Promise.allSettled(fetchPromises);
    const metricsLists = results
      .filter((r): r is PromiseFulfilledResult<unknown> => r.status === 'fulfilled')
      .map(r => r.value)
      .filter((value): value is MetricObject[] => Array.isArray(value));

    const mergedText = serializeToPrometheus(metricsLists);
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(mergedText);
  }
}
