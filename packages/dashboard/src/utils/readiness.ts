import type { DashboardIndexStatusResult } from "../types/dashboard-index-status.js";

export type MainReadiness = "Failed" | "Indexing" | "Ready" | "Not ready" | "Unavailable";
export type StructuredReadiness = "Ready" | "Indexing" | "Failed" | "Reindex required" | "Unsupported" | "Unavailable";

export function deriveMainReadiness(snapshot: DashboardIndexStatusResult | null): MainReadiness {
  if (!snapshot) return "Unavailable";
  if (snapshot.indexStats?.lastError != null || snapshot.pipelineProgress.lastError != null) return "Failed";
  if (snapshot.pipelineProgress.status === "running") return "Indexing";
  if (snapshot.indexStats?.lastIndexedAt != null) return "Ready";
  return "Not ready";
}

export function deriveStructuredReadiness(
  structuredIndex: DashboardIndexStatusResult["structuredIndex"],
): StructuredReadiness {
  if (!structuredIndex) return "Unavailable";
  switch (structuredIndex.status) {
    case "idle": return "Ready";
    case "building": return "Indexing";
    case "failed": return "Failed";
    case "reindex_required": return "Reindex required";
    case "unsupported": return "Unsupported";
    default: return "Unavailable";
  }
}
