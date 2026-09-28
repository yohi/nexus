import { useEffect, useRef, useState } from "react";
import { MetricsHistory } from "../utils/metrics-history.js";
import type { MetricsJSON } from "./use-metrics.js";

export interface UseMetricsHistoryOptions {
  readonly data: MetricsJSON[] | null;
  readonly port: number | null;
  readonly generation: number;
  readonly windowMs?: number;
}

export interface UseMetricsHistoryResult {
  readonly history: MetricsHistory;
}

export function useMetricsHistory({ data, port, generation, windowMs = 300_000 }: UseMetricsHistoryOptions): UseMetricsHistoryResult {
  const [history] = useState(() => new MetricsHistory({ windowMs }));
  const lastPortRef = useRef<number | null>(port);
  const lastGenerationRef = useRef(0);

  useEffect(() => {
    if (port !== lastPortRef.current) {
      history.clear();
      lastGenerationRef.current = 0;
      lastPortRef.current = port;
      return;
    }
    if (generation > lastGenerationRef.current) {
      lastGenerationRef.current = generation;
      history.observePoll({ generation, data, timestamp: Date.now() });
    }
  }, [port, data, generation, history]);

  return { history };
}
