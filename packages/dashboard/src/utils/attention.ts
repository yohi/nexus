import type { DashboardIndexStatusResult } from "../types/dashboard-index-status.js";
import type { DashboardConnectionState } from "../hooks/use-dashboard-endpoint-discovery.js";
import type { MetricsJSON } from "../hooks/use-metrics.js";
import type { MetricsHistory } from "./metrics-history.js";
import { valueFromMetric } from "./value-state.js";

export type AttentionItem =
  | { readonly source: "canonical"; readonly reason: string; readonly fieldPath: string; readonly detail?: string }
  | { readonly source: "connectivity"; readonly reason: string; readonly endpointUrl: string | null; readonly detail?: string }
  | { readonly source: "telemetry"; readonly reason: string; readonly metricSeries: string; readonly detail?: string };

export interface DeriveAttentionInput {
  readonly snapshot: DashboardIndexStatusResult | null;
  readonly connectionState: DashboardConnectionState;
  readonly metricsEndpointUrl: string | null;
  readonly statusEndpointUrl: string | null;
  readonly metrics: readonly MetricsJSON[] | null;
  readonly history: MetricsHistory;
}

export function deriveAttention({
  snapshot,
  connectionState,
  metricsEndpointUrl,
  statusEndpointUrl,
  metrics,
  history,
}: DeriveAttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [];

  if (connectionState === "runtime_unavailable") {
    items.push({ source: "connectivity", reason: "Runtime unavailable", endpointUrl: null, detail: "metrics.port not found or both endpoints unreachable" });
  } else if (connectionState === "metrics_unavailable") {
    items.push({ source: "connectivity", reason: "Metrics unavailable", endpointUrl: metricsEndpointUrl, detail: "unreachable" });
  } else if (connectionState === "status_unavailable") {
    items.push({ source: "connectivity", reason: "Status unavailable", endpointUrl: statusEndpointUrl, detail: "unreachable" });
  }

  if (snapshot) {
    if (snapshot.indexStats?.lastError != null) {
      items.push({ source: "canonical", reason: "Index build failed", fieldPath: "indexStats.lastError", detail: snapshot.indexStats.lastError });
    }
    if (snapshot.pipelineProgress.lastError != null) {
      items.push({ source: "canonical", reason: "Indexing pipeline failed", fieldPath: "pipelineProgress.lastError", detail: snapshot.pipelineProgress.lastError });
    }
    if (snapshot.structuredIndex?.status === "failed") {
      items.push({ source: "canonical", reason: "Structured index build failed", fieldPath: "structuredIndex.status" });
    }
    if (snapshot.structuredIndex?.reindexRequired) {
      items.push({ source: "canonical", reason: "Structured index requires rebuild", fieldPath: "structuredIndex.reindexRequired" });
    }
    if (snapshot.providerStatus.health === "unhealthy") {
      items.push({ source: "canonical", reason: "Embedding provider unhealthy", fieldPath: "providerStatus.health", detail: snapshot.providerStatus.lastError ?? undefined });
    }
  }

  if (metrics) {
    const overflow = valueFromMetric("nexus_event_queue_state", metrics, "state", "overflow");
    if (overflow.kind === "available" && overflow.value === 1) {
      items.push({ source: "telemetry", reason: "Queue overflow", metricSeries: 'nexus_event_queue_state{state="overflow"}' });
    }
    const dlq = valueFromMetric("nexus_dlq_size", metrics);
    if (dlq.kind === "available" && dlq.value > 0) {
      items.push({ source: "telemetry", reason: "DLQ entries detected", metricSeries: "nexus_dlq_size", detail: String(dlq.value) });
    }
  }

  const droppedDelta = history.sumDeltaMatching("nexus_event_queue_dropped_total", undefined, 300_000);
  if (droppedDelta !== null && droppedDelta > 0) {
    items.push({ source: "telemetry", reason: "Dropped events observed", metricSeries: "nexus_event_queue_dropped_total", detail: "window delta > 0" });
  }
  const embeddingErrorDelta = history.sumDeltaMatching("nexus_embedding_requests_total", { status: "error" }, 300_000);
  if (embeddingErrorDelta !== null && embeddingErrorDelta > 0) {
    items.push({ source: "telemetry", reason: "Embedding errors observed in the recent window", metricSeries: 'nexus_embedding_requests_total{status="error"}', detail: "window delta > 0" });
  }

  return items;
}
