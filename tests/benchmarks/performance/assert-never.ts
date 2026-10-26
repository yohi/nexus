export function assertNever(value: never): never {
  throw new TypeError('unexpected_runtime_variant', { cause: value });
}
