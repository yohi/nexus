import React from "react";
import { Box, Text } from "ink";
import type { DashboardIndexStatusResult } from "../types/dashboard-index-status.js";
import { deriveMainReadiness, deriveStructuredReadiness } from "../utils/readiness.js";

export const IndexView: React.FC<{ readonly snapshot: DashboardIndexStatusResult | null }> = ({ snapshot }) => (
  <Box flexDirection="column">
    <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1} flexGrow={1} flexBasis="33%" minWidth={30}>
      <Text bold>📚 Index readiness</Text>
      <Box flexDirection="column">
        <Text>Main index: {deriveMainReadiness(snapshot)}</Text>
        <Text>Structured index: {deriveStructuredReadiness(snapshot?.structuredIndex)}</Text>
        <Text>Files: {snapshot?.indexStats?.totalFiles ?? "Unavailable"}</Text>
        <Text>Chunks: {snapshot?.indexStats?.totalChunks ?? "Unavailable"}</Text>
        <Text>Last indexed: {snapshot?.indexStats?.lastIndexedAt ?? "Never"}</Text>
        <Text>Vector chunks: {snapshot?.vectorStats.totalChunks ?? "Unavailable"}</Text>
        <Text>Vector files: {snapshot?.vectorStats.totalFiles ?? "Unavailable"}</Text>
        <Text>Vector dimensions: {snapshot?.vectorStats.dimensions ?? "Unavailable"}</Text>
        <Text>Vector fragmentation: {snapshot?.vectorStats.fragmentationRatio ?? "Unavailable"}</Text>
        <Text>Pipeline progress: {snapshot?.pipelineProgress.processedFiles ?? 0} / {snapshot?.pipelineProgress.totalFiles ?? 0} ({snapshot?.pipelineProgress.status ?? "Unavailable"})</Text>
        <Text>Current file: {snapshot?.pipelineProgress.currentFile ?? "—"}</Text>
        <Text>Skipped files: {snapshot?.skippedFiles ?? "Unavailable"}</Text>
        <Text>Structured symbols: {snapshot?.structuredIndex?.totalSymbols ?? "Unavailable"}</Text>
        <Text>Exact files: {snapshot?.structuredIndex?.exactFiles ?? "Unavailable"}</Text>
        <Text>Pending files: {snapshot?.structuredIndex?.pendingFiles ?? "Unavailable"}</Text>
        <Text>Schema: {snapshot?.structuredIndex ? `${snapshot.structuredIndex.schemaVersion ?? "—"} / ${snapshot.structuredIndex.targetSchemaVersion}` : "Unavailable"}</Text>
        <Text>Rebuild state: {snapshot?.structuredIndex?.rebuildState ?? "—"}</Text>
        {snapshot?.indexStats?.lastError && <Text color="red">Error: {snapshot.indexStats.lastError}</Text>}
        {snapshot?.pipelineProgress.lastError && <Text color="red">Pipeline: {snapshot.pipelineProgress.lastError}</Text>}
      </Box>
    </Box>
  </Box>
);
