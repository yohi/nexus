const compareCodeUnitStrings = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }

  const entries = Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => compareCodeUnitStrings(left, right));
  return `{${entries.map(([key, nestedValue]) =>
    `${JSON.stringify(key)}:${canonicalJson(nestedValue)}`).join(',')}}`;
};
