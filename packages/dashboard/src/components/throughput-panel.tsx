import React from "react";
import { Box, Text } from "ink";
import type { MetricsJSON, MetricValue } from "../hooks/use-metrics.js";
import { getValue } from "../utils/metrics.js";
import { MetricPanel } from "./metric-panel.js";

interface ThroughputPanelProps {
  data: MetricsJSON[] | null;
}

export const ThroughputPanel: React.FC<ThroughputPanelProps> = ({ data }) => {
  const chunks = getValue(data, "nexus_indexing_chunks_total");
  const samples =
    data?.find((m) => m.name === "nexus_reindex_duration_seconds")?.values ??
    [];
  const avgDuration = calculateAvgDuration(samples);

  return (
    <MetricPanel title="Indexing Throughput" icon="⚡" borderColor="green">
      <Box>
        <Text>Chunks Indexed: </Text>
        <Text bold color="cyan">
          {chunks}
        </Text>
      </Box>
      <Box>
        <Text>Avg Reindex Time: </Text>
        <Text color="yellow">{avgDuration}</Text>
      </Box>
      {samples.length > 0 && (
        <Box marginTop={1}>
          <Text dimColor>Samples: {samples.length}</Text>
        </Box>
      )}
    </MetricPanel>
  );
};

function calculateAvgDuration(samples: MetricValue[]): string {
  if (!samples || samples.length === 0) return "N/A";

  let totalSum = 0;
  let totalCount = 0;
  
  for (const s of samples) {
    const labels = s.labels;
    if (!labels) continue;
    
    const metricName = labels["__name__"];
    if (metricName?.endsWith("_sum")) totalSum = s.value;
    if (metricName?.endsWith("_count")) totalCount = s.value;
  }

  if (totalCount === 0) return "0s";
  const avg = totalSum / totalCount;
  return avg < 1 ? `${(avg * 1000).toFixed(0)}ms` : `${avg.toFixed(1)}s`;
}
