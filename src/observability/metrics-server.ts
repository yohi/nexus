import { createServer, type Server } from 'node:http';
import type { Registry } from 'prom-client';

export class MetricsHttpServer {
  private server: Server | undefined;
  private listening = false;

  constructor(private readonly registry: Registry) {}

  async start(port: number, host = '127.0.0.1'): Promise<void> {
    const reg = this.registry;
    this.server = createServer((req, res) => {
      (async () => {
        try {
          if (req.url === '/metrics') {
            const metrics = await reg.metrics();
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end(metrics);
          } else if (req.url === '/metrics/json') {
            const json = await reg.getMetricsAsJSON();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(json));
          } else if (req.url === '/health') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
          } else {
            res.writeHead(404);
            res.end();
          }
        } catch {
          if (!res.headersSent) {
            res.writeHead(500);
          }
          res.end();
        }
      })();
    });

    return new Promise<void>((resolve, reject) => {
      const portNum = port;
      this.server!.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          console.warn(`[Nexus] Metrics port ${portNum} already in use. Metrics HTTP server disabled.`);
          this.listening = false;
          resolve();
        } else {
          reject(err);
        }
      });

      this.server!.listen(portNum, host, () => {
        this.listening = true;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server || !this.listening) {
      return;
    }
    return new Promise<void>((resolve, reject) => {
      this.server!.close((err) => {
        this.listening = false;
        if (err) reject(err);
        else resolve();
      });
    });
  }

  isListening(): boolean {
    return this.listening;
  }
}