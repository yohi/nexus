import type { IncomingMessage, ServerResponse } from "node:http";
import type { DashboardIndexStatusResult } from "../server/tools/build-dashboard-index-status-snapshot.js";

export interface DashboardStatusEndpoint {
  handler(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

export function createDashboardStatusEndpoint(
  buildSnapshot: () => Promise<DashboardIndexStatusResult>,
): DashboardStatusEndpoint {
  return {
    async handler(req, res) {
      if (req.method !== "GET") {
        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", error: "Method not allowed" }));
        return;
      }
      if (req.url !== "/status") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", error: "Not found" }));
        return;
      }
      try {
        const snapshot = await buildSnapshot();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", snapshot }, null, 2));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "error", error: msg }));
      }
    },
  };
}
