import React from "react";
import { Text } from "ink";
import type { DashboardIndexStatusResult } from "../types/dashboard-index-status.js";
import type { LayoutPolicy } from "./overview-view.js";
import { MetricPanel } from "./metric-panel.js";

export const CompactProviderPanel: React.FC<{ readonly snapshot: DashboardIndexStatusResult | null; readonly layout: LayoutPolicy }> = ({ snapshot, layout }) => (
  <MetricPanel title="Provider" icon="⚙" borderColor={layout.showDecorations ? "magenta" : undefined}>
    <Text>Provider: {snapshot?.providerStatus.providerName ?? "Unavailable"}</Text>
    <Text>Health: {snapshot?.providerStatus.health ?? "unknown"}</Text>
    {layout.showSupplemental && snapshot?.providerStatus.lastError && <Text color="red">{snapshot.providerStatus.lastError}</Text>}
  </MetricPanel>
);
