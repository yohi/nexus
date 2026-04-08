import pLimit from 'p-limit';

import type { GrepMatch, GrepParams, IGrepEngine } from '../types/index.js';

export { type IGrepEngine } from '../types/index.js';

interface RipgrepEngineOptions {
  projectRoot: string;
  grepMaxConcurrency?: number;
  grepTimeoutMs?: number;
  killGraceMs?: number;
  spawn?: (params: GrepParams, signal: AbortSignal) => Promise<GrepMatch[]>;
  createProcessController?: () => {
    kill(signal: 'SIGTERM' | 'SIGKILL'): void;
  };
  processController?: {
    kill(signal: 'SIGTERM' | 'SIGKILL'): void;
  };
}

const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESULTS = 100;
const DEFAULT_KILL_GRACE_MS = 1000;

export class RipgrepEngine implements IGrepEngine {
  private readonly limit;

  private readonly timeoutMs: number;

  private readonly killGraceMs: number;

  private readonly spawnImpl: (params: GrepParams, signal: AbortSignal) => Promise<GrepMatch[]>;

  private readonly createProcessController?: () => {
    kill(signal: 'SIGTERM' | 'SIGKILL'): void;
  };

  private readonly processController?: {
    kill(signal: 'SIGTERM' | 'SIGKILL'): void;
  };

  constructor(private readonly options: RipgrepEngineOptions) {
    const concurrency = options.grepMaxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
    this.limit = pLimit(concurrency);
    this.timeoutMs = options.grepTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.createProcessController = options.createProcessController;
    this.processController = options.processController;

    if (options.processController && concurrency > 1) {
      throw new Error(
        'Concurrent searches (grepMaxConcurrency > 1) cannot share a single processController. Provide createProcessController instead.',
      );
    }

    if (!options.spawn) {
      throw new Error('RipgrepEngine requires a spawn function to be provided in options.');
    }
    this.spawnImpl = options.spawn;
  }

  async search(params: GrepParams): Promise<GrepMatch[]> {
    return this.limit(async () => this.execute(params));
  }

  private async execute(params: GrepParams): Promise<GrepMatch[]> {
    const processController = this.createProcessController?.() ?? this.processController;
    const timeoutController = new AbortController();
    let timedOut = false;
    let settledViaAbort = false;
    let escalationId: ReturnType<typeof setTimeout> | undefined;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      processController?.kill('SIGTERM');
      timeoutController.abort();
      escalationId = setTimeout(() => {
        processController?.kill('SIGKILL');
      }, this.killGraceMs);
    }, this.timeoutMs);
    const combinedSignal = params.abortSignal
      ? AbortSignal.any([timeoutController.signal, params.abortSignal])
      : timeoutController.signal;

    if (combinedSignal.aborted) {
      clearTimeout(timeoutId);
      return [];
    }

    try {
      return await this.spawnImpl(this.normalizeParams(params), combinedSignal);
    } catch (error) {
      if (combinedSignal.aborted) {
        settledViaAbort = true;
        return [];
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
      if (escalationId && (!timedOut || !settledViaAbort)) {
        clearTimeout(escalationId);
      }
    }
  }

  private normalizeParams(params: GrepParams): GrepParams {
    return {
      ...params,
      cwd: this.options.projectRoot,
      query: params.query,
      maxResults: params.maxResults ?? DEFAULT_MAX_RESULTS,
    };
  }
}
