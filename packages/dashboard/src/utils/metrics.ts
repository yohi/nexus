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

  // If no label filters, return the sum of all values or the first value?
  // Prom-client typically has one value per unique label set.
  // For dashboard metrics like 'size' without specific labels requested, 
  // we usually want the first one or a sum. 
  // To avoid incorrect data from accidental labeled series, let's pick the first one
  // but ensure we're not just assuming values[0] exists.
  return metric.values.length > 0 ? metric.values[0]!.value : 0;
}
