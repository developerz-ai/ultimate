// Single responsibility: pins every range `classifyAddress` names, in both families and through
// every IPv6 form that embeds an IPv4 address — the SSRF screens above it are only as good as this.

import { describe, expect, test } from 'bun:test';
import {
  type AddressClass,
  classifyAddress,
  isPublicAddress,
  peerAddressClass,
} from './address-class';

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
  ['64:ff9b::7f00:1', 'loopback'],
  // 6to4 carries its IPv4 in groups 2 and 3 (bits 16-47), not the last two: read in the wrong place
  // or not at all, `2002:7f00:1::` is public and a relay delivers it to the box itself.
  ['2002:7f00:1::', 'loopback'],
  ['2002:7f00:1::1', 'loopback'],
  ['2002:a9fe:a9fe::', 'link-local'],
  ['2002:0a00:1::', 'private'],
  ['2002:c0a8:101:1::1', 'private'],
  ['2002:6440:1::', 'cgnat'],
  ['2002:e000:1::', 'reserved'],
  ['2002:0:1::', 'unspecified'],
  ['2002:0808:0808::1', 'public'],
  // The subnet and interface bits of a 6to4 address say nothing about where it is routed.
  ['2002:0808:0808:7f00:1:7f00:0:1', 'public'],
  // Teredo's client address is obfuscated, so it is not unwrapped: it just is not a public host.
  ['2001::1', 'private'],
  ['2001:0:4136:e378:8000:63bf:3fff:fdd2', 'private'],
  // IPv4-translated (SIIT, `::ffff:0:0/96`): one group left of mapped, same embedded address.
  ['::ffff:0:7f00:1', 'loopback'],
  ['::ffff:0:127.0.0.1', 'loopback'],
  ['::ffff:0:a9fe:a9fe', 'link-local'],
  ['::ffff:0:808:808', 'public'],
  // Local-use NAT64 (RFC 8215) is by definition not the public translator.
  ['64:ff9b:1::7f00:1', 'reserved'],
  ['64:ff9b:0:0:1::7f00:1', 'reserved'],
  // Only 2000::/3 is global unicast. The rest of the space is not a host anyone can publish.
  ['::1:0:0:1', 'reserved'],
  ['1::1', 'reserved'],
  ['100::1', 'reserved'],
  ['5f00::1', 'reserved'],
  ['4000::1', 'reserved'],
  ['e000::1', 'reserved'],
  // Special-purpose blocks inside 2000::/3.
  ['2001:2::1', 'reserved'],
  ['2001:10::1', 'reserved'],
  ['2001:1ff:ffff::1', 'reserved'],
  ['3fff::1', 'reserved'],
  ['3fff:fff:ffff::1', 'reserved'],
  // Their neighbours stay public, or the screen refuses the internet.
  ['2001:200::1', 'public'],
  ['2001:4860:4860::8888', 'public'],
  ['2003::1', 'public'],
  ['3ffe::1', 'public'],
  ['3fff:1000::1', 'public'],
  // 192.88.99.0/24, the deprecated 6to4 relay anycast (RFC 7526).
  ['192.88.99.1', 'reserved'],
  ['192.88.98.1', 'public'],
  ['192.88.100.1', 'public'],
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

// The same address answers two questions. Where a dial would land is the IPv4 it carries; who is
// calling is not: a sender on a 6to4 or NAT64 address is not on this box or on this network.
describe('peerAddressClass', () => {
  test.each([
    ['::1', 'loopback'],
    ['[::1]', 'loopback'],
    ['0:0:0:0:0:0:0:1', 'loopback'],
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:7f00:1', 'loopback'],
    ['::ffff:10.0.0.1', 'private'],
    ['10.0.0.1', 'private'],
    ['fe80::1%eth0', 'link-local'],
    ['fd12::1', 'ula'],
    ['::', 'unspecified'],
    ['8.8.8.8', 'public'],
    ['2606:4700:4700::1111', 'public'],
  ] as const)('%s is itself: %s', (address, expected) => {
    expect(peerAddressClass(address)).toBe(expected);
  });

  test.each([
    '64:ff9b::7f00:1',
    '64:ff9b::a00:1',
    '2002:7f00:1::',
    '2002:a9fe:a9fe::',
    '2002:0a00:1::',
    '::127.0.0.1',
    '::ffff:0:7f00:1',
    '::ffff:0:a00:1',
    '2002:0:1::',
  ])('%s carries an inward address and vouches for nothing', (address) => {
    expect(classifyAddress(address)).not.toBe('public');
    expect(peerAddressClass(address)).toBe('reserved');
  });

  test.each(['2002:0808:0808::1', '64:ff9b::808:808', '::ffff:0:808:808'])(
    '%s carries a public address and stays public',
    (address) => {
      expect(peerAddressClass(address)).toBe('public');
    },
  );

  test.each(['localhost', '', '256.0.0.1', '1::2::3'])('%p is not an address literal', (input) => {
    expect(peerAddressClass(input)).toBeUndefined();
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
