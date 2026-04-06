import pLimit from 'p-limit';

import type { GrepMatch, GrepParams, IGrepEngine } from '../types/index.js';

export { type IGrepEngine } from '../types/index.js';

interface RipgrepEngineOptions {
  projectRoot: string;
  grepMaxConcurrency?: number;
  grepTimeoutMs?: number;
  spawn?: (params: GrepParams, signal: AbortSignal) => Promise<GrepMatch[]>;
}

const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESULTS = 100;

export class RipgrepEngine implements IGrepEngine {
  private readonly limit;

  private readonly timeoutMs: number;

  private readonly spawnImpl: (params: GrepParams, signal: AbortSignal) => Promise<GrepMatch[]>;

  constructor(private readonly options: RipgrepEngineOptions) {
    this.limit = pLimit(options.grepMaxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
    this.timeoutMs = options.grepTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (!options.spawn) {
      throw new Error('RipgrepEngine requires a spawn function to be provided in options.');
    }
    this.spawnImpl = options.spawn;
  }

  async search(params: GrepParams): Promise<GrepMatch[]> {
    return this.limit(async () => this.execute(params));
  }

  private async execute(params: GrepParams): Promise<GrepMatch[]> {
    const controller = new AbortController();
    const signals = [controller.signal];

    if (params.abortSignal) {
      signals.push(params.abortSignal);
    }

    const signal = signals.length === 1 ? controller.signal : AbortSignal.any(signals);
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await this.spawnImpl(this.normalizeParams(params), signal);
    } catch (error) {
      if (signal.aborted) {
        return [];
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private normalizeParams(params: GrepParams): GrepParams {
    return {
      ...params,
      cwd: this.options.projectRoot,
      query: params.query,
      maxResults: params.maxResults ?? DEFAULT_MAX_RESULTS,
      abortSignal: params.abortSignal,
    };
  }
}
