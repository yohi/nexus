import pLimit from 'p-limit';

import type { GrepMatch, GrepParams, IGrepEngine } from '../types/index.js';

export { type IGrepEngine } from '../types/index.js';

interface RipgrepEngineOptions {
  projectRoot: string;
  grepMaxConcurrency?: number;
  grepTimeoutMs?: number;
  spawn?: (params: GrepParams, signal: AbortSignal) => Promise<GrepMatch[]>;
  createProcessController?: () => ProcessController;
}

interface ProcessController {
  kill(signal: NodeJS.Signals): void;
}

const DEFAULT_MAX_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESULTS = 100;
const KILL_GRACE_MS = 1_000;

export class RipgrepEngine implements IGrepEngine {
  private readonly limit;

  private readonly timeoutMs: number;

  private readonly spawnImpl: (params: GrepParams, signal: AbortSignal) => Promise<GrepMatch[]>;

  private readonly createProcessController?: () => ProcessController;

  constructor(private readonly options: RipgrepEngineOptions) {
    this.limit = pLimit(options.grepMaxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
    this.timeoutMs = options.grepTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (!options.spawn) {
      throw new Error('RipgrepEngine requires a spawn function to be provided in options.');
    }
    this.spawnImpl = options.spawn;
    this.createProcessController = options.createProcessController;
  }

  async search(params: GrepParams): Promise<GrepMatch[]> {
    return this.limit(async () => this.execute(params));
  }

  private async execute(params: GrepParams): Promise<GrepMatch[]> {
    const processController = this.createProcessController?.();
    const signals: AbortSignal[] = [];

    // Internal timeout signal
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => {
      processController?.kill('SIGTERM');
      timeoutController.abort();
    }, this.timeoutMs);
    signals.push(timeoutController.signal);

    // Optional external abort signal
    if (params.abortSignal) {
      signals.push(params.abortSignal);
    }

    const combinedSignal = AbortSignal.any(signals);
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    try {
      combinedSignal.addEventListener(
        'abort',
        () => {
          if (processController === undefined) {
            return;
          }
          // If this was a timeout abort, schedule SIGKILL as a last resort
          if (timeoutController.signal.aborted) {
            killTimer = setTimeout(() => {
              processController.kill('SIGKILL');
            }, KILL_GRACE_MS);
          }
        },
      );

      return await this.spawnImpl(this.normalizeParams(params), combinedSignal);
    } catch (error) {
      if (combinedSignal.aborted) {
        return [];
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
      if (killTimer !== undefined) {
        clearTimeout(killTimer);
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
