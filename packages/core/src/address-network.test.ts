// Single responsibility: pins `addressNetwork` — the one rule for "which network is this caller":
// IPv4 exact, an IPv4-mapped IPv6 as its IPv4, any other IPv6 as its /64. A per-address budget keyed
// on the full IPv6 string is ~2^64 budgets for one host, which is no budget at all.

import { describe, expect, test } from 'bun:test';
import { ADDRESS_NETWORK_MEMO_SIZE, addressNetwork, networkMemo } from './address-class';

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

// The memo every caller shares (http's rate limit, auth's ip key, realtime's subscription book):
// held as parse COUNTS. A returning caller is free, the bound holds against a caller set an
// attacker chooses, and the least recently asked address is the one forgotten.
describe('the addressNetwork memo', () => {
  const counted = (size?: number) => {
    const parsed: string[] = [];
    const memo = networkMemo((address) => {
      parsed.push(address);
      return `net:${address}`;
    }, size);
    return { memo, parsed };
  };

  test('parses a returning address once', () => {
    const { memo, parsed } = counted();
    for (let index = 0; index < 5; index += 1) {
      expect(memo('2001:db8:1:2:3:4:5:6')).toBe('net:2001:db8:1:2:3:4:5:6');
      expect(memo('203.0.113.7')).toBe('net:203.0.113.7');
    }
    expect(parsed).toEqual(['2001:db8:1:2:3:4:5:6', '203.0.113.7']);
  });

  test('is bounded, and forgets the least recently asked first', () => {
    const { memo, parsed } = counted(2);
    memo('10.0.0.1');
    memo('10.0.0.2');
    memo('10.0.0.1'); // now the warmest: 10.0.0.2 is the coldest
    memo('10.0.0.3'); // evicts 10.0.0.2
    parsed.length = 0;
    memo('10.0.0.1');
    memo('10.0.0.3');
    expect(parsed).toEqual([]);
    memo('10.0.0.2');
    expect(parsed).toEqual(['10.0.0.2']);
  });

  test('the shared memo is 4,096 addresses and answers the parse, hit or miss', () => {
    expect(ADDRESS_NETWORK_MEMO_SIZE).toBe(4096);
    expect(addressNetwork('2001:db8:aa:bb::1')).toBe('2001:db8:aa:bb::/64');
    expect(addressNetwork('2001:db8:aa:bb::1')).toBe('2001:db8:aa:bb::/64');
  });
});
