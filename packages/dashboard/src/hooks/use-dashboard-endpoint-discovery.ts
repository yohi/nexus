import { useState, useEffect, useRef, useCallback } from "react";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { useMetrics } from "./use-metrics.js";
import { useDashboardStatus } from "./use-dashboard-status.js";

export type DashboardConnectionState =
  | "waiting"
  | "runtime_unavailable"
  | "metrics_unavailable"
  | "status_unavailable"
  | "connected";

export interface UseDashboardEndpointDiscoveryOptions {
  fixedPort?: number;
  storageDir?: string;
  metricsInterval?: number;
  statusInterval?: number;
}

export interface UseDashboardEndpointDiscoveryResult {
  port: number | null;
  connectionState: DashboardConnectionState;
  metrics: ReturnType<typeof useMetrics>;
  status: ReturnType<typeof useDashboardStatus>;
}

async function readMetricsPort(storageDir: string): Promise<number | null> {
  try {
    const content = await fsPromises.readFile(path.join(storageDir, "metrics.port"), "utf8");
    const port = Number.parseInt(content.trim(), 10);
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
  } catch {
    // ignore
  }
  return null;
}

export function useDashboardEndpointDiscovery(
  options: UseDashboardEndpointDiscoveryOptions = {},
): UseDashboardEndpointDiscoveryResult {
  const { fixedPort, storageDir, metricsInterval = 2000, statusInterval = 10_000 } = options;
  const isDiscovery = fixedPort === undefined;
  const [port, setPort] = useState<number | null>(fixedPort ?? null);
  const [connectionState, setConnectionState] = useState<DashboardConnectionState>("waiting");
  const discoveryRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const discover = useCallback(async () => {
    if (!isDiscovery || !storageDir) return;
    const discovered = await readMetricsPort(storageDir);
    setPort((prev) => (discovered !== null ? discovered : prev));
  }, [isDiscovery, storageDir]);

  useEffect(() => {
    if (!isDiscovery) {
      setPort(fixedPort ?? null);
      return;
    }
    if (!storageDir) {
      setPort(null);
      return;
    }
    const id = setInterval(() => void discover(), 5000);
    discoveryRef.current = id;
    return () => {
      clearInterval(id);
    };
  }, [isDiscovery, fixedPort, storageDir, discover]);

  const metrics = useMetrics({ port, enabled: port !== null, interval: metricsInterval });
  const status = useDashboardStatus({ port, enabled: port !== null, interval: statusInterval });

  useEffect(() => {
    if (!isDiscovery || port === null) return;
    if (metrics.status === "unavailable" && status.status === "unavailable") {
      void discover();
      const previousId = discoveryRef.current;
      if (previousId) {
        clearInterval(previousId);
      }
      discoveryRef.current = setInterval(() => void discover(), 5000);
    }
  }, [isDiscovery, port, metrics.status, status.status, discover]);

  useEffect(() => {
    if (port === null) {
      setConnectionState("runtime_unavailable");
      return;
    }
    if (metrics.status === "waiting" || status.status === "waiting") {
      setConnectionState("waiting");
      return;
    }
    if (metrics.status === "unavailable" && status.status === "unavailable") {
      setConnectionState("runtime_unavailable");
      return;
    }
    if (status.status !== "connected") {
      setConnectionState("status_unavailable");
      return;
    }
    if (metrics.status !== "connected") {
      setConnectionState("metrics_unavailable");
      return;
    }
    setConnectionState("connected");
  }, [port, metrics.status, status.status]);

  return { port, connectionState, metrics, status };
}
