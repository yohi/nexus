export class StatisticsError extends Error {
  readonly code = 'invalid_samples';
  constructor() { super('invalid_samples'); this.name = 'StatisticsError'; }
}

function sortedSamples(samples: readonly number[]): number[] {
  if (samples.length === 0 || samples.some((value) => !Number.isFinite(value) || value < 0)) throw new StatisticsError();
  return [...samples].sort((left, right) => left - right);
}

function atRank(sorted: readonly number[], rank: number): number {
  const value = sorted[Math.ceil(rank * sorted.length) - 1];
  if (value === undefined) throw new StatisticsError();
  return value;
}

export function summarizeWarm(samples: readonly number[]) {
  const sorted = sortedSamples(samples);
  return Object.freeze({ p50: atRank(sorted, 0.5), p95: atRank(sorted, 0.95), p99: atRank(sorted, 0.99) });
}

export function summarizeLifecycle(samples: readonly number[]) {
  const sorted = sortedSamples(samples);
  const min = sorted[0];
  const max = sorted.at(-1);
  const lower = sorted[Math.floor((sorted.length - 1) / 2)];
  const upper = sorted[Math.floor(sorted.length / 2)];
  if (min === undefined || max === undefined || lower === undefined || upper === undefined) throw new StatisticsError();
  return Object.freeze({ raw: Object.freeze([...samples]), min, median: (lower + upper) / 2, max });
}
