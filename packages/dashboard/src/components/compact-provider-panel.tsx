import React from "react";
import { Box, Text } from "ink";
import type { DashboardIndexStatusResult } from "../types/dashboard-index-status.js";
import type { LayoutPolicy } from "./overview-view.js";

export const CompactProviderPanel: React.FC<{ readonly snapshot: DashboardIndexStatusResult | null; readonly layout: LayoutPolicy }> = ({ snapshot, layout }) => (
  <Box flexDirection="column" borderStyle={layout.showDecorations ? "round" : undefined} borderColor={layout.showDecorations ? "magenta" : undefined} paddingX={layout.showDecorations ? 1 : 0} flexGrow={1} flexBasis="33%" minWidth={30}>
    <Text bold>⚙ Provider</Text>
    <Box flexDirection="column">
      <Text>Provider: {snapshot?.providerStatus.providerName ?? "Unavailable"}</Text>
      <Text>Health: {snapshot?.providerStatus.health ?? "unknown"}</Text>
      {layout.showSupplemental && snapshot?.providerStatus.lastError && <Text color="red">{snapshot.providerStatus.lastError}</Text>}
    </Box>
  </Box>
);
