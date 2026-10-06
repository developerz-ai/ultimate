// Tests for the SES v2 transport: the signed request, the raw MIME body, the error-type → retry
// table and the construction refusals. Every test injects its own fetch — the sealed test network
// throws on any real request — and freezes the clock, so the SigV4 signature is a known answer.

import { describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError, signAwsRequest, type UltimateError } from '@ultimat3/core';
import { nextRetryForError } from '@ultimat3/jobs';
import type { MailMessage } from './driver';
import type { MailFetch } from './driver-resend';
import { createSesDriver, type SesDriverOptions } from './driver-ses';
import type { RetainedMimeEntry } from './retain-mime';

const NOW = '2026-10-06T12:00:00.000Z';
const CREDENTIALS = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'ses-test-secret-do-not-leak' };
const FROM = 'Postly <no-reply@postly.test>';

const message = (overrides: Partial<MailMessage> = {}): MailMessage => ({
  mailId: 'welcome',
  to: ['ada@example.test'],
  subject: 'Welcome to Postly',
  html: '<p>Hello Ada</p>',
  text: 'Hello Ada',
  locale: 'en',
  tz: 'UTC',
  ...overrides,
});

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function stub(answer: () => Response): { fetch: MailFetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetch: MailFetch = async (url, init) => {
    seen.push({
      url,
      headers: Object.fromEntries(new Headers(init.headers)),
      body: String(init.body),
    });
    return answer();
  };
  return { fetch, seen };
}

function driverWith(fetch: MailFetch, extra: Partial<SesDriverOptions> = {}) {
  return createSesDriver({
    region: 'eu-west-1',
    credentials: CREDENTIALS,
    from: FROM,
    clock: frozenClock(NOW),
    fetch,
    ...extra,
  });
}

async function rejection(promise: Promise<unknown>): Promise<UltimateError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (isUltimateError(error)) return error;
  return expect.unreachable('expected the send to reject with an UltimateError');
}

function thrown(run: () => unknown): UltimateError {
  try {
    run();
  } catch (error) {
    if (isUltimateError(error)) return error;
  }
  return expect.unreachable('expected createSesDriver to refuse with an UltimateError');
}

const rawOf = (body: string): string => {
  const parsed = JSON.parse(body) as { Content: { Raw: { Data: string } } };
  return new TextDecoder().decode(
    Uint8Array.from(atob(parsed.Content.Raw.Data), (c) => c.charCodeAt(0)),
  );
};

