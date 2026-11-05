import { writeFileSync } from 'node:fs';
import { getHeapStatistics } from 'node:v8';
import { limitProofSchema } from './worker-contracts.js';
import type { phaseSchema } from './worker-contracts.js';
import type { z } from 'zod';

export class WorkerBudgetError extends Error {
  constructor(readonly code: 'heap_flag_mismatch' | 'heap_limit_exceeded' | 'scenario_deadline' | 'worker_aborted') {
    super(code); this.name = 'WorkerBudgetError';
  }
}

export class WorkerBudget {
  private readonly controller = new AbortController();
  private readonly timer: NodeJS.Timeout;
  private readonly monitor: NodeJS.Timeout;
  private peakHeap = 0;
  private receivedMemory = 0;
  private readonly terminate = () => this.controller.abort(new WorkerBudgetError('worker_aborted'));

  constructor(private readonly request: Readonly<{ memoryLimitMb: number; deadlineEpochMs: number; phaseFile: string }>) {
    const flags = [...(process.env.NODE_OPTIONS ?? '').matchAll(/--max[-_]old[-_]space[-_]size=(\d+)/g)];
    const raw = flags.length === 1 ? flags[0]?.[1] : undefined;
    this.receivedMemory = raw === undefined ? 0 : Number(raw);
    this.timer = setTimeout(() => this.controller.abort(new WorkerBudgetError('scenario_deadline')),
      Math.max(1, request.deadlineEpochMs - Date.now()));
    this.monitor = setInterval(() => this.refresh(), 25);
    this.monitor.unref();
    process.once('SIGTERM', this.terminate);
    this.setPhase('setup');
    if (this.receivedMemory !== request.memoryLimitMb) this.controller.abort(new WorkerBudgetError('heap_flag_mismatch'));
  }

  get signal(): AbortSignal { return this.controller.signal; }

  refresh(): void {
    this.peakHeap = Math.max(this.peakHeap, process.memoryUsage().heapUsed);
    if (this.peakHeap > this.request.memoryLimitMb * 1024 * 1024 && !this.signal.aborted) {
      this.controller.abort(new WorkerBudgetError('heap_limit_exceeded'));
    }
  }

  setPhase(phase: z.infer<typeof phaseSchema>): void {
    this.refresh();
    writeFileSync(this.request.phaseFile, JSON.stringify({ phase }), 'utf8');
  }

  proof() {
    this.refresh();
    return limitProofSchema.parse({ requestedMemoryLimitMb: this.request.memoryLimitMb, receivedMemoryLimitMb: this.receivedMemory,
      vmHeapLimitBytes: getHeapStatistics().heap_size_limit, peakHeapUsedBytes: this.peakHeap,
      lifetimePeakRssBytes: process.resourceUsage().maxRSS * 1024, pid: process.pid });
  }

  close(): void {
    clearTimeout(this.timer); clearInterval(this.monitor); process.removeListener('SIGTERM', this.terminate);
  }
}
