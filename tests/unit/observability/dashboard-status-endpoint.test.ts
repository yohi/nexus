import { describe, it, expect, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createDashboardStatusEndpoint } from "../../../src/observability/dashboard-status-endpoint.js";
import type { DashboardIndexStatusResult } from "../../../src/server/tools/build-dashboard-index-status-snapshot.js";

const createStubRes = () => {
  let statusCode = 0;
  const headers: Record<string, string> = {};
  const chunks: string[] = [];
  const res = {
    writeHead(code: number, h: Record<string, string>) {
      statusCode = code;
      for (const [key, value] of Object.entries(h)) {
        headers[key.toLowerCase()] = value;
      }
    },
    write(chunk: string) { if (chunk) chunks.push(chunk); },
    end(body?: string) { if (body) chunks.push(body); },
  } as unknown as ServerResponse;
  return { res, get statusCode() { return statusCode; }, get headers() { return headers; }, get body() { return chunks.join(""); } };
};

describe("createDashboardStatusEndpoint", () => {
  it("returns 405 for non-GET requests", async () => {
    const builder = vi.fn();
    const endpoint = createDashboardStatusEndpoint(builder);
    const stub = createStubRes();

    await endpoint.handler({ method: "POST", url: "/status" } as IncomingMessage, stub.res);

    expect(stub.statusCode).toBe(405);
    expect(JSON.parse(stub.body)).toEqual({ status: "error", error: "Method not allowed" });
  });

  it("returns snapshot JSON on GET /status", async () => {
    const snapshot: DashboardIndexStatusResult = {
      indexStats: { id: "primary", totalFiles: 0, totalChunks: 0, lastIndexedAt: null, lastFullScanAt: null, overflowCount: 0, lastError: null },
      vectorStats: { totalChunks: 0, totalFiles: 0, dimensions: 0, fragmentationRatio: 0 },
      skippedFiles: 0,
      pipelineProgress: { totalFiles: 0, processedFiles: 0, status: "idle" },
      providerStatus: { providerName: null, health: "unknown", lastError: null },
    };
    const builder = vi.fn().mockResolvedValue(snapshot);
    const endpoint = createDashboardStatusEndpoint(builder);
    const stub = createStubRes();

    await endpoint.handler({ method: "GET", url: "/status" } as IncomingMessage, stub.res);

    expect(stub.statusCode).toBe(200);
    expect(stub.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(stub.body)).toEqual({ status: "ok", snapshot });
  });

});
