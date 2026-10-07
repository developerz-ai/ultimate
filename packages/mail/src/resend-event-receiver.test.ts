// The Resend receiver against a recorded webhook body signed Svix-style with a test secret: what
// an authentic delivery becomes, and that a change to ANY byte of the body — or to the id, the
// timestamp or the signature — is refused, coded, before the body is ever parsed.

import { describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError, type UltimateError } from '@ultimat3/core';
import {
  RESEND_BOUNCED,
  RESEND_SECRET,
  resendRequest,
  svixSignature,
} from './delivery-event-fixture';
import { resendEventReceiver } from './resend-event-receiver';

const SVIX_ID = 'msg_2KWPBgLlAfxdpx2AI54pPJ85f4W';
const SVIX_TIMESTAMP = '1791288000'; // 2026-10-06T12:00:00Z
const clock = frozenClock('2026-10-06T12:01:00.000Z');
const receiver = resendEventReceiver({ secret: RESEND_SECRET, clock });

async function signed(body: string, id = SVIX_ID, timestamp = SVIX_TIMESTAMP): Promise<Request> {
  return resendRequest(body, {
    'content-type': 'application/json',
    'svix-id': id,
    'svix-timestamp': timestamp,
    'svix-signature': await svixSignature(id, timestamp, body),
  });
}

async function refusal(promise: Promise<unknown>): Promise<UltimateError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (isUltimateError(error)) return error;
  return expect.unreachable('expected the receiver to refuse with an UltimateError');
}

const BODY = JSON.stringify(RESEND_BOUNCED);

describe('resendEventReceiver — authentic webhooks', () => {
  test('email.bounced (Permanent) becomes a hard bounce keyed on the Resend email id', async () => {
    const outcome = await receiver.receive(await signed(BODY));
    expect(outcome).toEqual({
      type: 'events',
      events: [
        {
          provider: 'resend',
          kind: 'bounced',
          bounce: 'hard',
          messageId: '56761188-7520-42d8-8898-ff6fc54ce618',
          recipient: 'jane@example.test',
          at: new Date('2026-10-06T11:59:50.000Z'),
          eventId: SVIX_ID,
          raw: RESEND_BOUNCED,
        },
      ],
    });
  });

  test.each([
    ['email.delivered', 'delivered'],
    ['email.complained', 'complained'],
    ['email.delivery_delayed', 'delayed'],
  ])('%s is %s', async (type, kind) => {
    const outcome = await receiver.receive(
      await signed(JSON.stringify({ ...RESEND_BOUNCED, type })),
    );
    expect(outcome.type === 'events' && outcome.events[0]).toMatchObject({ kind });
    expect(outcome.type === 'events' && outcome.events[0]).not.toHaveProperty('bounce');
  });

  test('a Transient bounce is soft', async () => {
    const body = JSON.stringify({
      ...RESEND_BOUNCED,
      data: { ...RESEND_BOUNCED.data, bounce: { type: 'Transient' } },
    });
    const outcome = await receiver.receive(await signed(body));
    expect(outcome.type === 'events' && outcome.events[0]).toMatchObject({ bounce: 'soft' });
  });

  test('email.opened is authentic and ignored', async () => {
    const outcome = await receiver.receive(
      await signed(JSON.stringify({ ...RESEND_BOUNCED, type: 'email.opened' })),
    );
    expect(outcome).toEqual({ type: 'ignored', eventType: 'email.opened' });
  });

  test('a rotating secret: any one matching v1 entry verifies', async () => {
    const good = await svixSignature(SVIX_ID, SVIX_TIMESTAMP, BODY);
    const request = resendRequest(BODY, {
      'svix-id': SVIX_ID,
      'svix-timestamp': SVIX_TIMESTAMP,
      'svix-signature': `v1,c2lnbmVkLWJ5LXRoZS1vbGQtc2VjcmV0 v2,ignored ${good}`,
    });
    expect((await receiver.receive(request)).type).toBe('events');
  });
});

