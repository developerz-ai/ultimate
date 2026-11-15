// `inboundMail()` end to end below the HTTP pipeline: each provider's door refuses a forgery before
// anything is parsed, a signed multipart message round-trips to a typed message with its PDF in
// storage, and an oversize or malformed message is a coded refusal — never a bare throw.

import { beforeAll, describe, expect, test } from 'bun:test';
import { frozenClock, isUltimateError, type UltimateError } from '@ultimat3/core';
import { memoryStorageDriver } from '@ultimat3/storage';
import {
  RESEND_SECRET,
  type SnsSigner,
  sesNotification,
  snsBody,
  snsSigner,
  svixSignature,
  TOPIC_ARN,
} from './delivery-event-fixture';
import type { MailFetch } from './driver-resend';
import {
  base64Of,
  inboundOf,
  MULTIPART,
  PDF_BYTES,
  RESEND_EMAIL_ID,
  RESEND_RECEIVED,
  SES_MESSAGE_ID,
  sesReceived,
} from './inbound-fixture';
import { inboundMail } from './inbound-mail';
import { readInbound } from './inbound-message';
import { resendInbound } from './inbound-resend';
import { sesInbound } from './inbound-ses';
import type { InboundAttachmentOptions, InboundDoor, InboundProvider } from './inbound-types';
import { DEFAULT_MIME_LIMITS, type MimeLimits } from './mime-parse';

let signer: SnsSigner;
beforeAll(async () => {
  signer = await snsSigner();
});

const clock = frozenClock('2026-10-06T12:01:00.000Z');

const ses = (): InboundProvider =>
  sesInbound({
    topicArns: [TOPIC_ARN],
    clock,
    fetchCertificate: async () => signer.certificatePem,
  });

async function refusal(promise: Promise<unknown>): Promise<UltimateError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (isUltimateError(error)) return error;
  return expect.unreachable(`expected a coded refusal, got ${String(error)}`);
}

function queued(door: InboundDoor) {
  if ('answer' in door) return expect.unreachable('expected a row, the door answered');
  return door;
}

async function sesDoor(content: string | undefined) {
  const message = await sesNotification(signer, sesReceived(content));
  return ses().door(inboundOf(snsBody(message)));
}

const read = (
  provider: InboundProvider,
  door: { eventId: string; row: unknown },
  extra: {
    limits?: MimeLimits;
    attachments?: InboundAttachmentOptions | false;
    orgId?: string;
  } = {},
) =>
  readInbound({
    provider,
    eventId: door.eventId,
    orgId: extra.orgId,
    payload: door.row,
    limits: extra.limits ?? DEFAULT_MIME_LIMITS,
    attachments: extra.attachments ?? {},
  });

describe('inboundMail — a forged delivery is refused at the door', () => {
  test('SES: one byte changed in the signed Message is X_MAIL_EVENT_UNVERIFIED', async () => {
    const message = await sesNotification(signer, sesReceived(base64Of(MULTIPART)));
    const forged = { ...message, Message: message.Message.replace('support@', 'attacker@') };
    const error = await refusal(ses().door(inboundOf(snsBody(forged))));
    expect(error.code).toBe('X_MAIL_EVENT_UNVERIFIED');
    expect(error.meta?.['reason']).toBe('signature');
  });

  test('SES: a topic not in topicArns is refused before any certificate is fetched', async () => {
    let fetched = 0;
    const provider = sesInbound({
      topicArns: ['arn:aws:sns:us-west-2:123456789012:other'],
      clock,
      fetchCertificate: async () => {
        fetched += 1;
        return signer.certificatePem;
      },
    });
    const message = await sesNotification(signer, sesReceived(base64Of(MULTIPART)));
    const error = await refusal(provider.door(inboundOf(snsBody(message))));
    expect(error.meta?.['reason']).toBe('topic');
    expect(fetched).toBe(0);
  });

  test('Resend: a signature over other bytes is refused, and so is none', async () => {
    const body = JSON.stringify(RESEND_RECEIVED);
    const id = 'msg_inbound_1';
    const timestamp = '1791288000';
    const provider = resendInbound({ secret: RESEND_SECRET, apiKey: 're_test', clock });
    const forged = inboundOf(body, {
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': await svixSignature(id, timestamp, body.replace('support@', 'x@')),
    });
    expect((await refusal(provider.door(forged))).code).toBe('X_MAIL_EVENT_UNVERIFIED');
    const unsigned = await refusal(provider.door(inboundOf(body)));
    expect(unsigned.meta?.['reason']).toBe('unsigned');
  });
});

