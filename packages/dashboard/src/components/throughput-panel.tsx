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

  // In Prometheus JSON format, histogram sum/count appear as separate value entries 
  // with labels or specific naming conventions if using prom-client's registry.metrics() 
  // but here we are parsing the JSON output from prom-client.
  // Actually, in JSON output, the histogram values usually include '_sum' and '_count' 
  // if they are exported as individual gauges or as part of the values array.
  
  // However, the current data structure (MetricsJSON) comes from fetch(/metrics/json).
  // Let's find entries where labels indicate sum/count or the metric name itself is helpful.
  const sumEntry = samples.find(s => s.labels?.["quantile"] === undefined && s.labels?.["le"] === undefined && !s.labels?.["bucket"]); 
  // This is tricky without knowing the exact JSON format from the server.
  // In many implementations, 'values' for a histogram contain quantiles or buckets.
  // If the server exports _sum and _count as separate metrics (which is common for Gauges),
  // they might not be in the 'values' of the same metric object.
  
  // Based on the instruction, we need to locate them INSIDE the provided samples.
  const sum = samples.find(s => s.labels?.["__name__"]?.endsWith("_sum") || false)?.value;
  const count = samples.find(s => s.labels?.["__name__"]?.endsWith("_count") || false)?.value;

  // Let's try another approach: if it's a standard histogram export in JSON, 
  // it might have specific keys.
  // If we can't find them, fall back to a safer mean of available buckets or N/A.
  
  // Re-reading instruction: "calculateAvgDuration to compute the mean as _sum / _count by locating 
  // the histogram’s _sum and _count entries inside the provided samples"
  
  let totalSum = 0;
  let totalCount = 0;
  
  for (const s of samples) {
    if (s.labels?.["__name__"]?.endsWith("_sum")) totalSum = s.value;
    if (s.labels?.["__name__"]?.endsWith("_count")) totalCount = s.value;
  }

  if (totalCount === 0) return "0s";
  const avg = totalSum / totalCount;
  return avg < 1 ? `${(avg * 1000).toFixed(0)}ms` : `${avg.toFixed(1)}s`;
}
