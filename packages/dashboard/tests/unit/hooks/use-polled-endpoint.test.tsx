import { act, cleanup, render } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePolledEndpoint } from "../../../src/hooks/use-polled-endpoint.js";

const parse = async (response: Response) => response.json();

function Probe() {
  const result = usePolledEndpoint({
    port: 9464,
    enabled: true,
    interval: 1000,
    path: "/test",
    parse,
  });
  return <div data-testid="result">{result.status}:{result.error ?? ""}</div>;
}

describe("usePolledEndpoint", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  it("marks the endpoint unavailable when a request times out", async () => {
    vi.useFakeTimers();
    globalThis.fetch = vi.fn((_input: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));

    const { getByTestId } = render(<Probe />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5001);
    });

    expect(getByTestId("result").textContent).toContain("unavailable:");
  });

  it("skips interval polls while the current request is in flight", async () => {
    vi.useFakeTimers();
    let finishRequest: ((response: Response) => void) | undefined;
    globalThis.fetch = vi.fn(() => new Promise<Response>((resolve) => {
      finishRequest = resolve;
    }));

    render(<Probe />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishRequest?.({
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => ({ value: true }),
      } as Response);
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});
