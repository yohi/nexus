import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import React from "react";
import { useDashboardEndpointDiscovery } from "../../../src/hooks/use-dashboard-endpoint-discovery.js";

function Probe(props: { fixedPort?: number }) {
  const result = useDashboardEndpointDiscovery({ fixedPort: props.fixedPort });
  return <div data-testid="state">{result.connectionState}</div>;
}

describe("useDashboardEndpointDiscovery", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => cleanup());
  afterAll(() => { globalThis.fetch = originalFetch; });

  it("connects to a fixed port", async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/metrics/json")) {
        return {
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => [{ name: "nexus_event_queue_size", values: [{ value: 0 }] }],
        } as unknown as Response;
      }
      if (url.endsWith("/status")) {
        return {
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ status: "ok", snapshot: { providerStatus: { providerName: null, health: "unknown" } } }),
        } as unknown as Response;
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const { getByTestId } = render(<Probe fixedPort={9464} />);
    await waitFor(() => expect(getByTestId("state").textContent).toBe("connected"));
  });
});
