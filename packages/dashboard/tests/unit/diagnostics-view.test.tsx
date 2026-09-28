import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import React from "react";
import { DiagnosticsView } from "../../src/components/diagnostics-view.js";
import { MetricsHistory } from "../../src/utils/metrics-history.js";

describe("DiagnosticsView", () => {
  afterEach(() => cleanup());

  it("renders Attention source, reason, and canonical field path", () => {
    const snapshot = {
      indexStats: { lastError: "disk failure" },
      pipelineProgress: { lastError: null },
      structuredIndex: undefined,
      providerStatus: { providerName: "bedrock", health: "unknown" },
    };
    const { container } = render(<DiagnosticsView
      connectionState="connected"
      metrics={{ status: "connected", current: [], stale: null, error: null, lastSuccessAt: 1, lastErrorAt: null, generation: 1 }}
      status={{ status: "connected", current: snapshot as never, stale: null, error: null, lastSuccessAt: 1, lastErrorAt: null, generation: 1 }}
      metricsEndpointUrl="http://127.0.0.1:9000/metrics/json"
      statusEndpointUrl="http://127.0.0.1:9000/status"
      attentionInput={{ snapshot: snapshot as never, connectionState: "connected", metricsEndpointUrl: null, statusEndpointUrl: null, metrics: [], history: new MetricsHistory() }}
      layout={{ showSparklines: false, showSupplemental: false, showSecondary: false, showDecorations: false, showProviderPanel: false, showQueuePanel: false }}
    />);

    expect(container.textContent).toContain("canonical");
    expect(container.textContent).toContain("Index build failed");
    expect(container.textContent).toContain("indexStats.lastError");
  });
});
