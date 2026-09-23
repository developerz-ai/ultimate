// Single responsibility: pins every range `classifyAddress` names, in both families and through
// every IPv6 form that embeds an IPv4 address — the SSRF screens above it are only as good as this.

import { describe, expect, test } from 'bun:test';
import { type AddressClass, classifyAddress, isPublicAddress } from './address-class';

const TABLE: readonly (readonly [string, AddressClass])[] = [
  // IPv4
  ['0.0.0.0', 'unspecified'],
  ['0.1.2.3', 'unspecified'],
  ['127.0.0.1', 'loopback'],
  ['127.255.255.254', 'loopback'],
  ['10.0.0.1', 'private'],
  ['172.16.0.1', 'private'],
  ['172.31.255.255', 'private'],
  ['192.168.1.1', 'private'],
  ['169.254.169.254', 'link-local'],
  ['100.64.0.1', 'cgnat'],
  ['100.127.255.255', 'cgnat'],
  ['224.0.0.1', 'reserved'],
  ['240.0.0.1', 'reserved'],
  ['255.255.255.255', 'reserved'],
  ['192.0.2.1', 'reserved'],
  ['198.18.0.1', 'reserved'],
  ['8.8.8.8', 'public'],
  ['172.15.255.255', 'public'],
  ['172.32.0.1', 'public'],
  ['100.63.255.255', 'public'],
  ['100.128.0.1', 'public'],
  ['1.1.1.1', 'public'],
  // IPv6
  ['::', 'unspecified'],
  ['::1', 'loopback'],
  ['0:0:0:0:0:0:0:1', 'loopback'],
  ['fe80::1', 'link-local'],
  ['fe80::1%eth0', 'link-local'],
  ['febf::1', 'link-local'],
  ['fc00::1', 'ula'],
  ['fd12:3456:789a::1', 'ula'],
  ['ff02::1', 'reserved'],
  ['2001:db8::1', 'reserved'],
  ['2606:4700:4700::1111', 'public'],
  ['[2606:4700:4700::1111]', 'public'],
  ['[::1]', 'loopback'],
  // IPv4 inside IPv6: the embedded address decides, or the screen is one spelling from bypassed.
  ['::ffff:127.0.0.1', 'loopback'],
  ['::ffff:7f00:1', 'loopback'],
  ['0:0:0:0:0:ffff:127.0.0.1', 'loopback'],
  ['::ffff:169.254.169.254', 'link-local'],
  ['::ffff:10.0.0.1', 'private'],
  ['::ffff:8.8.8.8', 'public'],
  ['::127.0.0.1', 'loopback'],
  ['64:ff9b::a9fe:a9fe', 'link-local'],
  ['64:ff9b::808:808', 'public'],
];

describe('classifyAddress', () => {
  test.each(TABLE)('%s is %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });

  test.each([
    'localhost',
    'example.com',
    '',
    '1.2.3',
    '1.2.3.4.5',
    '256.0.0.1',
    '010.0.0.1',
    '0x7f.0.0.1',
    '1::2::3',
    '12345::1',
    ':::1',
    '1:2:3:4:5:6:7:8:9',
  ])('%p is not an address literal', (input) => {
    expect(classifyAddress(input)).toBeUndefined();
  });
});

describe('isPublicAddress fails closed', () => {
  test('only a public literal is public', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('::ffff:127.0.0.1')).toBe(false);
    expect(isPublicAddress('10.0.0.1')).toBe(false);
  });

  test('a hostname is not public — resolve it first, then ask', () => {
    expect(isPublicAddress('example.com')).toBe(false);
  });
});
