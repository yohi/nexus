export function renderSparkline(series: readonly number[], width = 10): string {
  if (width <= 0) return "";
  if (series.length === 0) return "▁".repeat(width);
  const values = series.slice(-width);
  const min = Math.min(...values);
  const range = Math.max(...values) - min || 1;
  const bars = "▁▂▃▄▅▆▇█";
  return values.map((value) => {
    const ratio = (value - min) / range;
    const index = Math.min(bars.length - 1, Math.max(0, Math.floor(ratio * (bars.length - 1))));
    return bars[index] ?? "▁";
  }).join("");
}
