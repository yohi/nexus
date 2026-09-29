import { afterEach, describe, expect, it } from "vitest";
import { render, cleanup } from "@testing-library/react";
import React from "react";
import { OverviewView } from "../../src/components/overview-view.js";
import { MetricsHistory } from "../../src/utils/metrics-history.js";

describe("OverviewView", () => {
  afterEach(() => cleanup());

  it("renders without crashing when no snapshot is available", () => {
    const { container } = render(
      <OverviewView
        connectionState="waiting"
        snapshot={null}
        metrics={null}
        history={new MetricsHistory()}
        layout={{ showSparklines: true, showSupplemental: true, showSecondary: true, showDecorations: true, showProviderPanel: true, showQueuePanel: true }}
        port={null}
      />
    );
    expect(container.textContent).toContain("Waiting");
  });

  it("hides sparklines first on narrow widths", () => {
    const { container: wide } = render(
      <OverviewView connectionState="connected" snapshot={null} metrics={[{ name: "nexus_search_results_hits", values: [{ metricName: "nexus_search_results_hits_sum", labels: { search_type: "grep" }, value: 1 }, { metricName: "nexus_search_results_hits_count", labels: { search_type: "grep" }, value: 2 }] }]} history={new MetricsHistory()} layout={{ showSparklines: true, showSupplemental: true, showSecondary: true, showDecorations: true, showProviderPanel: true, showQueuePanel: true }} port={null} />
    );
    const { container: narrow } = render(
      <OverviewView connectionState="connected" snapshot={null} metrics={[{ name: "nexus_search_results_hits", values: [{ metricName: "nexus_search_results_hits_sum", labels: { search_type: "grep" }, value: 1 }, { metricName: "nexus_search_results_hits_count", labels: { search_type: "grep" }, value: 2 }] }]} history={new MetricsHistory()} layout={{ showSparklines: false, showSupplemental: true, showSecondary: true, showDecorations: true, showProviderPanel: true, showQueuePanel: true }} port={null} />
    );
    expect(wide.textContent).toContain("▁");
    expect(narrow.textContent).not.toContain("▁");
    expect(wide.textContent).toContain("Retrieval");
    expect(narrow.textContent).toContain("Retrieval");
  });

  it("hides Queue panel before Provider panel on narrow widths", () => {
    const { container: providerOnly } = render(
      <OverviewView connectionState="connected" snapshot={null} metrics={null} history={new MetricsHistory()} layout={{ showSparklines: false, showSupplemental: false, showSecondary: false, showDecorations: false, showProviderPanel: true, showQueuePanel: false }} port={null} />
    );
    const { container: neither } = render(
      <OverviewView connectionState="connected" snapshot={null} metrics={null} history={new MetricsHistory()} layout={{ showSparklines: false, showSupplemental: false, showSecondary: false, showDecorations: false, showProviderPanel: false, showQueuePanel: false }} port={null} />
    );
    expect(providerOnly.textContent).toContain("Provider");
    expect(neither.textContent).not.toContain("Provider");
    expect(providerOnly.textContent).not.toContain("Queue");
    expect(neither.textContent).not.toContain("Queue");
  });
});
