import { useState, useEffect, useRef } from "react";

export type MetricsStatus =
  | "connecting"
  | "connected"
  | "waiting"
  | "reconnecting";

export interface MetricsJSON {
  name: string;
  help?: string;
  type?: string;
  values?: MetricValue[];
  labels?: Record<string, string>;
}

export interface MetricValue {
  labels?: Record<string, string>;
  value: number;
  timestamp?: number;
}

export interface UseMetricsOptions {
  port?: number;
  interval?: number;
}

export interface UseMetricsResult {
  status: MetricsStatus;
  data: MetricsJSON[] | null;
  error: string | null;
}

export function useMetrics(options: UseMetricsOptions = {}): UseMetricsResult {
  const { port = 9464, interval = 2000 } = options;
  const [status, setStatus] = useState<MetricsStatus>("connecting");
  const [data, setData] = useState<MetricsJSON[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hadConnection = useRef(false);

  useEffect(() => {
    hadConnection.current = false;
    const abortController = new AbortController();
    const url = `http://localhost:${port}/metrics/json`;

    const poll = async () => {
      try {
        const res = await fetch(url, { signal: abortController.signal });
        if (!res.ok) {
          setError(`HTTP ${res.status}`);
          setStatus(hadConnection.current ? "reconnecting" : "connecting");
          return;
        }
        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          setStatus("waiting");
          setError("Invalid JSON");
          return;
        }
        const json = await res.json();
        if (!Array.isArray(json)) {
          setStatus("waiting");
          setError("Invalid response shape: expected array");
          return;
        }

        setData(json as MetricsJSON[]);
        setError(null);
        setStatus("connected");
        hadConnection.current = true;
      } catch (err) {
        if (abortController.signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        setError(msg);
        setStatus(hadConnection.current ? "reconnecting" : "connecting");
      }
    };

    void poll();
    const id = setInterval(() => void poll(), interval);
    return () => {
      hadConnection.current = false;
      abortController.abort();
      clearInterval(id);
    };
  }, [port, interval]);

  return { status, data, error };
}
