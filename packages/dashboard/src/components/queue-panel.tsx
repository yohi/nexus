import React from "react";
import { Box, Text } from "ink";
import type { MetricsJSON } from "../hooks/use-metrics.js";
import { getValue } from "../utils/metrics.js";
import { MetricPanel } from "./metric-panel.js";

interface QueuePanelProps {
  data: MetricsJSON[] | null;
}

export const QueuePanel: React.FC<QueuePanelProps> = ({ data }) => {
  const size = getValue(data, "nexus_event_queue_size", "queue_id", "default");
  const dropped = getValue(
    data,
    "nexus_event_queue_dropped_total",
    "queue_id",
    "default"
  );
  const isNormal =
    getValue(data, "nexus_event_queue_state", "state", "normal") === 1;
  const isOverflow =
    getValue(data, "nexus_event_queue_state", "state", "overflow") === 1;

  const maxSize = 10000;
  const percent = Math.min((size / maxSize) * 100, 100);
  const barWidth = 20;
  const filled = Math.round((barWidth * percent) / 100);
  const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);

  const stateLabel = isNormal ? "NORMAL" : isOverflow ? "OVERFLOW" : "IDLE";

  // Fix "Generic Object Injection Sink" by avoiding dynamic key access
  const stateColor = isNormal ? "green" : isOverflow ? "red" : "yellow";

  return (
    <MetricPanel title="Event Queue" icon="📊" borderColor="blue">
      <Box flexDirection="column" marginTop={1}>
        <Box gap={2}>
          <Text>State: <Text color={stateColor}>{stateLabel.toLowerCase()}</Text></Text>
          <Text>Size: {size}</Text>
        </Box>
        <Box>
          <Text>Dropped: <Text color={dropped > 0 ? "red" : "white"}>{dropped}</Text></Text>
        </Box>
        <Box marginTop={1}>
          <Text>{bar}  {size}/{maxSize}</Text>
        </Box>
      </Box>
    </MetricPanel>
  );
};
