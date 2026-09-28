import React from "react";
import { Box, Text } from "ink";
import type { DashboardIndexStatusResult } from "../types/dashboard-index-status.js";
import type { MetricsHistory } from "../utils/metrics-history.js";
import type { LayoutPolicy } from "./overview-view.js";

export const ProviderView: React.FC<{ readonly snapshot: DashboardIndexStatusResult | null; readonly history: MetricsHistory; readonly layout: LayoutPolicy }> = ({ snapshot, history, layout }) => (
  <Box flexDirection="column">
    <Box flexDirection="column" borderStyle={layout.showDecorations ? "round" : undefined} borderColor={layout.showDecorations ? "magenta" : undefined} paddingX={layout.showDecorations ? 1 : 0} flexGrow={1} flexBasis="33%" minWidth={30}>
      <Text bold>⚙ Embedding provider</Text>
      <Box flexDirection="column">
        <Text>Name: {snapshot?.providerStatus.providerName ?? "Unavailable"}</Text>
        <Text>Health: {snapshot?.providerStatus.health ?? "unknown"}</Text>
        {layout.showSecondary && <Text>Requests in recent window: {history.sumDeltaMatching("nexus_embedding_requests_total") ?? "—"}</Text>}
        {layout.showSupplemental && <Text>Average duration: {history.getHistogramMean("nexus_embedding_duration_seconds")?.toFixed(3) ?? "—"}s</Text>}
        {snapshot?.providerStatus.lastError && <Text color="red">Error: {snapshot.providerStatus.lastError}</Text>}
      </Box>
    </Box>
  </Box>
);
