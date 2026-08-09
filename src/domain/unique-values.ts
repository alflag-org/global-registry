export function hasUniqueValues<T>(values: readonly T[]): boolean {
  return new Set(values).size === values.length;
}