describe('createSesDriver — the request', () => {
  test('POSTs SendEmail with the raw MIME, the envelope and a SigV4 signature over those bytes', async () => {
    const { fetch, seen } = stub(() => Response.json({ MessageId: '0102018f-ses-id' }));
    const driver = driverWith(fetch, { configurationSet: 'transactional' });
    const result = await driver.send(
      message({ cc: ['grace@example.test'], bcc: ['ops@example.test'] }),
    );

    expect(result).toMatchObject({ id: '0102018f-ses-id', driver: 'ses', queued: false });
    expect(result.accepted).toEqual(['ada@example.test', 'grace@example.test', 'ops@example.test']);
    const [request] = seen;
    if (request === undefined) return expect.unreachable('no request was made');
    expect(request.url).toBe('https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails');

    const body = JSON.parse(request.body);
    expect(body.FromEmailAddress).toBe(FROM);
    expect(body.Destination).toEqual({
      ToAddresses: ['ada@example.test'],
      CcAddresses: ['grace@example.test'],
      BccAddresses: ['ops@example.test'],
    });
    expect(body.ConfigurationSetName).toBe('transactional');
    const raw = rawOf(request.body);
    expect(raw).toContain('Subject: Welcome to Postly\r\n');
    expect(raw).toContain('Content-Type: multipart/alternative;');
    // The blind list is the envelope's, never a header.
    expect(raw).not.toContain('ops@example.test');

    // The signature is core's answer for exactly these bytes, so a body edited after signing —
    // or a header the signer never saw — is a different string here.
    const expected = await signAwsRequest({
      method: 'POST',
      url: request.url,
      headers: { 'content-type': 'application/json' },
      payload: { body: request.body },
      credentials: CREDENTIALS,
      region: 'eu-west-1',
      service: 'ses',
      clock: frozenClock(NOW),
    });
    expect(request.headers['authorization']).toBe(expected.headers['authorization'] ?? '');
    expect(request.headers['authorization']).toContain(
      'Credential=AKIDEXAMPLE/20261006/eu-west-1/ses/aws4_request',
    );
    expect(request.headers['x-amz-date']).toBe('20261006T120000Z');
  });

  test('a session token is sent and signed; an endpoint override replaces the host', async () => {
    const { fetch, seen } = stub(() => Response.json({ MessageId: 'm-1' }));
    await driverWith(fetch, {
      credentials: { ...CREDENTIALS, sessionToken: 'sts-token' },
      endpoint: 'https://vpce-123.email.eu-west-1.vpce.amazonaws.com/',
    }).send(message());
    expect(seen[0]?.url).toBe(
      'https://vpce-123.email.eu-west-1.vpce.amazonaws.com/v2/email/outbound-emails',
    );
    expect(seen[0]?.headers['x-amz-security-token']).toBe('sts-token');
    expect(seen[0]?.headers['authorization']).toContain('x-amz-security-token');
  });

  test('every attempt of one message presents the same Message-ID', async () => {
    const { fetch, seen } = stub(() => Response.json({ MessageId: 'm-1' }));
    const driver = driverWith(fetch);
    await driver.send(message());
    await driver.send(message());
    const ids = seen.map((request) => /Message-ID: (.+)\r\n/.exec(rawOf(request.body))?.[1]);
    expect(ids[0]).toMatch(/^<welcome\.[0-9a-f]{32}@postly\.test>$/);
    expect(ids[1]).toBe(ids[0] ?? '');
  });

  test('a 2xx with no MessageId is still acceptance, under a local id', async () => {
    const { fetch } = stub(() => new Response('', { status: 200 }));
    const result = await driverWith(fetch).send(message());
    expect(result.id).toMatch(/^ses_/);
  });
});

/** `[status, how SES names the type, type, retryable, a fragment of the fix]`. */
const FAILURES: readonly (readonly [number, 'header' | 'body', string, boolean, string])[] = [
  [429, 'header', 'TooManyRequestsException', true, 'get-account'],
  [400, 'body', 'ThrottlingException', true, 'get-account'],
  [400, 'header', 'LimitExceededException', true, 'get-account'],
  [400, 'header', 'MessageRejected', false, 'get-email-identity'],
  [400, 'body', 'SendingPausedException', false, '--sending-enabled'],
  [400, 'header', 'AccountSendingPausedException', false, '--sending-enabled'],
  [400, 'header', 'AccountSuspendedException', false, '--sending-enabled'],
  [400, 'header', 'MailFromDomainNotVerifiedException', false, 'MAIL FROM'],
  [403, 'header', 'UnrecognizedClientException', false, 'SES_ACCESS_KEY_ID'],
  [403, 'body', 'InvalidSignatureException', false, 'SES_ACCESS_KEY_ID'],
  [403, 'header', 'SignatureDoesNotMatch', false, 'SES_ACCESS_KEY_ID'],
  [403, 'header', 'AccessDeniedException', false, 'ses:SendEmail'],
  [400, 'header', 'ExpiredTokenException', false, 'SES_ACCESS_KEY_ID'],
  [404, 'header', 'NotFoundException', false, 'SES_CONFIGURATION_SET'],
  [400, 'header', 'BadRequestException', false, 'API_SendEmail'],
  [500, 'header', 'InternalFailure', true, 'API_SendEmail'],
  [503, 'body', 'ServiceUnavailable', true, 'API_SendEmail'],
];

