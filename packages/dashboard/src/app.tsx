import React, { useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { useDashboardEndpointDiscovery } from "./hooks/use-dashboard-endpoint-discovery.js";
import { useMetricsHistory } from "./hooks/use-metrics-history.js";
import { Navigation } from "./components/navigation.js";
import { OverviewView, type LayoutPolicy } from "./components/overview-view.js";
import { IndexView } from "./components/index-view.js";
import { RetrievalView } from "./components/retrieval-view.js";
import { ProviderView } from "./components/provider-view.js";
import { DiagnosticsView } from "./components/diagnostics-view.js";

export interface AppProps {
  readonly fixedPort?: number;
  readonly storageDir?: string;
  readonly metricsInterval?: number;
  readonly statusInterval?: number;
}

export const App: React.FC<AppProps> = ({ fixedPort, storageDir, metricsInterval = 2000, statusInterval = 10_000 }) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [activeView, setActiveView] = useState(0);
  const { port, connectionState, metrics, status } = useDashboardEndpointDiscovery({ fixedPort, storageDir, metricsInterval, statusInterval });
  const width = stdout?.columns ?? 80;
  const layout: LayoutPolicy = {
    showSparklines: width >= 80,
    showSupplemental: width >= 70,
    showSecondary: width >= 60,
    showDecorations: width >= 50,
    showProviderPanel: width >= 35,
    showQueuePanel: width >= 45,
  };
  const { history } = useMetricsHistory({ data: metrics.current, port, generation: metrics.generation });
  const metricsEndpointUrl = port !== null ? `http://127.0.0.1:${port}/metrics/json` : null;
  const statusEndpointUrl = port !== null ? `http://127.0.0.1:${port}/status` : null;
  const views = [
    <OverviewView key="overview" connectionState={connectionState} snapshot={status.current} metrics={metrics.current} history={history} layout={layout} port={port} />,
    <IndexView key="index" snapshot={status.current} />,
    <RetrievalView key="retrieval" metrics={metrics.current} history={history} layout={layout} />,
    <ProviderView key="provider" snapshot={status.current} history={history} layout={layout} />,
    <DiagnosticsView key="diagnostics" connectionState={connectionState} metrics={metrics} status={status} metricsEndpointUrl={metricsEndpointUrl} statusEndpointUrl={statusEndpointUrl} attentionInput={{ snapshot: status.current, connectionState, metricsEndpointUrl, statusEndpointUrl, metrics: metrics.current, history }} layout={layout} />,
  ];

  useInput(
    (input) => {
      if (input === "q") { exit(); return; }
    },
    { isActive: process.stdin.isTTY === true },
  );

  return <Box flexDirection="column" padding={1} width="100%">
    <Box justifyContent="center" marginBottom={1}><Text bold color="cyan">Nexus Live Operations Dashboard</Text></Box>
    <Navigation activeIndex={activeView} onChange={setActiveView} />
    {views[activeView]}
  </Box>;
};
