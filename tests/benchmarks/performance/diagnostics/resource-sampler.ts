import { monitorEventLoopDelay } from 'node:perf_hooks';

import type { MeasurementNotCollectedReason } from './contracts.js';
import type { DiagnosticTraceRecorder } from './trace-recorder.js';

type Measurement = Readonly<{ status: 'observed'; value: number }>
  | Readonly<{ status: 'not_collected'; reasonCode: MeasurementNotCollectedReason }>;

const notRequested = (): Measurement => ({ status: 'not_collected', reasonCode: 'not_requested' });

export class WorkerResourceSampler {
  private readonly eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  private interval: NodeJS.Timeout | undefined;
  private previousCpu = process.cpuUsage();
  private lastSampleNs: bigint | undefined;

  constructor(
    private readonly recorder: DiagnosticTraceRecorder,
    private readonly intervalMs = 5_000,
    private readonly nowNs: () => bigint = () => process.hrtime.bigint(),
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw new RangeError('intervalMs must be a positive safe integer');
  }

  start(): void {
    if (this.interval !== undefined) return;
    this.eventLoopDelay.enable();
    this.sample(true);
    this.interval = setInterval(() => this.sampleInterval(), this.intervalMs);
    this.interval.unref();
  }

  sampleBoundary(): void {
    this.sample(false);
  }

  stop(): void {
    if (this.interval !== undefined) clearInterval(this.interval);
    this.interval = undefined;
    this.sample(true);
    this.eventLoopDelay.disable();
  }

  private sampleInterval(): void {
    this.sample(false);
  }

  private sample(force: boolean): void {
    try {
      const nowNs = this.nowNs();
      const intervalNs = BigInt(this.intervalMs) * 1_000_000n;
      if (!force && this.lastSampleNs !== undefined && nowNs - this.lastSampleNs < intervalNs) return;
      this.lastSampleNs = nowNs;
      const memory = process.memoryUsage();
      const currentCpu = process.cpuUsage();
      const cpuUserUs = Math.max(0, currentCpu.user - this.previousCpu.user);
      const cpuSystemUs = Math.max(0, currentCpu.system - this.previousCpu.system);
      this.previousCpu = currentCpu;
      const delayMaxNs = this.eventLoopDelay.max;
      this.eventLoopDelay.reset();
      this.recorder.recordResourceSample({
        sampleScope: 'worker_process',
        heapUsedBytes: { status: 'observed', value: memory.heapUsed },
        heapTotalBytes: { status: 'observed', value: memory.heapTotal },
        rssBytes: { status: 'observed', value: memory.rss },
        externalBytes: { status: 'observed', value: memory.external },
        arrayBuffersBytes: { status: 'observed', value: memory.arrayBuffers },
        cpuUserUs: { status: 'observed', value: cpuUserUs },
        cpuSystemUs: { status: 'observed', value: cpuSystemUs },
        ioReadBytes: { status: 'not_collected', reasonCode: 'unsupported' },
        ioWriteBytes: { status: 'not_collected', reasonCode: 'unsupported' },
        eventLoopDelayMaxNs: Number.isFinite(delayMaxNs) && delayMaxNs > 0
          ? { status: 'observed', value: delayMaxNs }
          : { status: 'not_collected', reasonCode: 'not_yet_sampled' },
        cgroupMemoryCurrentBytes: notRequested(),
        cgroupSwapCurrentBytes: notRequested(),
        cpuPressureSomeAvg60: notRequested(),
        ioPressureSomeAvg60: notRequested(),
        memoryPressureSomeAvg60: notRequested(),
        oomKillDelta: notRequested(),
      });
    } catch {
      this.recorder.markObserverFailure();
    }
  }
}