describe('createSesDriver — SES errors onto X_MAIL_SEND_FAILED', () => {
  test.each(FAILURES)('%p %s %s → retryable %p', async (status, where, type, retryable, fix) => {
    const { fetch } = stub(() =>
      where === 'header'
        ? Response.json(
            { message: `${type} happened` },
            {
              status,
              headers: { 'x-amzn-ErrorType': `${type}:http://internal.amazon.com/coral/` },
            },
          )
        : Response.json(
            { __type: `com.amazonaws.ses#${type}`, message: `${type} happened` },
            { status },
          ),
    );
    const error = await rejection(driverWith(fetch).send(message()));
    expect(error.code).toBe('X_MAIL_SEND_FAILED');
    expect(error.retry).toBe(retryable ? 'retryable' : 'terminal');
    expect(error.meta).toMatchObject({ driver: 'ses', stage: 'request', status, retryable });
    expect(error.cause).toContain(`${type}: ${type} happened`);
    expect(error.fix).toContain(fix);
    // Through the queue's own reader: the verdict that decides whether a 550-class is sent again.
    expect(nextRetryForError({ attempts: 5, backoff: 'exponential' }, 1, error).retry).toBe(
      retryable,
    );
  });

  test('an untyped 429 falls back to the status table and retries', async () => {
    const { fetch } = stub(() => new Response('slow down', { status: 429 }));
    const error = await rejection(driverWith(fetch).send(message()));
    expect(error.retry).toBe('retryable');
    expect(error.cause).toContain('HTTP 429: slow down');
  });

  test('a fetch that never answers is a retryable egress failure naming the endpoint', async () => {
    const error = await rejection(
      driverWith(() => Promise.reject(new TypeError('connect ECONNREFUSED'))).send(message()),
    );
    expect(error.code).toBe('X_MAIL_SEND_FAILED');
    expect(error.retry).toBe('retryable');
    expect(error.cause).toContain('ECONNREFUSED');
    expect(error.fix).toBe('curl -sS -m 5 -o /dev/null https://email.eu-west-1.amazonaws.com/');
  });

  test('neither the secret nor the session token reaches an error', async () => {
    const { fetch } = stub(() => Response.json({ message: 'no' }, { status: 403 }));
    const error = await rejection(
      driverWith(fetch, { credentials: { ...CREDENTIALS, sessionToken: 'sts-token' } }).send(
        message(),
      ),
    );
    const printed = JSON.stringify({ cause: error.cause, fix: error.fix, meta: error.meta });
    expect(printed).not.toContain(CREDENTIALS.secretAccessKey);
    expect(printed).not.toContain('sts-token');
  });
});

describe('createSesDriver — construction', () => {
  const ok = stub(() => Response.json({})).fetch;

  test.each([['us-east-1; DROP'], [''], ['US-EAST-1'], ['email.us-east-1']])(
    'region %p is refused naming SES_REGION',
    (region) => {
      const error = thrown(() => driverWith(ok, { region }));
      expect(error.code).toBe('X_CONFIG_INVALID');
      expect(error.cause).toContain('SES_REGION');
    },
  );

  test('an empty secret is refused naming the variable, not the value', () => {
    const error = thrown(() =>
      driverWith(ok, { credentials: { accessKeyId: 'AKID', secretAccessKey: ' ' } }),
    );
    expect(error.code).toBe('X_ENV_MISSING');
    expect(error.meta).toMatchObject({ missing: ['SES_SECRET_ACCESS_KEY'] });
  });

  test.each([['ftp://email.test'], ['not a url'], ['https://email.test/?x=1']])(
    'endpoint %p is refused',
    (endpoint) => {
      expect(thrown(() => driverWith(ok, { endpoint })).cause).toContain('SES_ENDPOINT');
    },
  );

  test.each([[0], [Number.NaN]])('timeoutMs %p is refused at construction', (timeoutMs) => {
    expect(thrown(() => driverWith(ok, { timeoutMs })).code).toBe('X_INVARIANT');
  });

  test('an empty from is refused', () => {
    expect(thrown(() => driverWith(ok, { from: '' })).code).toBe('X_CONFIG_INVALID');
  });
});

