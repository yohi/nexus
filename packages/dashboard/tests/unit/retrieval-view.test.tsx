import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import React from "react";
import { RetrievalView } from "../../src/components/retrieval-view.js";
import { MetricsHistory } from "../../src/utils/metrics-history.js";

const layout = { showSparklines: false, showSupplemental: true, showSecondary: true, showDecorations: false, showProviderPanel: true, showQueuePanel: true };

describe("RetrievalView", () => {
  afterEach(() => cleanup());

  it("renders tool outcome deltas and search hit trends by label", () => {
    const history = new MetricsHistory();
    const previous = [
      { name: "nexus_tool_calls_total", values: [{ labels: { tool_name: "grep_search", status: "success" }, value: 2 }, { labels: { tool_name: "grep_search", status: "error" }, value: 0 }] },
      { name: "nexus_search_results_hits", values: [{ metricName: "nexus_search_results_hits_sum", labels: { search_type: "grep" }, value: 12 }, { metricName: "nexus_search_results_hits_count", labels: { search_type: "grep" }, value: 2 }] },
    ];
    const current = [
      { name: "nexus_tool_calls_total", values: [{ labels: { tool_name: "grep_search", status: "success" }, value: 5 }, { labels: { tool_name: "grep_search", status: "error" }, value: 1 }] },
      { name: "nexus_search_results_hits", values: [{ metricName: "nexus_search_results_hits_sum", labels: { search_type: "grep" }, value: 20 }, { metricName: "nexus_search_results_hits_count", labels: { search_type: "grep" }, value: 3 }] },
    ];
    history.observePoll({ generation: 1, data: previous, timestamp: 1 });
    history.observePoll({ generation: 2, data: current, timestamp: 2 });

    const { container } = render(<RetrievalView metrics={current} history={history} layout={layout} />);

    expect(container.textContent).toContain("grep_search");
    expect(container.textContent?.match(/grep_search/g)).toHaveLength(1);
    expect(container.textContent).toContain("success: 3");
    expect(container.textContent).toContain("error: 1");
    expect(container.textContent).toContain("grep");
    expect(container.textContent).toContain("8");
  });
});
