import React from "react";
import { Box, Text } from "ink";
import type { MetricsJSON } from "../hooks/use-metrics.js";
import { valueFromMetric } from "../utils/value-state.js";
import type { LayoutPolicy } from "./overview-view.js";

export const CompactQueuePanel: React.FC<{ readonly metrics: MetricsJSON[] | null; readonly layout: LayoutPolicy }> = ({ metrics, layout }) => {
  const queue = valueFromMetric("nexus_event_queue_size", metrics, "queue_id", "default");
  const dlq = valueFromMetric("nexus_dlq_size", metrics);
  const display = (value: typeof queue) => value.kind === "available" ? value.value : value.kind === "waiting" ? "Waiting" : "Unavailable";
  return <Box flexDirection="column" borderStyle={layout.showDecorations ? "round" : undefined} borderColor={layout.showDecorations ? "blue" : undefined} paddingX={layout.showDecorations ? 1 : 0} flexGrow={1} flexBasis="33%" minWidth={30}>
    <Text bold>📊 Queue</Text>
    <Box flexDirection="column">
      <Text>Queue size: {display(queue)}</Text>
      {layout.showSecondary && <Text>DLQ: {display(dlq)}</Text>}
    </Box>
  </Box>;
};
