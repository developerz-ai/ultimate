// XFCC authenticates, which is exactly why an untrusted read must answer `null` rather than a
// confident name for whatever the caller typed. The trust rule is the same `trustedProxyHops`
// one `x-forwarded-for` uses — there is no second proxy-trust path to get wrong.
import { describe, expect, test } from 'bun:test';
import { defineHttpConfig, type HttpConfigInput } from './config';
import { peerIdentity } from './peer-identity';
import { httpPipeline } from './pipeline';
import { jsonResponse } from './response';
import { httpRouter } from './router';

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
  // The proxy APPENDS to what the client sent, so the client writes the text before the first
  // trusted comma. Nothing it writes there may move the hop index onto its own element — and
  // nothing it writes there may cost the proxy's element its reading either.
  test('a client prefix ending in an open quote or a backslash never names the peer', () => {
    const plain = 'By=spiffe://cluster.local/gw;Hash=abc;URI=spiffe://cluster.local/ns/real';
    const forged = 'URI=spiffe://cluster.local/ns/admin';
    for (const hops of [1, 2]) {
      const inner = hops === 1 ? '' : `,${plain}`;
      for (const proxied of [plain, SPIFFE]) {
        const honest = read(proxied, 1);
        for (const tail of [';X="', ';X="\\', ';X=\\', '"', '\\"', ';X="a\\\\']) {
          expect(read(`${forged}${tail},${proxied}${inner}`, hops)).toEqual(honest);
        }
      }
    }
  });

  test('a backslash still escapes a quote inside a quoted value', () => {
    const peer = read('By=gw;Subject="CN=a\\"b,O=x";URI=spiffe://cluster.local/ns/real', 1);
    expect(peer?.subject).toBe('CN=a"b,O=x');
    expect(peer?.spiffeId).toBe('spiffe://cluster.local/ns/real');
  });

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
    const pipeline = httpPipeline({
      table: httpRouter([
        {
          method: 'GET',
          path: '/peer',
          meta: { name: 'peer', auth: 'public' },
          handler: (_request, ctx) => jsonResponse({ peer: ctx.peer?.id ?? null }),
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

// The sweep-2 parser read left to right, so the CLIENT's text decided the quote state the proxy's
// element was read in: one odd quote and the proxy's own `\"` closed a quote instead of escaping
// one, the trusted comma was swallowed and the client's `URI=` named the peer. Only the suffix the
// trusted hops wrote is read now, from the right.
describe('only the proxy-written suffix is read', () => {
  const ADMIN = 'spiffe://mesh/admin';
  const REAL = 'spiffe://mesh/real';
  const INNER = 'By=spiffe://mesh/gw;Hash=ff;URI=spiffe://mesh/edge';
  const ESCAPED = `By=spiffe://mesh/gw;Subject="CN=a\\"b";URI=${REAL}`;
  /** `client` + what `hops` trusted proxies appended; the outermost one wrote `element`. */
  const chain = (client: string, element: string, hops: number, joint = ','): string =>
    [client, element, ...(hops === 2 ? [INNER] : [])].join(joint);

  const PREFIXES: readonly (readonly [name: string, client: string])[] = [
    ['an open quote', `URI=${ADMIN};X="`],
    ['an open quote after a comma of its own', `URI=${ADMIN},X="`],
    ['a quote that closes', `URI=${ADMIN};X="a"`],
    ['three quotes', `"""URI=${ADMIN}`],
    ['an escaped quote', `URI=${ADMIN};X=\\"`],
    ['a trailing backslash', `URI=${ADMIN};X=\\`],
    ['an open quote and a trailing backslash', `URI=${ADMIN};X="\\`],
    ['an even run of backslashes', `URI=${ADMIN};X="a\\\\`],
    ['empty elements', `URI=${ADMIN},, ,`],
    ['whitespace', `  URI=${ADMIN} ;X=" `],
    ['a megabyte of open quotes', `URI=${ADMIN};X=${'"'.repeat(1_000_001)}`],
  ];
  const ELEMENTS: readonly (readonly [name: string, element: string, subject: string | null])[] = [
    ['an unquoted element', `By=spiffe://mesh/gw;Hash=ab;URI=${REAL}`, null],
    ['an escaped quote in Subject', ESCAPED, 'CN=a"b'],
    [
      'two escaped quotes and a comma',
      `Subject="CN=\\"a\\",O=x, Inc";URI=${REAL}`,
      'CN="a",O=x, Inc',
    ],
    ['an escaped backslash before the closing quote', `Subject="CN=a\\\\";URI=${REAL}`, 'CN=a\\'],
    ['a quoted value last', `URI=${REAL};Subject="CN=a\\"b"`, 'CN=a"b'],
  ];

  for (const hops of [1, 2]) {
    for (const [prefix, client] of PREFIXES) {
      for (const [shape, element, subject] of ELEMENTS) {
        test(`hops ${hops}: ${prefix} before ${shape} resolves the proxy's element`, () => {
          for (const joint of [',', ', ', ' ,\t']) {
            const peer = read(chain(client, element, hops, joint), hops);
            expect(peer?.id).toBe(REAL);
            expect(peer?.uriSans).toEqual([REAL]);
            expect(peer?.subject).toBe(subject);
          }
        });
      }
    }
  }

  test('honest input reads exactly as it did: no client text, hops 1 and 2', () => {
    for (const [, element, subject] of ELEMENTS) {
      for (const hops of [1, 2]) {
        const peer = read(hops === 1 ? element : `${element},${INNER}`, hops);
        expect(peer?.id).toBe(REAL);
        expect(peer?.subject).toBe(subject);
      }
    }
  });

  // A raw `"` in a value the proxy did not quote leaves no reading of the element that the
  // client's text cannot change, so there is none.
  test('a raw quote inside an unquoted URI SAN is no peer, whatever the client wrote', () => {
    const raw = 'By=spiffe://mesh/gw;URI=spiffe://mesh/re"al';
    for (const hops of [1, 2]) {
      expect(read(chain('', raw, hops).replace(/^,/, ''), hops)).toBeNull();
      for (const [, client] of PREFIXES) expect(read(chain(client, raw, hops), hops)).toBeNull();
    }
    // Closing the quote it opens does not make it an element either: a value is quoted whole.
    expect(read(`URI=${ADMIN};X=",By=gw;URI=spiffe://mesh/re"al;DNS=a.test`, 1)).toBeNull();
    expect(read('By=gw;URI=spiffe://mesh/real"', 1)).toBeNull();
  });

  test('an element that is not well formed is no peer', () => {
    for (const element of [
      `URI=${REAL};Subject="CN=a`, // never closed
      `URI=${REAL};Subject=CN=a"`, // never opened
      `Subject="CN=a"x;URI=${REAL}`, // text after the closing quote
      `Subject=x"CN=a";URI=${REAL}`, // text before the opening quote
      `Subject="CN=a\\";URI=${REAL}`, // the closing quote is escaped
      `Subject=\\"CN=a";URI=${REAL}`,
    ]) {
      expect(read(element, 1)).toBeNull();
      expect(read(`URI=${ADMIN},${element}`, 1)).toBeNull();
      expect(read(`URI=${ADMIN},${element},${INNER}`, 2)).toBeNull();
    }
  });

  test('empty elements and whitespace never count as a hop', () => {
    expect(read(`URI=${ADMIN}, ,${ESCAPED},,`, 1)?.id).toBe(REAL);
    expect(read(`URI=${ADMIN},${ESCAPED}, ,${INNER} , `, 2)?.id).toBe(REAL);
    expect(read(' , ,, ', 1)).toBeNull();
    expect(read(`${INNER},,`, 2)).toBeNull();
  });

  // Two `x-forwarded-client-cert` lines reach `Headers` as one value joined by `, `.
  test('two header lines are one list, read from the right', () => {
    const headers = new Headers();
    headers.append('x-forwarded-client-cert', `URI=${ADMIN};X="`);
    headers.append('x-forwarded-client-cert', ESCAPED);
    const peer = peerIdentity({
      headers,
      config: defineHttpConfig({
        rateLimit: { scope: 'process' },
        trustClientCertHeader: true,
        trustProxy: true,
        trustedProxyHops: 1,
      }),
      socketAddress: '10.42.0.7',
      urlProtocol: 'http:',
    });
    expect(peer?.id).toBe(REAL);
    expect(peer?.subject).toBe('CN=a"b');
  });

  // Each shape is one the old parser, or a naive right-to-left one, walks more than once.
  test('a megabyte of anything is read in linear time', () => {
    const size = 1_000_000;
    const shapes = [
      `${'"'.repeat(size)},${ESCAPED}`,
      `${'\\'.repeat(size)},${ESCAPED}`,
      `Subject="${'\\"'.repeat(size / 2)}";URI=${REAL}`,
      `Subject="${'\\'.repeat(size)}";URI=${REAL}`,
      `URI=${REAL}${'\\'.repeat(size)}"`,
      `${',"'.repeat(size / 2)}`,
      `${'a,'.repeat(size / 2)}${ESCAPED}`,
    ];
    const started = performance.now();
    const read1 = shapes.map((header) => read(header, 1)?.id ?? null);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(read1).toEqual([REAL, REAL, REAL, REAL, null, null, REAL]);
  });
});
