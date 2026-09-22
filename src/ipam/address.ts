import ipaddr from 'ipaddr.js';
import { invalid } from '../api/errors';
export interface Address {
  address: string;
  family: number;
  value: bigint;
  key: string;
}
export interface Prefix {
  cidr: string;
  family: number;
  length: number;
  start: bigint;
  end: bigint;
  range_start: string;
  range_end: string;
}
export const key = (value: bigint) => value.toString(16).padStart(32, '0');
export function address(input: string): Address {
  try {
    if (input.includes('/') || input.includes('%')) throw new Error();
    const parsed = ipaddr.parse(input);
    if (parsed.kind() === 'ipv4' && !ipaddr.IPv4.isValidFourPartDecimal(input)) throw new Error();
    // Mapped IPv6 and IPv4 denote the same address in this single routing domain.
    const normalized =
      parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress()
        ? parsed.toIPv4Address()
        : parsed;
    const value = normalized.toByteArray().reduce((n, byte) => (n << 8n) | BigInt(byte), 0n);
    return {
      address: normalized.toString(),
      family: normalized.kind() === 'ipv4' ? 4 : 6,
      value,
      key: key(value),
    };
  } catch {
    throw invalid('Expected an IPv4 or IPv6 literal without a prefix length or zone.');
  }
}
export function literal(value: bigint, family: number): string {
  const bytes = Array.from({ length: family === 4 ? 4 : 16 }, (_, index) =>
    Number((value >> BigInt(8 * ((family === 4 ? 4 : 16) - index - 1))) & 255n),
  );
  return ipaddr.fromByteArray(bytes).toString();
}
export function prefix(input: string): Prefix {
  try {
    if (input.includes('%')) throw new Error();
    const [parsed, originalLength] = ipaddr.parseCIDR(input);
    const raw = input.split('/')[0]!;
    if (parsed.kind() === 'ipv4' && !ipaddr.IPv4.isValidFourPartDecimal(raw)) throw new Error();
    const mapped = parsed instanceof ipaddr.IPv6 && parsed.isIPv4MappedAddress();
    if (mapped && originalLength < 96) throw new Error();
    const a = address(raw);
    const length = mapped ? originalLength - 96 : originalLength;
    const hostBits = BigInt((a.family === 4 ? 32 : 128) - length);
    const start = (a.value >> hostBits) << hostBits;
    const end = start + (1n << hostBits) - 1n;
    return {
      cidr: `${literal(start, a.family)}/${length}`,
      family: a.family,
      length,
      start,
      end,
      range_start: key(start),
      range_end: key(end),
    };
  } catch {
    throw invalid('Expected a valid IPv4 or IPv6 CIDR.');
  }
}
export function contains(p: Prefix, a: Address): boolean {
  return p.family === a.family && p.start <= a.value && a.value <= p.end;
}
export function firstAvailable(
  p: Prefix,
  occupied: Array<{ start: bigint; end: bigint }>,
): string | null {
  let candidate = p.start + (p.family === 4 && p.length < 31 ? 1n : 0n);
  const last = p.end - (p.family === 4 && p.length < 31 ? 1n : 0n);
  for (const range of occupied.sort((a, b) =>
    a.start < b.start ? -1 : a.start > b.start ? 1 : 0,
  )) {
    if (range.end < candidate) continue;
    if (range.start > candidate) break;
    candidate = range.end + 1n;
  }
  return candidate <= last ? literal(candidate, p.family) : null;
}
