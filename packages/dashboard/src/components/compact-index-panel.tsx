import React from "react";
import { Text } from "ink";
import type { DashboardIndexStatusResult } from "../types/dashboard-index-status.js";
import { deriveMainReadiness, deriveStructuredReadiness } from "../utils/readiness.js";
import type { LayoutPolicy } from "./overview-view.js";
import { MetricPanel } from "./metric-panel.js";

export const CompactIndexPanel: React.FC<{ readonly snapshot: DashboardIndexStatusResult | null; readonly layout: LayoutPolicy }> = ({ snapshot, layout }) => (
  <MetricPanel title="Index" icon="📚" borderColor={layout.showDecorations ? "green" : undefined}>
    <Text>Main: {deriveMainReadiness(snapshot)}</Text>
    <Text>Structured: {deriveStructuredReadiness(snapshot?.structuredIndex)}</Text>
    {layout.showSecondary && <Text>Files: {snapshot?.indexStats?.totalFiles ?? "—"} · Chunks: {snapshot?.indexStats?.totalChunks ?? "—"}</Text>}
    {snapshot?.pipelineProgress.status === "running" && <Text>{snapshot.pipelineProgress.processedFiles}/{snapshot.pipelineProgress.totalFiles} files</Text>}
  </MetricPanel>
);
