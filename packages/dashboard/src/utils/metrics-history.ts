import type { MetricsJSON } from "../hooks/use-metrics.js";

export interface MetricSample {
  readonly timestamp: number;
  readonly value: number;
  readonly generation: number;
}

export interface MetricsHistoryOptions {
  readonly windowMs?: number;
}

export interface PollObservation {
  readonly generation: number;
  readonly data: readonly MetricsJSON[] | null;
  readonly timestamp: number;
}

const SERIES_DIMENSIONS: Readonly<Record<string, readonly string[]>> = {
  nexus_tool_calls_total: ["tool_name", "status"],
  nexus_tool_duration_seconds: ["tool_name"],
  nexus_search_results_hits: ["search_type"],
  nexus_embedding_requests_total: ["provider", "status"],
  nexus_embedding_duration_seconds: ["provider"],
  nexus_embedding_batch_size: ["provider"],
  nexus_event_queue_dropped_total: ["queue_id"],
  nexus_event_queue_size: ["queue_id"],
};
const IGNORED_LABELS = new Set(["project", "pid"]);

function canonicalLabels(name: string, labels: Readonly<Record<string, string>> = {}): Record<string, string> {
  const dimensions = SERIES_DIMENSIONS[name];
  const entries = Object.entries(labels).filter(([key]) => !IGNORED_LABELS.has(key));
  const selected = dimensions ? entries.filter(([key]) => dimensions.includes(key)) : entries;
  return Object.fromEntries(selected.sort(([a], [b]) => a.localeCompare(b)));
}

function makeKey(name: string, labels: Readonly<Record<string, string>> = {}): string {
  return JSON.stringify([name, canonicalLabels(name, labels)]);
}

interface SeriesEntry {
  readonly name: string;
  readonly labels: Record<string, string>;
  readonly samples: MetricSample[];
}

export class MetricsHistory {
  private readonly series = new Map<string, SeriesEntry>();
  private readonly windowMs: number;

  constructor(options: MetricsHistoryOptions = {}) {
    this.windowMs = options.windowMs ?? 300_000;
  }

  observePoll(observation: PollObservation): void {
    if (observation.data) {
      this.ingest(observation.data, observation.timestamp, observation.generation);
    }
    this.evictOldSamples(observation.timestamp);
  }

  private ingest(data: readonly MetricsJSON[], timestamp: number, generation: number): void {
    for (const family of data) {
      for (const value of family.values ?? []) {
        const name = value.metricName ?? family.name;
        const labels = canonicalLabels(name, value.labels);
        const key = makeKey(name, labels);
        const entry = this.series.get(key) ?? { name, labels, samples: [] };
        entry.samples.push({ timestamp, value: value.value, generation });
        this.series.set(key, entry);
      }
    }
  }

  private evictOldSamples(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [key, entry] of this.series) {
      let baseline = -1;
      for (let index = 0; index < entry.samples.length; index += 1) {
        const sample = entry.samples[index];
        if (sample && sample.timestamp <= cutoff) baseline = index;
        else break;
      }
      if (baseline > 0) entry.samples.splice(0, baseline);
      if (entry.samples.length === 0) this.series.delete(key);
    }
  }

  getSeriesExact(name: string, labels?: Record<string, string>): number[] {
    return this.series.get(makeKey(name, labels))?.samples.map(({ value }) => value) ?? [];
  }

  getDeltaExact(name: string, labels?: Record<string, string>, windowMs = this.windowMs): number | null {
    const entry = this.series.get(makeKey(name, labels));
    return entry ? this.computeDelta(entry.samples, windowMs) : null;
  }

  sumDeltaMatching(name: string, partialLabels?: Record<string, string>, windowMs = this.windowMs): number | null {
    let total = 0;
    let found = false;
    for (const entry of this.series.values()) {
      if (entry.name !== name || !Object.entries(partialLabels ?? {}).every(([key, value]) => entry.labels[key] === value)) continue;
      const delta = this.computeDelta(entry.samples, windowMs);
      if (delta !== null) {
        total += delta;
        found = true;
      }
    }
    return found ? total : null;
  }

  getHistogramMean(baseName: string, labels?: Record<string, string>, windowMs = this.windowMs): number | null {
    const sumDelta = this.getDeltaExact(`${baseName}_sum`, labels, windowMs);
    const countDelta = this.getDeltaExact(`${baseName}_count`, labels, windowMs);
    return sumDelta === null || countDelta === null || countDelta <= 0 ? null : sumDelta / countDelta;
  }

  private computeDelta(samples: readonly MetricSample[], windowMs: number): number | null {
    const latest = samples.at(-1);
    if (!latest || samples.length < 2) return null;
    const cutoff = latest.timestamp - windowMs;
    let baselineIndex = -1;
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      if (sample && sample.timestamp <= cutoff) baselineIndex = index;
      else break;
    }
    let previous = baselineIndex >= 0 ? samples[baselineIndex] : undefined;
    let total = 0;
    let found = false;
    for (const current of samples.slice(Math.max(0, baselineIndex + 1))) {
      if (!previous) {
        previous = current;
        continue;
      }
      if (current.generation === previous.generation + 1 && current.value >= previous.value) {
        total += current.value - previous.value;
        found = true;
      }
      previous = current;
    }
    return found ? total : null;
  }

  clear(): void {
    this.series.clear();
  }
}
