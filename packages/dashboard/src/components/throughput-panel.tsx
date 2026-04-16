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
          <Text dimColor>Series: {samples.length}</Text>
        </Box>
      )}
    </MetricPanel>
  );
};

