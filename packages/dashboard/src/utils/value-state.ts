import type { MetricsJSON } from "../hooks/use-metrics.js";

export type ValueState<T> =
  | { readonly kind: "available"; readonly value: T }
  | { readonly kind: "waiting" }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "unsupported" }
  | { readonly kind: "error"; readonly message: string };

export function available<T>(value: T): ValueState<T> {
  return { kind: "available", value };
}

export function waiting<T>(): ValueState<T> {
  return { kind: "waiting" };
}

export function unavailable<T>(reason: string): ValueState<T> {
  return { kind: "unavailable", reason };
}

export function unsupported<T>(): ValueState<T> {
  return { kind: "unsupported" };
}

export function error<T>(message: string): ValueState<T> {
  return { kind: "error", message };
}

export function valueFromMetric(
  name: string,
  metrics: readonly MetricsJSON[] | null,
  labelKey?: string,
  labelValue?: string,
): ValueState<number> {
  if (!metrics) return waiting();
  const family = metrics.find((metric) => metric.name === name);
  if (!family || !family.values) return unavailable(`Metric ${name} not found`);
  const value = labelKey
    ? family.values.find((entry) => entry.labels?.[labelKey] === labelValue)
    : family.values[0];
  if (!value) return unavailable(`Metric ${name} value not found`);
  return available(value.value);
}
