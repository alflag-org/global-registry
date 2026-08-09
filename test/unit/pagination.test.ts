import { describe, expect, it } from 'vitest';
import {
  boundedPageLimit,
  DEFAULT_PAGE_SIZE,
  MAX_AUDIT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '../../src/domain/models/pagination';

describe('pagination limits', () => {
  it('uses the shared default and clamps direct repository input', () => {
    expect(boundedPageLimit(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(boundedPageLimit(0)).toBe(1);
    expect(boundedPageLimit(-10)).toBe(1);
    expect(boundedPageLimit(MAX_PAGE_SIZE + 1)).toBe(MAX_PAGE_SIZE);
    expect(boundedPageLimit(12.5)).toBe(DEFAULT_PAGE_SIZE);
  });

  it('allows the larger shared bound only for audit pages', () => {
    expect(boundedPageLimit(MAX_AUDIT_PAGE_SIZE, MAX_AUDIT_PAGE_SIZE, 100)).toBe(
      MAX_AUDIT_PAGE_SIZE,
    );
    expect(boundedPageLimit(MAX_AUDIT_PAGE_SIZE + 1, MAX_AUDIT_PAGE_SIZE, 100)).toBe(
      MAX_AUDIT_PAGE_SIZE,
    );
  });
});
