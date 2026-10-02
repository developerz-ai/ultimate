// XFCC authenticates, which is exactly why an untrusted read must answer `null` rather than a
// confident name for whatever the caller typed. The trust rule is the same `trustedProxyHops`
// one `x-forwarded-for` uses — there is no second proxy-trust path to get wrong.
import { describe, expect, test } from 'bun:test';
import { defineHttpConfig, type HttpConfigInput } from './config';
import { peerIdentity } from './peer-identity';
import { createPipeline } from './pipeline';
import { json } from './response';
import { createRouter } from './router';

const SPIFFE =
  'By=spiffe://cluster.local/ns/default/sa/gateway;Hash=abc123;Subject="CN=checkout,OU=payments";URI=spiffe://cluster.local/ns/default/sa/checkout';

const read = (header: string | undefined, hops: number | undefined, certHeader = true) =>
  peerIdentity({
    headers: new Headers(header === undefined ? {} : { 'x-forwarded-client-cert': header }),
    config: defineHttpConfig({
      rateLimit: { scope: 'process' },
      trustClientCertHeader: certHeader,
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

  // `trustProxy` says the proxy APPENDS to `x-forwarded-for`. It says nothing about this header:
  // an ingress that passes a client-sent `x-forwarded-client-cert` through would let the caller
  // name its own certificate identity. Reading it is a second, separate declaration.
  test('trustProxy alone reads nothing: the certificate header is its own opt-in', () => {
    expect(read(SPIFFE, 1, false)).toBeNull();
    expect(read(`URI=spiffe://forged/x,${SPIFFE}`, 2, false)).toBeNull();
    expect(defineHttpConfig({ rateLimit: { scope: 'process' } }).trustClientCertHeader).toBe(false);
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

// XFCC was unescaped TWICE: the element split stripped the quotes, then `pairsOf` split the
// stripped text again — so a `;` inside a quoted Subject cut it short, and two services whose
// subjects differ only after that `;` became ONE identity.
describe('a quoted value is unescaped once, after the pairs are split', () => {
  test('three subjects that differ only inside their quotes are three identities', () => {
    const one = read('Subject="O=Acme; Inc,CN=svc-one"', 1);
    const two = read('Subject="O=Acme; Inc,CN=svc-two"', 1);
    const quoted = read('Subject="CN=checkout\\""', 1);
    expect(one?.id).toBe('O=Acme; Inc,CN=svc-one');
    expect(two?.id).toBe('O=Acme; Inc,CN=svc-two');
    expect(quoted?.id).toBe('CN=checkout"');
    expect(new Set([one?.id, two?.id, quoted?.id]).size).toBe(3);
  });

  test('a quoted comma still does not split the hop list', () => {
    const peer = read('URI=spiffe://forged/x,Subject="O=Acme, Inc;CN=svc";URI=spiffe://ok/y', 1);
    expect(peer?.subject).toBe('O=Acme, Inc;CN=svc');
    expect(peer?.spiffeId).toBe('spiffe://ok/y');
  });
});

describe('ctx.peer through the pipeline', () => {
  const peerOf = async (input: HttpConfigInput): Promise<unknown> => {
    const pipeline = createPipeline({
      table: createRouter([
        {
          method: 'GET',
          path: '/peer',
          meta: { name: 'peer', auth: 'public' },
          handler: (_request, ctx) => json({ peer: ctx.peer?.id ?? null }),
        },
      ]),
      config: defineHttpConfig({ rateLimit: { scope: 'process' }, buildId: null, ...input }),
    });
    const response = await pipeline.handle(
      new Request('http://app.test/peer', {
        headers: { 'x-forwarded-client-cert': SPIFFE, 'x-forwarded-for': '203.0.113.9' },
      }),
      { role: 'web', ip: '10.42.0.7' },
    );
    return ((await response.json()) as { peer: unknown }).peer;
  };

  test('a deployment that declared only trustProxy gets no peer from a client-sent header', async () => {
    expect(await peerOf({ trustProxy: true, trustedProxyHops: 1 })).toBeNull();
  });

  test('the opt-in beside trustProxy publishes it', async () => {
    expect(
      await peerOf({ trustProxy: true, trustedProxyHops: 1, trustClientCertHeader: true }),
    ).toBe('spiffe://cluster.local/ns/default/sa/checkout');
  });
});
