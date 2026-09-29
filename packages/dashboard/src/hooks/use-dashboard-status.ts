import { usePolledEndpoint } from "./use-polled-endpoint.js";
import type { PollResult } from "./use-polled-endpoint.js";
import type { DashboardIndexStatusResult } from "../types/dashboard-index-status.js";

export type DashboardStatusConnectionState = "waiting" | "unavailable" | "connected";

export interface UseDashboardStatusOptions {
  port?: number | null;
  enabled?: boolean;
  interval?: number;
}

export type UseDashboardStatusResult = PollResult<DashboardIndexStatusResult>;

async function parseDashboardStatus(response: Response): Promise<DashboardIndexStatusResult> {
  const raw: unknown = await response.json();
  if (typeof raw !== "object" || raw === null || !("status" in raw) || raw.status !== "ok" || !("snapshot" in raw) || !raw.snapshot) {
    const message = typeof raw === "object" && raw !== null && "error" in raw && typeof raw.error === "string"
      ? raw.error
      : "Invalid status response";
    throw new Error(message);
  }
  return raw.snapshot as DashboardIndexStatusResult;
}

export function useDashboardStatus(options: UseDashboardStatusOptions = {}): UseDashboardStatusResult {
  const { interval = 10_000, ...endpointOptions } = options;
  return usePolledEndpoint({
    ...endpointOptions,
    interval,
    path: "/status",
    parse: parseDashboardStatus,
  });
}
