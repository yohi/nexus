import React from "react";
import { Box, Text, useInput, useApp } from "ink";
import { useMetrics, type MetricsStatus, type MetricsJSON } from "./hooks/use-metrics.js";
import { QueuePanel } from "./components/queue-panel.js";
import { ThroughputPanel } from "./components/throughput-panel.js";
import { DlqPanel } from "./components/dlq-panel.js";

interface AppProps {
  port?: number;
  interval?: number;
}

const STATUS_COLORS = new Map<MetricsStatus, string>([
  ["connecting", "yellow"],
  ["connected", "green"],
  ["waiting", "magenta"],
  ["reconnecting", "red"],
]);

const STATUS_MESSAGES = new Map<MetricsStatus, string>([
  ["connecting", "🔌 Connecting to metrics server..."],
  ["connected", "✅ Connected"],
  ["waiting", "⚠️ Waiting for valid JSON response..."],
  ["reconnecting", "🔄 Reconnecting..."],
]);

export const App: React.FC<AppProps> = ({ port = 9464, interval = 2000 }) => {
  const { exit } = useApp();
  const { status, data, error } = useMetrics({ port, interval });

  const statusColor = STATUS_COLORS.get(status) ?? "gray";
  const statusMessage = STATUS_MESSAGES.get(status) ?? status;

  useInput((input) => {
    if (input === "q") {
      exit();
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          ╔══════════════════════════════════════════╗
        </Text>
      </Box>
      <Box>
        <Text bold color="cyan">
          ║ Nexus Observability Dashboard ║
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          ╚══════════════════════════════════════════╝
        </Text>
      </Box>

      <Box flexDirection="row" gap={1}>
        <QueuePanel data={data} />
        <ThroughputPanel data={data} />
        <DlqPanel data={data} />
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