describe('createSesDriver — retainMime', () => {
  test('keeps exactly the bytes SES was handed, and hands them to onRetained with the SES id', async () => {
    const { fetch, seen } = stub(() => Response.json({ MessageId: 'ses-42' }));
    const entries: RetainedMimeEntry[] = [];
    const result = await driverWith(fetch, {
      retainMime: { onRetained: (entry) => void entries.push(entry) },
    }).send(message());

    const sent = rawOf(seen[0]?.body ?? '');
    if (result.mime?.kind !== 'kept') return expect.unreachable('expected the MIME to be kept');
    expect(result.mime.raw).toBe(sent);
    expect(result.mime.byteLength).toBe(new TextEncoder().encode(sent).byteLength);
    expect(result.mime.sha256).toBe(new Bun.CryptoHasher('sha256').update(sent).digest('hex'));
    expect(entries).toEqual([
      {
        mailId: 'welcome',
        id: 'ses-42',
        driver: 'ses',
        idempotencyKey: result.idempotencyKey,
        mime: result.mime,
      },
    ]);
  });

  test('over the cap only the digest is kept — never a truncated message', async () => {
    const { fetch, seen } = stub(() => Response.json({ MessageId: 'ses-43' }));
    const result = await driverWith(fetch, { retainMime: { maxBytes: 64 } }).send(message());
    const sent = rawOf(seen[0]?.body ?? '');
    expect(result.mime).toEqual({
      kind: 'digest-only',
      byteLength: new TextEncoder().encode(sent).byteLength,
      sha256: new Bun.CryptoHasher('sha256').update(sent).digest('hex'),
      maxBytes: 64,
    });
  });

  test('a sink that throws does not fail a send SES already accepted', async () => {
    const { fetch } = stub(() => Response.json({ MessageId: 'ses-44' }));
    const result = await driverWith(fetch, {
      retainMime: {
        onRetained: () => Promise.reject(new TypeError('audit table is read-only')),
      },
    }).send(message());
    expect(result.id).toBe('ses-44');
    expect(result.mime?.kind).toBe('kept');
  });

  test('off by default: no mime on the result', async () => {
    const { fetch } = stub(() => Response.json({ MessageId: 'ses-45' }));
    expect((await driverWith(fetch).send(message())).mime).toBeUndefined();
  });

  test.each([[0], [Number.NaN], [10_485_761]])(
    'maxBytes %p is refused at construction',
    (maxBytes) => {
      const ok = stub(() => Response.json({})).fetch;
      expect(isUltimateError(thrown(() => driverWith(ok, { retainMime: { maxBytes } })))).toBe(
        true,
      );
    },
  );
});

describe('createSesDriver — prototype keys in an SES error type', () => {
  test.each([
    ['__proto__', 400, false],
    ['constructor', 400, false],
    ['toString', 503, true],
    ['hasOwnProperty', 429, true],
  ] as const)('type %p falls back to the status table (%p)', async (type, status, retryable) => {
    const { fetch } = stub(() =>
      Response.json(
        { __type: type, message: 'odd' },
        { status, headers: { 'x-amzn-ErrorType': type } },
      ),
    );
    const error = await rejection(driverWith(fetch).send(message()));
    expect(error.code).toBe('X_MAIL_SEND_FAILED');
    expect(error.retry).toBe(retryable ? 'retryable' : 'terminal');
    expect(error.fix).toContain('API_SendEmail');
  });
});

describe('createSesDriver — a sink that never settles', () => {
  test('the send still settles: onRetained is called, never awaited', async () => {
    const { fetch } = stub(() => Response.json({ MessageId: 'ses-46' }));
    let called = 0;
    const result = await driverWith(fetch, {
      retainMime: {
        onRetained: () => {
          called += 1;
          return new Promise<void>(() => undefined);
        },
      },
    }).send(message());
    expect(result.id).toBe('ses-46');
    expect(result.mime?.kind).toBe('kept');
    expect(called).toBe(1);
  });

  test('a synchronous throw from the sink does not fail the send either', async () => {
    const { fetch } = stub(() => Response.json({ MessageId: 'ses-47' }));
    // The sink's failure is input to the code under test, not a verdict: built once, then thrown.
    const exploded = new TypeError('sink exploded');
    const result = await driverWith(fetch, {
      retainMime: {
        onRetained: () => {
          throw exploded;
        },
      },
    }).send(message());
    expect(result.id).toBe('ses-47');
  });
});
