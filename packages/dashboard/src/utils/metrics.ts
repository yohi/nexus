import type { MetricsJSON } from "../hooks/use-metrics.js";

export function getValue(
  data: MetricsJSON[] | null,
  name: string,
  labelKey?: string,
  labelVal?: string,
): number {
  if (!data) return 0;
  for (const m of data) {
    if (m.name !== name) continue;
    if (!m.values || !m.values[0]) continue;
    if (labelKey && labelVal) {
      const labels = m.values[0].labels;
      if (!labels || labels[labelKey] !== labelVal) continue;
    }
    return m.values[0].value;
  }
  return 0;
}
