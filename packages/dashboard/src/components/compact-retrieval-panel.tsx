import React from "react";
import { Box, Text } from "ink";
import type { MetricsJSON } from "../hooks/use-metrics.js";
import type { MetricsHistory } from "../utils/metrics-history.js";
import { renderSparkline } from "../utils/sparkline.js";
import type { LayoutPolicy } from "./overview-view.js";

function searchTypes(metrics: readonly MetricsJSON[] | null): string[] {
  return [...new Set((metrics ?? []).filter((family) => family.name === "nexus_search_results_hits").flatMap((family) => (family.values ?? []).flatMap((value) => value.labels?.search_type ?? [])))];
}

export const CompactRetrievalPanel: React.FC<{ readonly metrics: MetricsJSON[] | null; readonly history: MetricsHistory; readonly layout: LayoutPolicy }> = ({ metrics, history, layout }) => {
  const types = searchTypes(metrics);
  return <Box flexDirection="column" borderStyle={layout.showDecorations ? "round" : undefined} borderColor={layout.showDecorations ? "cyan" : undefined} paddingX={layout.showDecorations ? 1 : 0} flexGrow={1} flexBasis="33%" minWidth={30}>
    <Text bold>🔎 Retrieval</Text>
    <Box flexDirection="column">
      {types.length === 0 ? <Text>Search hits: Unavailable</Text> : types.map((type) => {
        const labels = { search_type: type };
        const series = history.getSeriesExact("nexus_search_results_hits_sum", labels);
        return <Box key={type} flexDirection="column">
          <Text>{type}: {history.getHistogramMean("nexus_search_results_hits", labels)?.toFixed(3) ?? "—"} average hits</Text>
          {layout.showSparklines && <Text>{renderSparkline(series)}</Text>}
          {layout.showSupplemental && <Text dimColor>Recent samples: {series.length}</Text>}
        </Box>;
      })}
    </Box>
  </Box>;
};
