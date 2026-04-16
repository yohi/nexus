import React from "react";
import { Box, Text } from "ink";
import { useMetrics } from "../hooks/use-metrics";
import type { MetricsJSON } from "../hooks/use-metrics";
import { QueuePanel } from "./queue-panel";
import { ThroughputPanel } from "./throughput-panel";
import { DlqPanel } from "./dlq-panel";

interface AppProps {
  port?: number;
  interval?: number;
}

const STATUS_COLORS: Record<string, string> = {
  connecting: "yellow",
  connected: "green",
  waiting: "magenta",
  reconnecting: "red",
};

const STATUS_MESSAGES: Record<string, string> = {
  connecting: "🔌 Connecting to metrics server...",
  connected: "✅ Connected",
  waiting: "⚠️ Waiting for valid JSON response...",
  reconnecting: "🔄 Reconnecting...",
};

export const App: React.FC<AppProps> = ({ port = 9464, interval = 2000 }) => {
  const { status, data, error } = useMetrics({ port, interval });

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
          <Text color={STATUS_COLORS[status] || "white"}>
            {STATUS_MESSAGES[status] || status}
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
