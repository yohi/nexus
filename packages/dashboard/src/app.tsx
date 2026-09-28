import React from "react";
import { Box, Text, useInput, useApp } from "ink";
import { useMetrics, type MetricsStatus } from "./hooks/use-metrics.js";
import { QueuePanel } from "./components/queue-panel.js";
import { ThroughputPanel } from "./components/throughput-panel.js";
import { DlqPanel } from "./components/dlq-panel.js";

interface AppProps {
  port?: number;
  interval?: number;
}

const STATUS_COLORS = new Map<MetricsStatus, string>([
  ["waiting", "magenta"],
  ["unavailable", "red"],
  ["connected", "green"],
]);

const STATUS_MESSAGES = new Map<MetricsStatus, string>([
  ["waiting", "● [waiting]     Waiting for metrics..."],
  ["unavailable", "● [unavailable] Metrics endpoint unavailable"],
  ["connected", "● [connected]   Successfully connected"],
]);

export const App: React.FC<AppProps> = ({ port = 9464, interval = 2000 }) => {
  const { exit } = useApp();
  const { status, current, error } = useMetrics({ port, enabled: true, interval });

  const statusColor = STATUS_COLORS.get(status) ?? "gray";
  const statusMessage = STATUS_MESSAGES.get(status) ?? status;

  useInput((input) => {
    if (input === "q") {
      exit();
    }
  });

  return (
    <Box flexDirection="column" padding={1} width="100%">
      <Box width="100%" justifyContent="center" marginBottom={1}>
        <Box borderStyle="double" borderColor="cyan" paddingX={2}>
          <Text bold color="cyan">
            Nexus Observability Dashboard
          </Text>
        </Box>
      </Box>

      <Box flexDirection="row" gap={1} width="100%" flexWrap="wrap">
        <QueuePanel data={current} />
        <ThroughputPanel data={current} />
        <DlqPanel data={current} />
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text dimColor>Status: </Text>
          <Text color={statusColor}>
            {statusMessage}
          </Text>
        </Box>
        {error && (
          <Box>
            <Text dimColor>Error: </Text>
            <Text color="red">{error}</Text>
          </Box>
        )}
        <Box>
          <Text dimColor>Endpoint: http://localhost:{port}/metrics/json</Text>
        </Box>
        <Box>
          <Text dimColor>Refresh: {interval}ms | Press 'q' to quit</Text>
        </Box>
      </Box>
    </Box>
  );
};
