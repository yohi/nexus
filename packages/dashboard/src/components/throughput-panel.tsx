import React from "react";
import { Box, Text } from "ink";
import type { MetricsJSON, MetricValue } from "../hooks/use-metrics.js";
import { getValue, calculateAvgDuration } from "../utils/metrics.js";
import { MetricPanel } from "./metric-panel.js";

interface ThroughputPanelProps {
  data: MetricsJSON[] | null;
}

export const ThroughputPanel: React.FC<ThroughputPanelProps> = ({ data }) => {
  const chunks = getValue(data, "nexus_indexing_chunks_total");
  const metric = data?.find((m) => m.name === "nexus_reindex_duration_seconds");
  const samples = metric?.values ?? [];
  const avgDuration = calculateAvgDuration(samples, metric?.name);

  return (
    <MetricPanel title="Indexing Throughput" icon="🚀" borderColor="green">
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text>Chunks indexed: {chunks} (total)</Text>
        </Box>
        <Box>
          <Text>Avg duration: {avgDuration}</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>History series: {samples.length}</Text>
        </Box>
      </Box>
    </MetricPanel>
  );
};
