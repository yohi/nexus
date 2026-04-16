import React from "react";
import { Box, Text } from "ink";
import type { MetricsJSON } from "../hooks/use-metrics.js";

interface QueuePanelProps {
  data: MetricsJSON[] | null;
}

export const QueuePanel: React.FC<QueuePanelProps> = ({ data }) => {
  const getValue = (
    name: string,
    labelKey?: string,
    labelVal?: string,
  ): number => {
    if (!data) return 0;
    for (const m of data) {
      if (m.name !== name) continue;
      if (!m.values || !m.values[0]) continue;
      if (labelKey && labelVal) {
        const labels = m.values[0].labels;
        if (!labels || labels[labelKey] !== labelVal) continue;
      }
      return m.values[0].value;
    }
    return 0;
  };

  const size = getValue("nexus_queue_size");
  const dropped = getValue("nexus_event_queue_dropped_total");
  const isNormal = getValue("nexus_queue_state", "state", "normal") === 1;
  const isOverflow = getValue("nexus_queue_state", "state", "overflow") === 1;

  const maxSize = 10000;
  const percent = Math.min((size / maxSize) * 100, 100);
  const barWidth = 20;
  const filled = Math.round((barWidth * percent) / 100);
  const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);

  const stateLabel = isNormal ? "NORMAL" : isOverflow ? "OVERFLOW" : "IDLE";
  const stateColor = isNormal ? "green" : isOverflow ? "red" : "yellow";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="blue"
      padding={1}
    >
      <Text bold>📊 Event Queue</Text>
      <Box marginTop={1}>
        <Text>Size: </Text>
        <Text>{size}</Text>
        <Text> / {maxSize}</Text>
      </Box>
      <Box>
        <Text>[{bar}] </Text>
        <Text>{percent.toFixed(1)}%</Text>
      </Box>
      <Box marginTop={1}>
        <Text>State: </Text>
        <Text color={stateColor}>{stateLabel}</Text>
      </Box>
      <Box>
        <Text>Dropped: </Text>
        <Text color={dropped > 0 ? "red" : "white"}>{dropped}</Text>
      </Box>
    </Box>
  );
};
