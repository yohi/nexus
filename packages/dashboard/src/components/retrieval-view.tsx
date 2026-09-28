import React from "react";
import { Box, Text } from "ink";
import type { MetricsJSON } from "../hooks/use-metrics.js";
import type { MetricsHistory } from "../utils/metrics-history.js";
import { renderSparkline } from "../utils/sparkline.js";
import type { LayoutPolicy } from "./overview-view.js";

function labelsFor(metrics: readonly MetricsJSON[] | null, name: string, dimension: string): Record<string, string>[] {
  const labels = new Map<string, Record<string, string>>();
  for (const family of metrics ?? []) {
    if (family.name !== name) continue;
    for (const value of family.values ?? []) {
      const labelValue = value.labels?.[dimension];
      if (labelValue === undefined) continue;
      const selected = Object.fromEntries(Object.entries(value.labels ?? {}).filter(([key]) => key === dimension));
      labels.set(JSON.stringify(selected), selected);
    }
  }
  return [...labels.values()];
}

export const RetrievalView: React.FC<{ readonly metrics: MetricsJSON[] | null; readonly history: MetricsHistory; readonly layout: LayoutPolicy }> = ({ metrics, history, layout }) => {
  const tools = labelsFor(metrics, "nexus_tool_calls_total", "tool_name");
  const searchTypes = labelsFor(metrics, "nexus_search_results_hits", "search_type");
  return <Box flexDirection="column">
    <Box flexDirection="column" borderStyle={layout.showDecorations ? "round" : undefined} borderColor={layout.showDecorations ? "cyan" : undefined} paddingX={layout.showDecorations ? 1 : 0}>
      <Text bold>🔎 Tool calls</Text>
      {tools.length === 0 ? <Text>Unavailable</Text> : tools.map((labels) => {
        const name = labels.tool_name ?? "unknown";
        const success = history.sumDeltaMatching("nexus_tool_calls_total", { ...labels, status: "success" });
        const errors = history.sumDeltaMatching("nexus_tool_calls_total", { ...labels, status: "error" });
        const duration = history.getHistogramMean("nexus_tool_duration_seconds", { tool_name: name });
        const series = history.getSeriesExact("nexus_tool_calls_total", { ...labels, status: "success" });
        return <Box key={name} flexDirection="column">
          <Text>{name} · success: {success ?? "—"} · error: {errors ?? "—"}</Text>
          {layout.showSupplemental && <Text>Duration: {duration?.toFixed(3) ?? "—"}s</Text>}
          {layout.showSparklines && <Text>{renderSparkline(series)}</Text>}
        </Box>;
      })}
    </Box>
    <Box flexDirection="column" borderStyle={layout.showDecorations ? "round" : undefined} borderColor={layout.showDecorations ? "cyan" : undefined} paddingX={layout.showDecorations ? 1 : 0}>
      <Text bold>🔎 Search hits by type</Text>
      {searchTypes.length === 0 ? <Text>Unavailable</Text> : searchTypes.map((labels) => {
        const type = labels.search_type ?? "unknown";
        const mean = history.getHistogramMean("nexus_search_results_hits", labels);
        const series = history.getSeriesExact("nexus_search_results_hits_sum", labels);
        return <Box key={type} flexDirection="column">
          <Text>{type}: {mean === null ? "Unavailable" : mean.toFixed(3)} average hits</Text>
          {layout.showSparklines && <Text>{renderSparkline(series)}</Text>}
          {layout.showSupplemental && <Text>Window change: {history.getDeltaExact("nexus_search_results_hits_sum", labels) ?? "—"}</Text>}
        </Box>;
      })}
    </Box>
  </Box>;
};