describe('resendEventReceiver — forgeries are refused', () => {
  test('flipping any one byte of the body is refused as a bad signature', async () => {
    const signature = await svixSignature(SVIX_ID, SVIX_TIMESTAMP, BODY);
    for (let index = 0; index < BODY.length; index += 1) {
      const swapped = BODY[index] === 'a' ? 'b' : 'a';
      const tampered = `${BODY.slice(0, index)}${swapped}${BODY.slice(index + 1)}`;
      const request = resendRequest(tampered, {
        'svix-id': SVIX_ID,
        'svix-timestamp': SVIX_TIMESTAMP,
        'svix-signature': signature,
      });
      const error = await refusal(receiver.receive(request));
      expect(error.meta).toEqual({ provider: 'resend', reason: 'signature' });
    }
  });

  test('a changed id or timestamp is refused: both are under the mac', async () => {
    const signature = await svixSignature(SVIX_ID, SVIX_TIMESTAMP, BODY);
    for (const [id, timestamp] of [
      ['msg_2KWPBgLlAfxdpx2AI54pPJ85f4X', SVIX_TIMESTAMP],
      [SVIX_ID, '1791288001'],
    ] as const) {
      const request = resendRequest(BODY, {
        'svix-id': id,
        'svix-timestamp': timestamp,
        'svix-signature': signature,
      });
      expect((await refusal(receiver.receive(request))).meta?.['reason']).toBe('signature');
    }
  });

  test('a body signed with another secret is refused', async () => {
    const other = resendEventReceiver({
      secret: `whsec_${btoa('a-different-secret-entirely')}`,
      clock,
    });
    expect((await refusal(other.receive(await signed(BODY)))).meta?.['reason']).toBe('signature');
  });

  test.each([['svix-id'], ['svix-timestamp'], ['svix-signature']])(
    'a request missing %s is unsigned',
    async (header) => {
      const request = await signed(BODY);
      request.headers.delete(header);
      const error = await refusal(receiver.receive(request));
      expect(error.code).toBe('X_MAIL_EVENT_UNVERIFIED');
      expect(error.meta).toEqual({ provider: 'resend', reason: 'unsigned' });
    },
  );

  test('an authentic delivery outside five minutes is stale, either direction', async () => {
    for (const at of ['2026-10-06T12:05:01Z', '2026-10-06T11:54:59Z']) {
      const late = resendEventReceiver({ secret: RESEND_SECRET, clock: frozenClock(at) });
      expect((await refusal(late.receive(await signed(BODY)))).meta?.['reason']).toBe('stale');
    }
  });

  test('an authentic body that is not Resend JSON is invalid, not unverified', async () => {
    const error = await refusal(receiver.receive(await signed('{"type":"email.bounced"}')));
    expect(error.code).toBe('X_MAIL_EVENT_INVALID');
    expect(error.meta).toEqual({ provider: 'resend', problem: 'notification' });
  });

  test('neither the secret nor the signature reaches the refusal', async () => {
    const request = resendRequest(`${BODY} `, {
      'svix-id': SVIX_ID,
      'svix-timestamp': SVIX_TIMESTAMP,
      'svix-signature': await svixSignature(SVIX_ID, SVIX_TIMESTAMP, BODY),
    });
    const error = await refusal(receiver.receive(request));
    const printed = JSON.stringify({ cause: error.cause, fix: error.fix, meta: error.meta });
    expect(printed).not.toContain(RESEND_SECRET.slice(6));
    expect(printed).not.toContain('v1,');
  });
});

describe('resendEventReceiver — configuration', () => {
  test.each([['whsec_'], ['whsec_!!!not-base64'], ['whsec_c2hvcnQ=']])(
    'secret %p is refused at construction',
    (secret) => {
      expect(() => resendEventReceiver({ secret })).toThrow(/whsec_/);
    },
  );

  test.each([[0], [Number.NaN]])('toleranceMs %p is refused at construction', (toleranceMs) => {
    expect(() => resendEventReceiver({ secret: RESEND_SECRET, toleranceMs })).toThrow();
  });
});

describe('resendEventReceiver — prototype keys from the body', () => {
  // `type` is the sender's string; an object lookup would answer `Object.prototype` for these.
  test.each([['constructor'], ['__proto__'], ['toString'], ['hasOwnProperty']])(
    'a signed event of type %p is ignored, never mapped',
    async (type) => {
      const outcome = await receiver.receive(
        await signed(JSON.stringify({ ...RESEND_BOUNCED, type })),
      );
      expect(outcome).toEqual({ type: 'ignored', eventType: type });
    },
  );

  test('a bounce type of __proto__ is soft, never hard', async () => {
    const body = JSON.stringify({
      ...RESEND_BOUNCED,
      data: { ...RESEND_BOUNCED.data, bounce: { type: '__proto__' } },
    });
    const outcome = await receiver.receive(await signed(body));
    expect(outcome.type === 'events' && outcome.events[0]).toMatchObject({ bounce: 'soft' });
  });
});
