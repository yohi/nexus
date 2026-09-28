import { describe, it, expect, vi, afterAll, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";
import { useMetrics } from "../../src/hooks/use-metrics.js";

describe("useMetrics", () => {
  const originalFetch = globalThis.fetch;
  beforeEach(() => { globalThis.fetch = vi.fn(); });
  afterEach(() => { cleanup(); });
  afterAll(() => { globalThis.fetch = originalFetch; });

  it("starts waiting when disabled", () => {
    const { result } = renderHook(() => useMetrics({ port: 9464, enabled: false }));
    expect(result.current.status).toBe("waiting");
    expect(result.current.current).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("moves to unavailable on fetch failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const { result } = renderHook(() => useMetrics({ port: 9464, enabled: true }));
    await waitFor(() => expect(result.current.status).toBe("unavailable"));
    expect(result.current.current).toBeNull();
    expect(result.current.lastErrorAt).not.toBeNull();
  });

  it("becomes connected on valid response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => [{ name: "nexus_event_queue_size", values: [{ value: 0 }] }],
    } as unknown as Response);
    const { result } = renderHook(() => useMetrics({ port: 9464, enabled: true }));
    await waitFor(() => expect(result.current.status).toBe("connected"));
    expect(result.current.current).toHaveLength(1);
    expect(result.current.stale).toBeNull();
    expect(result.current.lastSuccessAt).not.toBeNull();
  });

  it("keeps the last successful value stale through consecutive failures", async () => {
    let call = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      call++;
      if (call === 1) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: async () => [{ name: "nexus_event_queue_size", values: [{ value: 0 }] }],
        } as unknown as Response);
      }
      return Promise.reject(new Error("ECONNREFUSED"));
    });
    const { result } = renderHook(() => useMetrics({ port: 9464, enabled: true, interval: 25 }));
    await new Promise((r) => setTimeout(r, 15));
    await waitFor(() => expect(result.current.status).toBe("connected"), { timeout: 500 });
    await waitFor(() => expect(result.current.status).toBe("unavailable"), { timeout: 1000 });
    await waitFor(() => expect(call).toBeGreaterThanOrEqual(3), { timeout: 1000 });
    expect(result.current.current).toBeNull();
    expect(result.current.stale).toHaveLength(1);
  });

  it("does not fetch when port is null", () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("should not call"));
    const { result } = renderHook(() => useMetrics({ port: null, enabled: true }));
    expect(result.current.status).toBe("waiting");
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
