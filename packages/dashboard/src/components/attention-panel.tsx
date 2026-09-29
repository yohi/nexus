import React from "react";
import { Box, Text } from "ink";
import type { AttentionItem } from "../utils/attention.js";

export interface AttentionPanelProps {
  readonly items: readonly AttentionItem[];
}

export const AttentionPanel: React.FC<AttentionPanelProps> = ({ items }) => (
  <Box flexDirection="column" marginBottom={1}>
    <Text bold color={items.length > 0 ? "yellow" : "green"}>Attention</Text>
    {items.length === 0 ? <Text color="green">No active issues</Text> : items.map((item, index) => (
      <Text key={`${item.reason}-${index}`} color="yellow">• {item.reason}{item.detail ? `: ${item.detail}` : ""}</Text>
    ))}
  </Box>
);
