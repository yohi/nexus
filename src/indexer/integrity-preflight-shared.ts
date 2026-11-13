export function sameSorted<T>(left: readonly T[], right: readonly T[], key: (value: T) => string): boolean {
  return JSON.stringify(left.map(key).sort()) === JSON.stringify(right.map(key).sort());
}
