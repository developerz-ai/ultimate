// Test-only: a fake APNs and a fake FCM (with Google's token endpoint) behind one `fetch`, the two
// private keys a real deploy keeps in `x secrets`, and a recording of every request that left — so
// a test can say exactly what reached a provider, and that nothing else did.

import type { OutboundFetch } from '@ultimat3/core/outbound';

export interface SentRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** Bun's `fetch` option; APNs must be asked for HTTP/2. */
  readonly protocol: unknown;
}

/** One answer for a URL prefix; a list is answered in order, the last repeated. */
export type FakeAnswer = () => Response;

const pem = (der: ArrayBuffer): string =>
  `-----BEGIN PRIVATE KEY-----\n${Buffer.from(der).toString('base64')}\n-----END PRIVATE KEY-----\n`;

export interface ProviderKeys {
  readonly env: Readonly<Record<string, string>>;
  readonly apnsPublic: CryptoKey;
  readonly fcmPublic: CryptoKey;
  /** The PEM texts, so a test can assert they never left the process. */
  readonly secrets: readonly string[];
}

export async function providerKeys(): Promise<ProviderKeys> {
  const ec = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const rsa = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  const apns = pem(await crypto.subtle.exportKey('pkcs8', ec.privateKey));
  // A service-account JSON's `private_key`, pasted as one line with its newlines escaped.
  const fcm = pem(await crypto.subtle.exportKey('pkcs8', rsa.privateKey)).replaceAll('\n', '\\n');
  return {
    env: { ULTIMATE_APNS_PRIVATE_KEY: apns, ULTIMATE_FCM_PRIVATE_KEY: fcm },
    apnsPublic: ec.publicKey,
    fcmPublic: rsa.publicKey,
    secrets: [apns, fcm],
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export const accessToken =
  (token = 'ya29.fake', expiresIn = 3_599): FakeAnswer =>
  () =>
    json({ access_token: token, expires_in: expiresIn, token_type: 'Bearer' });
export const ok = (): FakeAnswer => () => new Response(null, { status: 200 });
export const apnsRefusal =
  (status: number, reason: string): FakeAnswer =>
  () =>
    json({ reason }, status);
export const fcmRefusal =
  (status: number, errorCode: string, state: string): FakeAnswer =>
  () =>
    json(
      {
        error: {
          code: status,
          message: 'refused',
          status: state,
          details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }],
        },
      },
      status,
    );

/** FCM's answer for a token it cannot parse: `INVALID_ARGUMENT`, the violation on `message.token`. */
export const fcmBadToken = (): FakeAnswer => () =>
  json(
    {
      error: {
        code: 400,
        message: 'The registration token is not a valid FCM registration token',
        status: 'INVALID_ARGUMENT',
        details: [
          {
            '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
            errorCode: 'INVALID_ARGUMENT',
          },
          {
            '@type': 'type.googleapis.com/google.rpc.BadRequest',
            fieldViolations: [
              { field: 'message.token', description: 'not a valid FCM registration token' },
            ],
          },
        ],
      },
    },
    400,
  );

export interface FakeProviders {
  readonly fetch: OutboundFetch;
  readonly sent: SentRequest[];
  /** Answer requests to `prefix` with `answers`, in order, the last repeated. */
  answer(prefix: string, ...answers: FakeAnswer[]): void;
}

/** Every request recorded; an unanswered URL is a 599 the test will see as a failure. */
export function fakeProviders(): FakeProviders {
  const sent: SentRequest[] = [];
  const routes = new Map<string, FakeAnswer[]>();
  return {
    sent,
    answer(prefix, ...answers) {
      routes.set(prefix, answers);
    },
    async fetch(url, init) {
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      const body = init.body === undefined || init.body === null ? '' : String(init.body);
      const protocol = (init as { protocol?: unknown }).protocol;
      sent.push({ url, method: init.method ?? 'GET', headers, body, protocol });
      for (const [prefix, answers] of routes) {
        if (!url.startsWith(prefix)) continue;
        const next = answers.length > 1 ? answers.shift() : answers[0];
        if (next !== undefined) return next();
      }
      return new Response(null, { status: 599 });
    },
  };
}

/** A JWT's header and claims, and whether `key` signed it. */
export async function readJwt(
  jwt: string,
  key: CryptoKey,
  algorithm: AlgorithmIdentifier | EcdsaParams,
): Promise<{ header: Record<string, unknown>; claims: Record<string, unknown>; valid: boolean }> {
  const [head = '', body = '', signature = ''] = jwt.split('.');
  const decode = (part: string): Record<string, unknown> =>
    JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
  const valid = await crypto.subtle.verify(
    algorithm,
    key,
    Buffer.from(signature, 'base64url'),
    new TextEncoder().encode(`${head}.${body}`),
  );
  return { header: decode(head), claims: decode(body), valid };
}
