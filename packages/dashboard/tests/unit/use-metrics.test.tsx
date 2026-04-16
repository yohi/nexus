import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { useMetrics } from "../../src/hooks/use-metrics.js";

const originalFetch = global.fetch;
global.fetch = vi.fn();

const TestComponent: React.FC<{ port?: number; interval?: number }> = ({
  port,
  interval,
}) => {
  const { status } = useMetrics({ port, interval });
  return <div data-testid="status">{status}</div>;
};

describe("useMetrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it("returns connecting status when server is not running", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("Connection refused"));

    const { unmount } = render(<TestComponent port={9464} interval={1000} />);

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(screen.getByTestId("status").textContent).toBe("connecting");
    unmount();
  });

  it("returns connected status after server responds with valid JSON", async () => {
    const mockMetrics = [{ name: "nexus_queue_size", values: [{ value: 5 }] }];
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => mockMetrics,
    } as Response);

    const { unmount } = render(<TestComponent port={9464} interval={1000} />);

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(screen.getByTestId("status").textContent).toBe("connected");
    unmount();
  });

  it("returns waiting status when response is not JSON", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "text/plain" }),
    } as Response);

    const { unmount } = render(<TestComponent port={9464} interval={1000} />);

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(screen.getByTestId("status").textContent).toBe("waiting");
    unmount();
  });

  it("retries after connection is lost", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => [{ name: "test", values: [] }],
    } as Response);

    const { unmount } = render(<TestComponent port={9464} interval={1000} />);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(screen.getByTestId("status").textContent).toBe("connected");

    vi.mocked(fetch).mockRejectedValue(new Error("Connection lost"));

    await new Promise((resolve) => setTimeout(resolve, 2100));

    expect(screen.getByTestId("status").textContent).toBe("reconnecting");
    unmount();
  });

  it("respects the configured polling interval", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => [],
    } as Response);

    const { unmount } = render(<TestComponent port={9464} interval={1000} />);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fetch).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(fetch).toHaveBeenCalledTimes(1);

    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fetch).toHaveBeenCalledTimes(2);
    unmount();
  }, 10000);

  it("reflects custom port in URL", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => [],
    } as Response);

    const { unmount } = render(<TestComponent port={9999} interval={1000} />);

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:9999/metrics/json",
      expect.any(Object),
    );
    unmount();
  });

  it("re-connects when port changes", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => [],
    } as Response);

    const { rerender, unmount } = render(<TestComponent port={9464} interval={1000} />);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:9464/metrics/json",
      expect.any(Object),
    );

    // Change port
    rerender(<TestComponent port={8888} interval={1000} />);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:8888/metrics/json",
      expect.any(Object),
    );
    unmount();
  });
});
