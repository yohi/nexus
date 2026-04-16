import type { MetricsJSON } from "../hooks/use-metrics.js";

export function getValue(
  data: MetricsJSON[] | null,
  name: string,
  labelKey?: string,
  labelVal?: string,
): number {
  if (!data) return 0;

  const metric = data.find((m) => {
    if (m.name !== name) return false;
    const firstValue = m.values?.[0];
    if (!firstValue) return false;

    if (labelKey && labelVal) {
      return firstValue.labels?.[labelKey] === labelVal;
    }
    return true;
  });

  return metric?.values?.[0]?.value ?? 0;
}
