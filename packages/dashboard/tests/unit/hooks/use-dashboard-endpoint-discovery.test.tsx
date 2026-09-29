import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import React from "react";
import { useDashboardEndpointDiscovery } from "../../../src/hooks/use-dashboard-endpoint-discovery.js";

function Probe(props: { fixedPort?: number; storageDir?: string }) {
  const result = useDashboardEndpointDiscovery({ fixedPort: props.fixedPort, storageDir: props.storageDir });
  return (
    <div data-testid="state">
      {result.connectionState}:{result.metrics.status}:{result.status.status}
    </div>
  );
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
    await waitFor(() => expect(getByTestId("state").textContent).toContain("connected:connected:connected"));
  });

  it("discovers an existing runtime immediately on mount", async () => {
    const storageDir = await mkdtemp(path.join(tmpdir(), "nexus-dashboard-discovery-"));
    await writeFile(path.join(storageDir, "metrics.port"), "9465\n", "utf8");
    globalThis.fetch = vi.fn().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/metrics/json")) {
        return { ok: true, headers: new Headers({ "content-type": "application/json" }), json: async () => [] } as unknown as Response;
      }
      if (url.endsWith("/status")) {
        return { ok: true, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ status: "ok", snapshot: { providerStatus: { providerName: null, health: "unknown" } } }) } as unknown as Response;
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    try {
      render(<Probe storageDir={storageDir} />);
      await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith("http://127.0.0.1:9465/metrics/json", expect.anything()), { timeout: 1000 });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  it("keeps one discovery interval when both endpoints are unavailable", async () => {
    const storageDir = await mkdtemp(path.join(tmpdir(), "nexus-dashboard-discovery-"));
    await writeFile(path.join(storageDir, "metrics.port"), "9466\n", "utf8");
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("offline"));

    try {
      const { getByTestId } = render(<Probe storageDir={storageDir} />);
      await waitFor(() => expect(getByTestId("state").textContent).toBe("runtime_unavailable:unavailable:unavailable"));

      expect(setIntervalSpy.mock.calls.filter(([, delay]) => delay === 5000)).toHaveLength(1);
    } finally {
      setIntervalSpy.mockRestore();
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
