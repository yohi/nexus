import { usePolledEndpoint } from "./use-polled-endpoint.js";
import type { PollResult } from "./use-polled-endpoint.js";
export type { PollResult } from "./use-polled-endpoint.js";

export type MetricsStatus = "waiting" | "unavailable" | "connected";

export interface MetricsJSON {
  name: string;
  help?: string;
  type?: string;
  values?: MetricValue[];
  labels?: Record<string, string>;
}

export interface MetricValue {
  metricName?: string;
  labels?: Record<string, string>;
  value: number;
  timestamp?: number;
}

export interface UseMetricsOptions {
  port?: number | null;
  enabled?: boolean;
  interval?: number;
}

export type UseMetricsResult = PollResult<MetricsJSON[]>;

async function parseMetrics(response: Response): Promise<MetricsJSON[]> {
  const json: unknown = await response.json();
  if (!Array.isArray(json)) throw new Error("Invalid response shape: expected array");
  return json as MetricsJSON[];
}

export function useMetrics(options: UseMetricsOptions = {}): UseMetricsResult {
  const { interval = 2000, ...endpointOptions } = options;
  return usePolledEndpoint({
    ...endpointOptions,
    interval,
    path: "/metrics/json",
    parse: parseMetrics,
  });
}
