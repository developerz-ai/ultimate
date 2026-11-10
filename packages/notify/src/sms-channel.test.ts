// `smsChannel()` driven through a real notifier: per recipient, the number resolved, the key
// rendered in the recipient's locale, one idempotency key per delivery — and the two refusals
// (no number is skipped, a non-E.164 one is terminal) before any transport is asked.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resetJobs } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import { installNotifyStores, resetNotifyStores } from './adapter';
import { notifier } from './notifier';
import type { TestParams } from './notify-fixture';
import { driver } from './notify-fixture';
import { smsChannel, smsIdempotencyKey } from './sms-channel';
import type { SmsMessage, SmsTransport } from './sms-transport';
import { memorySmsTransport } from './sms-transport';

const POST = '00000000-0000-7000-8000-00000000beef';

beforeEach(() => {
  resetJobs();
  installNotifyStores({});
});

afterEach(() => {
  resetNotifyStores();
  resetJobs();
});

/** Renders `<locale>:<key>:<params>` so the test can see which locale and key reached the body. */
const echoTranslate =
  (locale: string) => (key: string, params?: Readonly<Record<string, unknown>>) =>
    `${locale}:${key}:${JSON.stringify(params ?? {})}`;

function liked(transport: SmsTransport) {
  const handle = notifier<TestParams>({
    name: 'post.liked',
    input: t.object({ postId: t.uuid }),
    tenant: 'none',
    key: (input) => `like:${input.postId}`,
    deliver: [
      {
        channel: smsChannel<TestParams>({
          transport,
          translate: echoTranslate,
          message: ({ event }) => ({ key: 'sms.liked', params: { post: event.params.postId } }),
        }),
      },
    ],
  });
  return handle;
}

describe('unit · smsChannel', () => {
  test('one SMS per recipient, rendered in its locale, keyed per delivery', async () => {
    const transport = memorySmsTransport();
    const handle = liked(transport);
    await driver().finish(handle, {
      params: { postId: POST },
      recipients: [
        { id: 'ana', to: '+4915112345678', locale: 'de' },
        { id: 'ben', to: '+14155550123', locale: 'en' },
      ],
    });
    expect(transport.sent).toEqual([
      {
        to: '+4915112345678',
        body: `de:sms.liked:{"post":"${POST}"}`,
        idempotencyKey: smsIdempotencyKey('post.liked', `like:${POST}`, 'sms', 'ana'),
      },
      {
        to: '+14155550123',
        body: `en:sms.liked:{"post":"${POST}"}`,
        idempotencyKey: smsIdempotencyKey('post.liked', `like:${POST}`, 'sms', 'ben'),
      },
    ]);
  });

  test('a recipient with no number is skipped, not failed', async () => {
    const transport = memorySmsTransport();
    const handle = liked(transport);
    await driver().finish(handle, {
      params: { postId: POST },
      recipients: [{ id: 'ana' }, { id: 'ben', to: '+14155550123' }],
    });
    expect(transport.sent.map((sms) => sms.to)).toEqual(['+14155550123']);
  });

  test('a non-E.164 number is refused, terminal, before the transport is asked', async () => {
    // A transport that checks nothing, so the refusal seen is the CHANNEL's own.
    const asked: SmsMessage[] = [];
    const lax: SmsTransport = {
      name: 'lax',
      send: (message) => {
        asked.push(message);
        return Promise.resolve({ transport: 'lax', id: 'x', to: message.to, idempotencyKey: '' });
      },
    };
    const handle = liked(lax);
    const refused = driver().finish(handle, {
      params: { postId: POST },
      recipients: [{ id: 'ana', to: '0151 12345678' }],
    });
    await expect(refused).rejects.toMatchObject({ retry: 'terminal' });
    expect(asked).toEqual([]);
  });

  test('the idempotency key holds no number', () => {
    expect(smsIdempotencyKey('n', 'k', 'sms', 'ana')).not.toContain('+');
  });
});