describe('inboundMail — SES posts the whole message', () => {
  test('text + html + attachment round-trip; the PDF lands in storage, the script does not', async () => {
    const door = queued(await sesDoor(base64Of(MULTIPART)));
    expect(door.eventId).toBe(SES_MESSAGE_ID);
    const disk = memoryStorageDriver();
    const message = await read(ses(), door, { attachments: { disk: () => disk } });
    expect(message).toMatchObject({
      provider: 'ses',
      recipients: ['support@app.test'],
      messageId: '<m-1@sender.test>',
      from: { address: 'ada@sender.test', name: 'Ada Lovelace' },
      to: [{ address: 'support@app.test', name: undefined }],
      cc: [{ address: 'charles@sender.test', name: 'Babbage, Charles' }],
      subject: 'Invoice — March',
      text: 'Please find the invoice attached.',
      html: '<p>Please find the invoice attached.</p>',
      verdicts: { spam: 'PASS', virus: 'PASS', spf: 'PASS', dkim: 'GRAY', dmarc: 'PASS' },
    });
    expect(message.date?.toISOString()).toBe('2026-10-06T12:00:00.000Z');
    expect(message.headers.filter((h) => h.name === 'Received')).toHaveLength(2);
    const [pdf, script] = message.attachments;
    if (pdf?.stored !== true) return expect.unreachable('the PDF should be stored');
    expect(pdf).toMatchObject({ filename: 'invoice.pdf', contentType: 'application/pdf' });
    expect(disk.objects().get(pdf.key)).toEqual(PDF_BYTES);
    expect(script).toMatchObject({ filename: 'run-me.html', stored: false });
    expect(disk.objects().size).toBe(1);
  });

  test('a retried job writes the same keys — one object per attachment, never a copy', async () => {
    const door = queued(await sesDoor(base64Of(MULTIPART)));
    const disk = memoryStorageDriver();
    const first = await read(ses(), door, { attachments: { disk: () => disk } });
    const second = await read(ses(), door, { attachments: { disk: () => disk } });
    expect(second.attachments).toEqual(first.attachments);
    expect(disk.objects().size).toBe(1);
  });

  test('a tenanted message stores under org/<id>/; attachments: false stores nothing', async () => {
    const door = queued(await sesDoor(base64Of(MULTIPART)));
    const disk = memoryStorageDriver();
    const tenanted = await read(ses(), door, { attachments: { disk: () => disk }, orgId: 'org_7' });
    expect(tenanted.attachments[0]).toMatchObject({ stored: true });
    expect([...disk.objects().keys()][0]?.startsWith('org/org_7/inbound-mail/')).toBe(true);
    const off = await read(ses(), door, { attachments: false });
    expect(off.attachments.map((a) => (a.stored ? 'stored' : a.refusal))).toEqual([
      'disabled',
      'disabled',
    ]);
  });

  test('a notification with no content is refused, coded', async () => {
    const error = await refusal(sesDoor(undefined));
    expect(error.code).toBe('X_MAIL_INBOUND_MALFORMED');
    expect(error.meta?.['problem']).toBe('content-missing');
  });

  test('oversize is refused whole: X_MAIL_INBOUND_TOO_LARGE', async () => {
    const door = queued(await sesDoor(base64Of(MULTIPART)));
    const limits = { ...DEFAULT_MIME_LIMITS, maxBytes: 256 };
    const error = await refusal(read(ses(), door, { limits }));
    expect(error.code).toBe('X_MAIL_INBOUND_TOO_LARGE');
    expect(error.meta?.['limit']).toBe('maxBytes');
  });

  test('malformed MIME is refused with a code, never a bare throw', async () => {
    const broken = MULTIPART.replace('--mixed-1--', '');
    const door = queued(await sesDoor(base64Of(broken)));
    const error = await refusal(read(ses(), door));
    expect(error.code).toBe('X_MAIL_INBOUND_MALFORMED');
    expect(error.meta?.['problem']).toBe('boundary-unclosed');
  });
});

