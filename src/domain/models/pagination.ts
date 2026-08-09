export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;
export const DEFAULT_AUDIT_PAGE_SIZE = 100;
export const MAX_AUDIT_PAGE_SIZE = 500;
export const MAX_RESOURCE_DETAIL_PAGE_SIZE = 100;
export const MAX_DRIFTS_PER_RESOURCE = 500;

export function boundedPageLimit(
  value: number | undefined,
  maximum = MAX_PAGE_SIZE,
  fallback = DEFAULT_PAGE_SIZE,
): number {
  if (value === undefined || !Number.isSafeInteger(value)) return fallback;
  return Math.min(Math.max(value, 1), maximum);
}
