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
const STOP_WORDS = new Set(['a', 'an', 'the', 'to', 'for', 'of', 'in', 'on', 'with', 'and', 'or']);

export class RipgrepEngine implements IGrepEngine {
  private readonly limit;

  private readonly timeoutMs: number;

  private readonly spawnImpl: (params: GrepParams, signal: AbortSignal) => Promise<GrepMatch[]>;

  constructor(private readonly options: RipgrepEngineOptions) {
    this.limit = pLimit(options.grepMaxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
    this.timeoutMs = options.grepTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (!options.spawn) {
      throw new Error(
        'RipgrepEngine requires a spawn function to be provided in options. ' +
          'The defaultSpawn implementation is not available for direct use.',
      );
    }
    this.spawnImpl = options.spawn;
  }

  async search(params: GrepParams): Promise<GrepMatch[]> {
    return this.limit(async () => this.execute(params));
  }

  private async execute(params: GrepParams): Promise<GrepMatch[]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await this.spawnImpl(this.normalizeParams(params), controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
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
    };
  }
}

const defaultSpawn = async (): Promise<GrepMatch[]> => {
  throw new Error('Ripgrep process spawning is not implemented yet');
};

export const extractGrepKeywords = (query: string): string[] => {
  const literalMatches = query.match(/\b[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)+\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b/g);
  if (literalMatches && literalMatches.length > 0) {
    return literalMatches;
  }

  return query
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .filter((token) => !STOP_WORDS.has(token.toLowerCase()));
};
