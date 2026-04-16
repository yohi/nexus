import React from "react";
import { Box, Text } from "ink";
import type { MetricsJSON } from "../hooks/use-metrics.js";
import { getValue, getSumByLabel } from "../utils/metrics.js";

interface DlqPanelProps {
  data: MetricsJSON[] | null;
}

export const DlqPanel: React.FC<DlqPanelProps> = ({ data }) => {
  const size = getValue(data, "nexus_dlq_size");
  const retried = getSumByLabel(data, "nexus_dlq_recovery_total", "result", "retried");
  const purged = getSumByLabel(data, "nexus_dlq_recovery_total", "result", "purged");

  const getStatus = (s: number) => {
    if (s === 0) return { label: "Healthy", color: "green" };
    if (s < 100) return { label: "Warning", color: "yellow" };
    return { label: "Critical", color: "red" };
  };

  const status = getStatus(size);

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
          <Text bold color={status.color}>
            ● {status.label}
          </Text>
        </Text>
      </Box>
    </MetricPanel>
  );
};
