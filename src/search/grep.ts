import pLimit from 'p-limit';

import type { GrepMatch, GrepParams, IGrepEngine } from '../types/index.js';

export { type IGrepEngine } from '../types/index.js';

interface RipgrepEngineOptions {
  projectRoot: string;
  grepMaxConcurrency?: number;
  grepTimeoutMs?: number;
  killGraceMs?: number;
  spawn?: (params: GrepParams, signal: AbortSignal) => Promise<GrepMatch[]>;
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

  private readonly processController?: {
    kill(signal: 'SIGTERM' | 'SIGKILL'): void;
  };

  constructor(private readonly options: RipgrepEngineOptions) {
    this.limit = pLimit(options.grepMaxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
    this.timeoutMs = options.grepTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.processController = options.processController;

    if (!options.spawn) {
      throw new Error('RipgrepEngine requires a spawn function to be provided in options.');
    }
    this.spawnImpl = options.spawn;
  }

  async search(params: GrepParams): Promise<GrepMatch[]> {
    return this.limit(async () => this.execute(params));
  }

  private async execute(params: GrepParams): Promise<GrepMatch[]> {
    const timeoutController = new AbortController();
    let timedOut = false;
    let escalationId: ReturnType<typeof setTimeout> | undefined;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      this.processController?.kill('SIGTERM');
      timeoutController.abort();
      escalationId = setTimeout(() => {
        this.processController?.kill('SIGKILL');
      }, this.killGraceMs);
    }, this.timeoutMs);
    const combinedSignal = params.abortSignal
      ? AbortSignal.any([timeoutController.signal, params.abortSignal])
      : timeoutController.signal;

    try {
      return await this.spawnImpl(this.normalizeParams(params), combinedSignal);
    } catch (error) {
      if (combinedSignal.aborted) {
        return [];
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
      if (!timedOut && escalationId) {
        clearTimeout(escalationId);
      }
      if (!timedOut && combinedSignal.aborted && escalationId) {
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
