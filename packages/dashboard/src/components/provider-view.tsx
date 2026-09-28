import React from "react";
import { Box, Text } from "ink";
import type { DashboardIndexStatusResult } from "../types/dashboard-index-status.js";
import type { MetricsHistory } from "../utils/metrics-history.js";
import type { LayoutPolicy } from "./overview-view.js";
import { MetricPanel } from "./metric-panel.js";

export const ProviderView: React.FC<{ readonly snapshot: DashboardIndexStatusResult | null; readonly history: MetricsHistory; readonly layout: LayoutPolicy }> = ({ snapshot, history, layout }) => (
  <Box flexDirection="column">
    <MetricPanel title="Embedding provider" icon="⚙" borderColor={layout.showDecorations ? "magenta" : undefined}>
      <Text>Name: {snapshot?.providerStatus.providerName ?? "Unavailable"}</Text>
      <Text>Health: {snapshot?.providerStatus.health ?? "unknown"}</Text>
      {layout.showSecondary && <Text>Requests in recent window: {history.sumDeltaMatching("nexus_embedding_requests_total") ?? "—"}</Text>}
      {layout.showSupplemental && <Text>Average duration: {history.getHistogramMean("nexus_embedding_duration_seconds")?.toFixed(3) ?? "—"}s</Text>}
      {snapshot?.providerStatus.lastError && <Text color="red">Error: {snapshot.providerStatus.lastError}</Text>}
    </MetricPanel>
  </Box>
);
