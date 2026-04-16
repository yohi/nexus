import React from "react";
import { Box, Text } from "ink";
import type { MetricsJSON } from "../hooks/use-metrics.js";
import { getValue } from "../utils/metrics.js";
import { MetricPanel } from "./metric-panel.js";

interface DlqPanelProps {
  data: MetricsJSON[] | null;
}

export const DlqPanel: React.FC<DlqPanelProps> = ({ data }) => {
  const size = getValue(data, "nexus_dlq_size");
  const health = size === 0 ? "healthy" : size < 100 ? "warning" : "critical";
  const healthColor =
    health === "healthy" ? "green" : health === "warning" ? "yellow" : "red";

  return (
    <MetricPanel title="Dead Letter Queue" icon="🪦" borderColor="red">
      <Box>
        <Text>Size: </Text>
        <Text color={healthColor}>{size}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>Health: </Text>
        <Text bold color={healthColor}>
          {health.toUpperCase()}
        </Text>
      </Box>
    </MetricPanel>
  );
};
