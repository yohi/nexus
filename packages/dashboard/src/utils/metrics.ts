import type { MetricsJSON } from "../hooks/use-metrics.js";

export function getValue(
  data: MetricsJSON[] | null,
  name: string,
  labelKey?: string,
  labelVal?: string,
): number {
  if (!data) return 0;

  const metric = data.find((m) => m.name === name);
  if (!metric || !metric.values) return 0;

  if (labelKey && labelVal) {
    const matchingValue = metric.values.find(
      (v) => v.labels?.[labelKey] === labelVal
    );
    return matchingValue?.value ?? 0;
  }

  return metric.values[0]?.value ?? 0;
}
