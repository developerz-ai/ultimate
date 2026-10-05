// Single responsibility: pins `addressNetwork` — the one rule for "which network is this caller":
// IPv4 exact, an IPv4-mapped IPv6 as its IPv4, any other IPv6 as its /64. A per-address budget keyed
// on the full IPv6 string is ~2^64 budgets for one host, which is no budget at all.

import { describe, expect, test } from 'bun:test';
import { addressNetwork } from './address-class';

describe('addressNetwork', () => {
  test.each([
    ['203.0.113.7', '203.0.113.7'],
    ['10.0.0.1', '10.0.0.1'],
    [' 198.51.100.4 ', '198.51.100.4'],
  ])('IPv4 %p is itself', (input, network) => {
    expect(addressNetwork(input)).toBe(network);
  });

  test.each([
    ['::ffff:1.2.3.4', '1.2.3.4'],
    ['::FFFF:1.2.3.4', '1.2.3.4'],
    ['::ffff:0102:0304', '1.2.3.4'],
    ['[::ffff:198.51.100.9]', '198.51.100.9'],
    ['0:0:0:0:0:ffff:203.0.113.1', '203.0.113.1'],
  ])('IPv4-mapped %p is the IPv4 it carries', (input, network) => {
    expect(addressNetwork(input)).toBe(network);
  });

  test.each([
    ['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
    ['2001:db8:1:2::1', '2001:db8:1:2::/64'],
    ['2001:0DB8:0001:0002:ffff:ffff:ffff:ffff', '2001:db8:1:2::/64'],
    ['2001:DB8:1:2::abcd', '2001:db8:1:2::/64'],
    ['fe80::1%eth0', 'fe80::/64'],
    ['[2001:db8:1:2::9]', '2001:db8:1:2::/64'],
    ['2001::1', '2001::/64'],
    ['2001:0:0:1::5', '2001:0:0:1::/64'],
    ['::1', '::/64'],
    ['::', '::/64'],
    ['2001:db8:0:0:1::', '2001:db8::/64'],
  ])('IPv6 %p is its /64', (input, network) => {
    expect(addressNetwork(input)).toBe(network);
  });

  test('two addresses in one /64 are one network, two /64s are two', () => {
    expect(addressNetwork('2001:db8:aa:bb::1')).toBe(addressNetwork('2001:db8:aa:bb:ffff::2'));
    expect(addressNetwork('2001:db8:aa:bb::1')).not.toBe(addressNetwork('2001:db8:aa:bc::1'));
  });

  test.each(['', 'localhost', 'not-an-ip', '1.2.3', '010.0.0.1', '2001:db8::1::2', 'unknown'])(
    'an unparseable %p is returned unchanged',
    (input) => {
      expect(addressNetwork(input)).toBe(input);
    },
  );
});
