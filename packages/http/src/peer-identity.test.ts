// XFCC authenticates, which is exactly why an untrusted read must answer `null` rather than a
// confident name for whatever the caller typed. The trust rule is the same `trustedProxyHops`
// one `x-forwarded-for` uses — there is no second proxy-trust path to get wrong.
import { describe, expect, test } from 'bun:test';
import { defineHttpConfig } from './config';
import { peerIdentity } from './peer-identity';

const SPIFFE =
  'By=spiffe://cluster.local/ns/default/sa/gateway;Hash=abc123;Subject="CN=checkout,OU=payments";URI=spiffe://cluster.local/ns/default/sa/checkout';

const read = (header: string | undefined, hops: number | undefined) =>
  peerIdentity({
    headers: new Headers(header === undefined ? {} : { 'x-forwarded-client-cert': header }),
    config: defineHttpConfig({
      rateLimit: { scope: 'process' },
      ...(hops === undefined ? {} : { trustProxy: true, trustedProxyHops: hops }),
    }),
    socketAddress: '10.42.0.7',
    urlProtocol: 'http:',
  });

describe('peerIdentity', () => {
  test('a trusted XFCC yields the SPIFFE id, the subject and the SANs', () => {
    const peer = read(SPIFFE, 1);
    expect(peer?.spiffeId).toBe('spiffe://cluster.local/ns/default/sa/checkout');
    expect(peer?.id).toBe('spiffe://cluster.local/ns/default/sa/checkout');
    expect(peer?.subject).toBe('CN=checkout,OU=payments');
    expect(peer?.by).toBe('spiffe://cluster.local/ns/default/sa/gateway');
  });

  // The reason the whole file exists. Without `trustProxy` the header is a claim by the caller,
  // and a certificate identity from an untrusted hop is worse than none: it authenticates.
  test('untrusted, it is null — never the value the caller supplied', () => {
    expect(read(SPIFFE, undefined)).toBeNull();
  });

  test('a chain shorter than declared is not the configured chain, so nothing is trusted', () => {
    expect(read(SPIFFE, 2)).toBeNull();
  });

  test('a spoofed leading element is skipped, exactly as in x-forwarded-for', () => {
    const forged = 'URI=spiffe://cluster.local/ns/default/sa/admin';
    const peer = read(`${forged},${SPIFFE}`, 1);
    expect(peer?.spiffeId).toBe('spiffe://cluster.local/ns/default/sa/checkout');
  });

  // `Subject="CN=a,OU=b"` carries a comma inside its quotes; splitting the header naively would
  // cut the element in half and shift every hop index by one.
  test('a comma inside a quoted Subject does not split the element', () => {
    const peer = read('Subject="CN=a,OU=b,C=US";URI=spiffe://x/y', 1);
    expect(peer?.subject).toBe('CN=a,OU=b,C=US');
    expect(peer?.spiffeId).toBe('spiffe://x/y');
  });

  test('repeated URI and DNS entries all survive', () => {
    const peer = read('URI=https://a.test;URI=spiffe://x/y;DNS=a.test;DNS=b.test', 1);
    expect(peer?.uriSans).toEqual(['https://a.test', 'spiffe://x/y']);
    expect(peer?.dnsSans).toEqual(['a.test', 'b.test']);
  });

  test('with no SPIFFE URI the subject is the id', () => {
    expect(read('Hash=abc;Subject="CN=legacy"', 1)?.id).toBe('CN=legacy');
  });

  test('an element naming no identity at all is null, not an empty id', () => {
    expect(read('Hash=abc123', 1)).toBeNull();
  });

  test('no header is null', () => {
    expect(read(undefined, 1)).toBeNull();
  });
});
