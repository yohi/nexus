import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import React from "react";
import { ProviderView } from "../../src/components/provider-view.js";
import { MetricsHistory } from "../../src/utils/metrics-history.js";

describe("ProviderView", () => {
  afterEach(() => cleanup());

  it("uses the active provider label when calculating duration mean", () => {
    const history = new MetricsHistory();
    const samples = (sum: number, count: number) => [
      { name: "nexus_embedding_duration_seconds", values: [
        { metricName: "nexus_embedding_duration_seconds_sum", labels: { provider: "bedrock" }, value: sum },
        { metricName: "nexus_embedding_duration_seconds_count", labels: { provider: "bedrock" }, value: count },
      ] },
    ];
    history.observePoll({ generation: 1, data: samples(2, 1), timestamp: 1 });
    history.observePoll({ generation: 2, data: samples(5, 2), timestamp: 2 });
    const snapshot = { providerStatus: { providerName: "bedrock", health: "healthy" } } as const;

    const { container } = render(<ProviderView snapshot={snapshot as never} history={history} layout={{ showSparklines: true, showSupplemental: true, showSecondary: true, showDecorations: false, showProviderPanel: true, showQueuePanel: true }} />);

    expect(container.textContent).toContain("Average duration: 3.000s");
  });
});
