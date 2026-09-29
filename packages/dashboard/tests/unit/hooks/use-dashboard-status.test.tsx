import { describe, it, expect, vi, afterEach, afterAll } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import React from "react";
import { useDashboardStatus } from "../../../src/hooks/use-dashboard-status.js";

function Probe(props: Parameters<typeof useDashboardStatus>[0]) {
  const result = useDashboardStatus(props);
  return <div data-testid="status" data-stale={result.stale ? "yes" : "no"}>{result.status}</div>;
}

describe("useDashboardStatus", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => cleanup());
  afterAll(() => { globalThis.fetch = originalFetch; });

  it("starts waiting and becomes connected on valid JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ status: "ok", snapshot: { skippedFiles: 0, providerStatus: { providerName: null, health: "unknown" } } }),
    } as unknown as Response);

    const { getByTestId } = render(<Probe port={9464} enabled={true} interval={1000} />);
    expect(getByTestId("status").textContent).toBe("waiting");
    await new Promise((r) => setTimeout(r, 50));
    expect(getByTestId("status").textContent).toBe("connected");
  });

  it("keeps the last successful snapshot stale through consecutive failures", async () => {
    const snapshot = { skippedFiles: 0, providerStatus: { providerName: null, health: "unknown" } };
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => ({ status: "ok", snapshot }),
        } as unknown as Response);
      }
      return Promise.reject(new Error("ECONNREFUSED"));
    });

    const { getByTestId } = render(<Probe port={9464} enabled={true} interval={25} />);
    await waitFor(() => {
      expect(call).toBeGreaterThanOrEqual(3);
      expect(getByTestId("status").textContent).toBe("unavailable");
    });
    expect(getByTestId("status").getAttribute("data-stale")).toBe("yes");
  });
});
