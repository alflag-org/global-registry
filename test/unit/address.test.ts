import { describe, it, expect } from 'vitest';
import { address, prefix, contains, firstAvailable } from '../../src/ipam/address';

describe('IP literals and ranges', () => {
  it('normalizes IPv4 and IPv6 networks', () => {
    expect(prefix('10.10.10.5/24').cidr).toBe('10.10.10.0/24');
    expect(prefix('2001:0DB8:0000:0000::AbCd/64').cidr).toBe('2001:db8::/64');
    expect(address('2001:0db8::0010').address).toBe('2001:db8::10');
  });
  it.each([
    '999.1.1.1',
    '10.1',
    '010.0.0.1',
    '0x7f000001',
    '1.2.3.4/24',
    'fe80::1%eth0',
    '2001:::1',
  ])('rejects invalid/ambiguous literal %s', (value) => expect(() => address(value)).toThrow());
  it.each([
    '10.0.0.1/33',
    '2001:db8::/129',
    '10.0.0.1',
    '10.1/16',
    'fe80::1%eth0/64',
    '::ffff:192.0.2.1/95',
  ])('rejects invalid CIDR %s', (value) => expect(() => prefix(value)).toThrow());
  it.each([
    ['10.0.0.0/24', '10.0.0.0', true],
    ['10.0.0.0/24', '10.0.0.255', true],
    ['10.0.0.0/24', '9.255.255.255', false],
    ['10.0.0.0/24', '10.0.1.0', false],
    ['2001:db8::/126', '2001:db8::', true],
    ['2001:db8::/126', '2001:db8::3', true],
    ['2001:db8::/126', '2001:db8::4', false],
    ['::/0', '0.0.0.1', false],
  ] as const)('checks whether %s contains %s', (cidr, value, expected) => {
    expect(contains(prefix(cidr), address(value))).toBe(expected);
  });
  it('unifies IPv4-mapped IPv6 identities', () => {
    expect(address('::ffff:192.0.2.1')).toEqual(address('192.0.2.1'));
    expect(prefix('::ffff:192.0.2.1/120')).toEqual(prefix('192.0.2.0/24'));
  });
});

describe('first available address', () => {
  it.each([
    ['192.0.2.0/30', ['192.0.2.1', '192.0.2.2']],
    ['192.0.2.8/31', ['192.0.2.8', '192.0.2.9']],
    ['192.0.2.12/32', ['192.0.2.12']],
    ['2001:db8::/126', ['2001:db8::', '2001:db8::1', '2001:db8::2', '2001:db8::3']],
    ['2001:db8:1::/127', ['2001:db8:1::', '2001:db8:1::1']],
    ['2001:db8:2::/128', ['2001:db8:2::']],
  ] as const)('allocates usable addresses in %s and reports exhaustion', (cidr, expected) => {
    const p = prefix(cidr);
    const occupied: Array<{ start: bigint; end: bigint }> = [];
    for (const candidate of expected) {
      expect(firstAvailable(p, occupied)).toBe(candidate);
      const value = address(candidate).value;
      occupied.push({ start: value, end: value });
    }
    expect(firstAvailable(p, occupied)).toBeNull();
  });
  it('finds the lowest gap among unsorted, overlapping, and adjacent ranges', () => {
    const range = (start: string, end: string) => ({
      start: address(start).value,
      end: address(end).value,
    });
    expect(
      firstAvailable(prefix('192.0.2.0/24'), [
        range('192.0.2.10', '192.0.2.20'),
        range('192.0.2.3', '192.0.2.5'),
        range('192.0.1.0', '192.0.1.255'),
        range('192.0.2.1', '192.0.2.3'),
        range('192.0.2.2', '192.0.2.2'),
        range('192.0.2.6', '192.0.2.6'),
      ]),
    ).toBe('192.0.2.7');
  });
  it('jumps over enormous IPv6 intervals', () => {
    const p = prefix('2001:db8::/64');
    const child = prefix('2001:db8::/65');
    expect(firstAvailable(p, [{ start: child.start, end: child.end }])).toBe('2001:db8:0:0:8000::');
  });
  it('reports exhaustion when a child range occupies the entire prefix', () => {
    const p = prefix('2001:db8::/64');
    expect(firstAvailable(p, [{ start: p.start, end: p.end }])).toBeNull();
  });
});
