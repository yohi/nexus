export function sameSorted<T>(left: readonly T[], right: readonly T[], key: (value: T) => string): boolean {
  const compare = (first: string, second: string): number => first.localeCompare(second);
  return JSON.stringify(left.map(key).sort(compare)) === JSON.stringify(right.map(key).sort(compare));
}
