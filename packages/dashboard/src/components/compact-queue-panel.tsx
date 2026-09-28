import React from "react";
import { Text } from "ink";
import type { MetricsJSON } from "../hooks/use-metrics.js";
import { valueFromMetric } from "../utils/value-state.js";
import type { LayoutPolicy } from "./overview-view.js";
import { MetricPanel } from "./metric-panel.js";

export const CompactQueuePanel: React.FC<{ readonly metrics: MetricsJSON[] | null; readonly layout: LayoutPolicy }> = ({ metrics, layout }) => {
  const queue = valueFromMetric("nexus_event_queue_size", metrics, "queue_id", "default");
  const dlq = valueFromMetric("nexus_dlq_size", metrics);
  const display = (value: typeof queue) => value.kind === "available" ? value.value : value.kind === "waiting" ? "Waiting" : "Unavailable";
  return <MetricPanel title="Queue" icon="📊" borderColor={layout.showDecorations ? "blue" : undefined}>
    <Text>Queue size: {display(queue)}</Text>
    {layout.showSecondary && <Text>DLQ: {display(dlq)}</Text>}
  </MetricPanel>;
};
