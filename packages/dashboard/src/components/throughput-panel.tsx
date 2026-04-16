import React from "react";
import { Box, Text } from "ink";
import type { MetricsJSON } from "../hooks/use-metrics.js";
import { getValue } from "../utils/metrics.js";

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
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="green"
      padding={1}
    >
      <Text bold>⚡ Indexing Throughput</Text>
      <Box marginTop={1}>
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
    </Box>
  );
};

function calculateAvgDuration(samples: MetricsJSON["values"]): string {
  if (!samples || samples.length === 0) return "N/A";
  const validSamples = samples.filter(Boolean);
  if (validSamples.length === 0) return "N/A";
  const sum = validSamples.reduce((acc, s) => acc + s.value, 0);
  const avg = sum / validSamples.length;
  return avg < 1 ? "<1s" : `${avg.toFixed(1)}s`;
}
