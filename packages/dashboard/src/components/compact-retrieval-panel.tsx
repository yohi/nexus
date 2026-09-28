import React from "react";
import { Box, Text } from "ink";
import type { MetricsJSON } from "../hooks/use-metrics.js";
import type { MetricsHistory } from "../utils/metrics-history.js";
import { valueFromMetric } from "../utils/value-state.js";
import { renderSparkline } from "../utils/sparkline.js";
import type { LayoutPolicy } from "./overview-view.js";

export const CompactRetrievalPanel: React.FC<{ readonly metrics: MetricsJSON[] | null; readonly history: MetricsHistory; readonly layout: LayoutPolicy }> = ({ metrics, history, layout }) => {
  const hits = valueFromMetric("nexus_search_results_hits", metrics);
  const series = history.getSeriesExact("nexus_search_results_hits");
  return <Box flexDirection="column" borderStyle={layout.showDecorations ? "round" : undefined} borderColor={layout.showDecorations ? "cyan" : undefined} paddingX={layout.showDecorations ? 1 : 0} flexGrow={1} flexBasis="33%" minWidth={30}>
    <Text bold>🔎 Retrieval</Text>
    <Box flexDirection="column">
      <Text>Search hits: {hits.kind === "available" ? hits.value : hits.kind === "waiting" ? "Waiting" : "Unavailable"}</Text>
      {layout.showSparklines && <Text>{renderSparkline(series)}</Text>}
      {layout.showSupplemental && <Text dimColor>Recent samples: {series.length}</Text>}
    </Box>
  </Box>;
};
