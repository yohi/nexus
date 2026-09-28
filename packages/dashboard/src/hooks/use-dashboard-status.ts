import { useState, useEffect, useRef } from "react";
import type { DashboardIndexStatusResult } from "../types/dashboard-index-status.js";
import type { PollResult } from "./use-metrics.js";

export type DashboardStatusConnectionState = "waiting" | "unavailable" | "connected";

export interface UseDashboardStatusOptions {
  port?: number | null;
  enabled?: boolean;
  interval?: number;
}

export type UseDashboardStatusResult = PollResult<DashboardIndexStatusResult>;

export function useDashboardStatus(options: UseDashboardStatusOptions = {}): UseDashboardStatusResult {
  const { port = null, enabled = false, interval = 10_000 } = options;
  const [status, setStatus] = useState<DashboardStatusConnectionState>("waiting");
  const [current, setCurrent] = useState<DashboardIndexStatusResult | null>(null);
  const [stale, setStale] = useState<DashboardIndexStatusResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const [lastErrorAt, setLastErrorAt] = useState<number | null>(null);
  const [generation, setGeneration] = useState(0);
  const currentRef = useRef<DashboardIndexStatusResult | null>(null);

  useEffect(() => {
    setStatus("waiting");
    setCurrent(null);
    setStale(null);
    setError(null);
    setLastSuccessAt(null);
    setLastErrorAt(null);
    setGeneration(0);
    currentRef.current = null;
    if (!enabled || port === null) {
      return;
    }
    const abortController = new AbortController();
    const url = `http://127.0.0.1:${port}/status`;

    const markUnavailable = (msg: string) => {
      const now = Date.now();
      const previousCurrent = currentRef.current;
      setStale((previousStale) => previousCurrent ?? previousStale);
      setCurrent(null);
      currentRef.current = null;
      setError(msg);
      setLastErrorAt(now);
      setStatus("unavailable");
    };

    const poll = async () => {
      try {
        const res = await fetch(url, { signal: abortController.signal });
        if (!res.ok) {
          markUnavailable(`HTTP ${res.status}`);
          setGeneration((g) => g + 1);
          return;
        }
        const contentType = res.headers.get("content-type") ?? "";
        if (!contentType.includes("application/json")) {
          markUnavailable("Invalid JSON");
          setGeneration((g) => g + 1);
          return;
        }
        const raw = await res.json() as { status?: unknown; error?: unknown; snapshot?: unknown };
        if (raw.status !== "ok" || !raw.snapshot) {
          markUnavailable(typeof raw.error === "string" ? raw.error : "Invalid status response");
          setGeneration((g) => g + 1);
          return;
        }
        const snapshot = raw.snapshot as DashboardIndexStatusResult;
        currentRef.current = snapshot;
        setCurrent(snapshot);
        setStale(null);
        setError(null);
        setLastSuccessAt(Date.now());
        setLastErrorAt(null);
        setStatus("connected");
        setGeneration((g) => g + 1);
      } catch (err) {
        if (abortController.signal.aborted) return;
        markUnavailable(err instanceof Error ? err.message : String(err));
        setGeneration((g) => g + 1);
      }
    };

    void poll();
    const id = setInterval(() => void poll(), interval);
    return () => {
      abortController.abort();
      clearInterval(id);
    };
  }, [port, enabled, interval]);

  return { status, current, stale, error, lastSuccessAt, lastErrorAt, generation };
}
