import React from "react";
import { Box, Text } from "ink";
import type { MetricsJSON } from "../hooks/use-metrics.js";

interface DlqPanelProps {
  data: MetricsJSON[] | null;
}

export const DlqPanel: React.FC<DlqPanelProps> = ({ data }) => {
  const getValue = (name: string): number => {
    if (!data) return 0;
    for (const m of data) {
      if (m.name === name && m.values && m.values[0]) {
        return m.values[0].value;
      }
    }
    return 0;
  };

  const size = getValue("nexus_dlq_size");
  const health = size === 0 ? "healthy" : size < 100 ? "warning" : "critical";
  const healthColor =
    health === "healthy" ? "green" : health === "warning" ? "yellow" : "red";

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="red"
      padding={1}
    >
      <Text bold>🪦 Dead Letter Queue</Text>
      <Box marginTop={1}>
        <Text>Size: </Text>
        <Text color={healthColor}>{size}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>Health: </Text>
        <Text bold color={healthColor}>
          {health.toUpperCase()}
        </Text>
      </Box>
    </Box>
  );
};
