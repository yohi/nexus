import React from "react";
import { Box, Text } from "ink";
import type { DashboardIndexStatusResult } from "../types/dashboard-index-status.js";
import { deriveMainReadiness, deriveStructuredReadiness } from "../utils/readiness.js";
import type { LayoutPolicy } from "./overview-view.js";

export const CompactIndexPanel: React.FC<{ readonly snapshot: DashboardIndexStatusResult | null; readonly layout: LayoutPolicy }> = ({ snapshot, layout }) => (
  <Box flexDirection="column" borderStyle={layout.showDecorations ? "round" : undefined} borderColor={layout.showDecorations ? "green" : undefined} paddingX={layout.showDecorations ? 1 : 0} flexGrow={1} flexBasis="33%" minWidth={30}>
    <Text bold>📚 Index</Text>
    <Box flexDirection="column">
      <Text>Main: {deriveMainReadiness(snapshot)}</Text>
      <Text>Structured: {deriveStructuredReadiness(snapshot?.structuredIndex)}</Text>
      {layout.showSecondary && <Text>Files: {snapshot?.indexStats?.totalFiles ?? "—"} · Chunks: {snapshot?.indexStats?.totalChunks ?? "—"}</Text>}
      {snapshot?.pipelineProgress.status === "running" && <Text>{snapshot.pipelineProgress.processedFiles}/{snapshot.pipelineProgress.totalFiles} files</Text>}
    </Box>
  </Box>
);
