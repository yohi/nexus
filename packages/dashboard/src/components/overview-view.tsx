import React from "react";
import { Box } from "ink";
import type { DashboardIndexStatusResult } from "../types/dashboard-index-status.js";
import type { DashboardConnectionState } from "../hooks/use-dashboard-endpoint-discovery.js";
import type { MetricsJSON } from "../hooks/use-metrics.js";
import type { MetricsHistory } from "../utils/metrics-history.js";
import { deriveAttention } from "../utils/attention.js";
import { AttentionPanel } from "./attention-panel.js";
import { CompactIndexPanel } from "./compact-index-panel.js";
import { CompactRetrievalPanel } from "./compact-retrieval-panel.js";
import { CompactProviderPanel } from "./compact-provider-panel.js";
import { CompactQueuePanel } from "./compact-queue-panel.js";

export interface LayoutPolicy {
  readonly showSparklines: boolean;
  readonly showSupplemental: boolean;
  readonly showSecondary: boolean;
  readonly showDecorations: boolean;
  readonly showProviderPanel: boolean;
  readonly showQueuePanel: boolean;
}

export interface OverviewViewProps {
  readonly connectionState: DashboardConnectionState;
  readonly snapshot: DashboardIndexStatusResult | null;
  readonly metrics: MetricsJSON[] | null;
  readonly history: MetricsHistory;
  readonly layout: LayoutPolicy;
  readonly port: number | null;
}

export const OverviewView: React.FC<OverviewViewProps> = ({ connectionState, snapshot, metrics, history, layout, port }) => {
  const metricsEndpointUrl = port !== null ? `http://127.0.0.1:${port}/metrics/json` : null;
  const statusEndpointUrl = port !== null ? `http://127.0.0.1:${port}/status` : null;
  const attention = deriveAttention({ snapshot, connectionState, metricsEndpointUrl, statusEndpointUrl, metrics, history });
  return (
    <Box flexDirection="column">
      <AttentionPanel items={attention} />
      <Box flexDirection="row" flexWrap="wrap">
        <CompactIndexPanel snapshot={snapshot} layout={layout} />
        <CompactRetrievalPanel metrics={metrics} history={history} layout={layout} />
        {layout.showProviderPanel && <CompactProviderPanel snapshot={snapshot} layout={layout} />}
        {layout.showQueuePanel && <CompactQueuePanel metrics={metrics} layout={layout} />}
      </Box>
    </Box>
  );
};
