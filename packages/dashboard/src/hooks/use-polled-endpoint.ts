import { useEffect, useRef, useState } from "react";

const REQUEST_TIMEOUT_MS = 5000;

export interface PollResult<T> {
  status: "waiting" | "unavailable" | "connected";
  current: T | null;
  stale: T | null;
  error: string | null;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  generation: number;
}

export interface UsePolledEndpointOptions<T> {
  readonly port?: number | null;
  readonly enabled?: boolean;
  readonly interval: number;
  readonly path: string;
  readonly parse: (response: Response) => Promise<T>;
}

export function usePolledEndpoint<T>(options: UsePolledEndpointOptions<T>): PollResult<T> {
  const { port = null, enabled = false, interval, path, parse } = options;
  const [status, setStatus] = useState<PollResult<T>["status"]>("waiting");
  const [current, setCurrent] = useState<T | null>(null);
  const [stale, setStale] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastSuccessAt, setLastSuccessAt] = useState<number | null>(null);
  const [lastErrorAt, setLastErrorAt] = useState<number | null>(null);
  const [generation, setGeneration] = useState(0);
  const currentRef = useRef<T | null>(null);

  useEffect(() => {
    setStatus("waiting");
    setCurrent(null);
    setStale(null);
    setError(null);
    setLastSuccessAt(null);
    setLastErrorAt(null);
    setGeneration(0);
    currentRef.current = null;
    if (!enabled || port === null) return;

    const controller = new AbortController();
    let inFlight = false;
    const markUnavailable = (message: string) => {
      const previousCurrent = currentRef.current;
      setStale((previousStale) => previousCurrent ?? previousStale);
      setCurrent(null);
      currentRef.current = null;
      setError(message);
      setLastErrorAt(Date.now());
      setStatus("unavailable");
    };
    const poll = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const signal = AbortSignal.any([controller.signal, timeoutSignal]);
        const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (!(response.headers.get("content-type") ?? "").includes("application/json")) {
          throw new Error("Invalid JSON");
        }
        const value = await parse(response);
        currentRef.current = value;
        setCurrent(value);
        setStale(null);
        setError(null);
        setLastSuccessAt(Date.now());
        setLastErrorAt(null);
        setStatus("connected");
      } catch (err) {
        if (controller.signal.aborted) return;
        markUnavailable(err instanceof Error ? err.message : String(err));
      } finally {
        inFlight = false;
      }
      setGeneration((value) => value + 1);
    };

    void poll();
    const timer = setInterval(() => void poll(), interval);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [port, enabled, interval, path, parse]);

  return { status, current, stale, error, lastSuccessAt, lastErrorAt, generation };
}
