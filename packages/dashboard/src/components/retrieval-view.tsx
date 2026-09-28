import React from "react";
import { Box, Text } from "ink";
import type { MetricsJSON } from "../hooks/use-metrics.js";
import type { MetricsHistory } from "../utils/metrics-history.js";
import { valueFromMetric } from "../utils/value-state.js";
import { renderSparkline } from "../utils/sparkline.js";
import type { LayoutPolicy } from "./overview-view.js";

export const RetrievalView: React.FC<{ readonly metrics: MetricsJSON[] | null; readonly history: MetricsHistory; readonly layout: LayoutPolicy }> = ({ metrics, history, layout }) => {
  const names = ["nexus_search_results_hits", "nexus_tool_calls_total", "nexus_embedding_requests_total"] as const;
  return <Box flexDirection="column">{names.map((name) => {
    const value = valueFromMetric(name, metrics);
    const series = history.getSeriesExact(name);
    return <Box key={name} flexDirection="column" borderStyle={layout.showDecorations ? "round" : undefined} borderColor={layout.showDecorations ? "cyan" : undefined} paddingX={layout.showDecorations ? 1 : 0} flexGrow={1} flexBasis="33%" minWidth={30}>
      <Text bold>🔎 {name.replace("nexus_", "").replaceAll("_", " ")}</Text>
      <Box flexDirection="column">
        <Text>Current: {value.kind === "available" ? value.value : value.kind === "waiting" ? "Waiting" : "Unavailable"}</Text>
        {layout.showSparklines && <Text>{renderSparkline(series)}</Text>}
        {layout.showSupplemental && <Text>Window change: {history.getDeltaExact(name) ?? "—"}</Text>}
      </Box>
    </Box>;
  })}</Box>;
};
