import React from "react";
import { Box, Text } from "ink";
import type { DashboardConnectionState } from "../hooks/use-dashboard-endpoint-discovery.js";
import type { UseMetricsResult } from "../hooks/use-metrics.js";
import type { UseDashboardStatusResult } from "../hooks/use-dashboard-status.js";
import type { DeriveAttentionInput } from "../utils/attention.js";
import { deriveAttention } from "../utils/attention.js";
import { AttentionPanel } from "./attention-panel.js";
import { MetricPanel } from "./metric-panel.js";
import type { LayoutPolicy } from "./overview-view.js";

export interface DiagnosticsViewProps {
  readonly connectionState: DashboardConnectionState;
  readonly metrics: UseMetricsResult;
  readonly status: UseDashboardStatusResult;
  readonly metricsEndpointUrl: string | null;
  readonly statusEndpointUrl: string | null;
  readonly attentionInput: DeriveAttentionInput;
  readonly layout: LayoutPolicy;
}

const time = (value: number | null): string => value === null ? "—" : new Date(value).toISOString();

export const DiagnosticsView: React.FC<DiagnosticsViewProps> = ({ connectionState, metrics, status, metricsEndpointUrl, statusEndpointUrl, attentionInput }) => {
  const attention = deriveAttention(attentionInput);
  const snapshot = status.current;
  return <Box flexDirection="column">
    <AttentionPanel items={attention} />
    <MetricPanel title="Connection diagnostics" icon="🩺" borderColor="yellow">
      <Text>Connection: {connectionState}</Text>
      <Text>Metrics endpoint: {metricsEndpointUrl ?? "not discovered"}</Text>
      <Text>Status endpoint: {statusEndpointUrl ?? "not discovered"}</Text>
      <Text>Metrics last success: {time(metrics.lastSuccessAt)}</Text>
      <Text>Metrics last error: {metrics.error ?? "—"} ({time(metrics.lastErrorAt)})</Text>
      <Text>Status last success: {time(status.lastSuccessAt)}</Text>
      <Text>Status last error: {status.error ?? "—"} ({time(status.lastErrorAt)})</Text>
      {snapshot?.providerStatus.lastError && <Text>Provider error: {snapshot.providerStatus.lastError}</Text>}
      {snapshot?.indexStats?.lastError && <Text>Index error: {snapshot.indexStats.lastError}</Text>}
      {snapshot?.pipelineProgress.lastError && <Text>Pipeline error: {snapshot.pipelineProgress.lastError}</Text>}
      {snapshot && <Text>Snapshot: {JSON.stringify(snapshot)}</Text>}
      {!snapshot && status.stale && <Text>Stale snapshot: {JSON.stringify(status.stale)}</Text>}
      {!snapshot && metrics.stale && <Text>Stale metrics families: {metrics.stale.length}</Text>}
    </MetricPanel>
  </Box>;
};