describe('inboundMail — Resend posts metadata; the job downloads the raw MIME', () => {
  const RAW_URL = 'https://raw.resend.test/emails/raw.eml?sig=abc';

  function resend(raw: string) {
    const calls: { url: string; auth: string | null }[] = [];
    const fetch: MailFetch = async (url, init) => {
      calls.push({ url, auth: new Headers(init.headers).get('authorization') });
      if (url.includes('/emails/receiving/')) {
        return Response.json({ id: RESEND_EMAIL_ID, raw: { download_url: RAW_URL } });
      }
      return new Response(raw);
    };
    const provider = resendInbound({
      secret: RESEND_SECRET,
      apiKey: 're_test_key',
      clock,
      fetch,
      resolve: async () => ['93.184.216.34'],
    });
    return { provider, calls };
  }

  async function signedDoor(provider: InboundProvider) {
    const body = JSON.stringify(RESEND_RECEIVED);
    const id = 'msg_inbound_1';
    const timestamp = '1791288000';
    const headers = {
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': await svixSignature(id, timestamp, body),
    };
    return queued(await provider.door(inboundOf(body, headers)));
  }

  test('the round trip: API read with the key, raw download without it, one typed message', async () => {
    const { provider, calls } = resend(MULTIPART);
    const door = await signedDoor(provider);
    expect(door).toEqual({
      eventId: RESEND_EMAIL_ID,
      row: { provider: 'resend', recipients: ['support@app.test'], emailId: RESEND_EMAIL_ID },
    });
    const disk = memoryStorageDriver();
    const message = await read(provider, door, { attachments: { disk: () => disk } });
    expect(message.subject).toBe('Invoice — March');
    expect(message.text).toBe('Please find the invoice attached.');
    expect(message.attachments[0]).toMatchObject({ stored: true, contentType: 'application/pdf' });
    expect(calls.map((call) => call.auth)).toEqual(['Bearer re_test_key', null]);
  });

  test('a raw download past maxBytes is X_MAIL_INBOUND_TOO_LARGE', async () => {
    const { provider } = resend(MULTIPART);
    const door = await signedDoor(provider);
    const limits = { ...DEFAULT_MIME_LIMITS, maxBytes: 256 };
    const error = await refusal(read(provider, door, { limits }));
    expect(error.code).toBe('X_MAIL_INBOUND_TOO_LARGE');
  });

  test('an authentic delivery event on the same endpoint queues nothing', async () => {
    const { provider } = resend(MULTIPART);
    const body = JSON.stringify({ type: 'email.delivered', data: { email_id: 'x', to: [] } });
    const headers = {
      'svix-id': 'msg_2',
      'svix-timestamp': '1791288000',
      'svix-signature': await svixSignature('msg_2', '1791288000', body),
    };
    const door = await provider.door(inboundOf(body, headers));
    expect('answer' in door).toBe(true);
  });
});

describe('inboundMail — the declaration', () => {
  test('is a webhook receiver: a job handle with one POST route at its path', () => {
    const receiver = inboundMail({
      name: `inbound.test.${crypto.randomUUID()}`,
      path: '/hooks/mail/inbound',
      provider: ses,
      tenant: 'none',
      handle: async () => undefined,
    });
    expect(receiver.routes().map((route) => [route.method, route.path])).toEqual([
      ['POST', '/hooks/mail/inbound'],
    ]);
  });

  test.each([
    ['a NaN bound', { limits: { maxBytes: Number.NaN } }],
    ['an unsafe prefix', { attachments: { prefix: '../escape' } }],
  ])('refuses %s at declaration, coded', (_, extra) => {
    let thrown: unknown;
    try {
      inboundMail({
        name: `inbound.test.${crypto.randomUUID()}`,
        path: '/hooks/mail/inbound',
        provider: ses,
        tenant: 'none',
        handle: async () => undefined,
        ...extra,
      });
    } catch (error) {
      thrown = error;
    }
    expect(isUltimateError(thrown)).toBe(true);
  });

  test('the provider is built on first delivery, never at declaration', () => {
    let calls = 0;
    const receiver = inboundMail({
      name: `inbound.test.${crypto.randomUUID()}`,
      path: '/hooks/mail/lazy',
      provider: () => {
        calls += 1;
        // Unset env in a role that never receives: refused only if a delivery asks.
        return sesInbound({ topicArns: [] });
      },
      tenant: 'none',
      handle: async () => undefined,
    });
    expect(calls).toBe(0);
    expect(receiver.routes()).toHaveLength(1);
  });

  test('a provider refuses its own config at construction', () => {
    expect(() => sesInbound({ topicArns: [] })).toThrow(/topic ARN/);
    expect(() => resendInbound({ secret: RESEND_SECRET, apiKey: '' })).toThrow(/API key/);
  });
});
