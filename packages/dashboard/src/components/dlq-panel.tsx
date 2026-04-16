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
  const retried = getValue(data, "nexus_dlq_recovery_total", "result", "retried");
  const purged = getValue(data, "nexus_dlq_recovery_total", "result", "purged");
  
  const health = size === 0 ? "healthy" : size < 100 ? "warning" : "critical";
  const healthColor =
    health === "healthy" ? "green" : health === "warning" ? "yellow" : "red";

  return (
    <MetricPanel title="DLQ Health" icon="🪦" borderColor="red">
      <Box gap={3}>
        <Text>Pending: {size}</Text>
        <Text>Retried: {retried}</Text>
        <Text>Purged: {purged}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          Status:{" "}
          <Text bold color={healthColor}>
            {health === "healthy" ? "● Healthy" : health === "warning" ? "● Warning" : "● Critical"}
          </Text>
        </Text>
      </Box>
    </MetricPanel>
  );
};
