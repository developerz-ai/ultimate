// The two channels that ship: the inbox one, which is the only channel with no external driver,
// and the mail one, whose whole point is that it takes a Mailer STRUCTURALLY rather than importing
// a package one tier sideways.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resetJobs } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import { inAppChannel } from './channel-in-app';
import type { NotifyMail } from './channel-mail';
import { mailChannel } from './channel-mail';
import { createMemoryInboxStore } from './inbox';
import { notifier } from './notifier';
import type { TestParams } from './notify-fixture';
import { driver } from './notify-fixture';
import { resetNotifyStores, setNotifyStores } from './stores';

const POST = '00000000-0000-7000-8000-00000000beef';
const params: TestParams = { postId: POST };

beforeEach(() => {
  resetJobs();
});

afterEach(() => {
  resetNotifyStores();
  resetJobs();
});

describe('unit · shipped channels', () => {
  test('the in-app channel writes one inbox row per recipient, and a replay writes none', async () => {
    const inbox = createMemoryInboxStore();
    setNotifyStores({ inbox });
    const handle = notifier<TestParams>({
      name: 'post.liked',
      input: t.object({ postId: t.uuid }),
      tenant: 'none',
      key: (input) => `like:${input.postId}`,
      deliver: [{ channel: inAppChannel<TestParams>() }],
    });

    const recipients = [{ id: 'ana' }, { id: 'ben' }];
    await driver().finish(handle, { params, recipients });
    expect(inbox.size).toBe(2);
    expect(await inbox.unreadCount('ana')).toBe(1);
  });

  test('the in-app channel with no inbox installed refuses by name', async () => {
    setNotifyStores({});
    const handle = notifier<TestParams>({
      name: 'post.liked',
      input: t.object({ postId: t.uuid }),
      tenant: 'none',
      key: (input) => `like:${input.postId}`,
      deliver: [{ channel: inAppChannel<TestParams>() }],
    });

    await expect(
      driver().finish(handle, { params, recipients: [{ id: 'ana' }] }),
    ).rejects.toBeUltimateError('X_NOTIFY_DELIVERY_FAILED');
  });

  test('the mailer takes the recipient locale and tz, and never invents either', async () => {
    setNotifyStores({});
    const posted: NotifyMail<TestParams>[] = [];
    const handle = notifier<TestParams>({
      name: 'post.liked',
      input: t.object({ postId: t.uuid }),
      tenant: 'none',
      key: (input) => `like:${input.postId}`,
      deliver: [
        {
          channel: mailChannel<TestParams>({
            mailer: {
              send: (mail) => {
                posted.push(mail);
              },
            },
          }),
        },
      ],
    });

    await driver().finish(handle, {
      params,
      recipients: [
        { id: 'ana', to: 'ana@example.test', locale: 'en-GB', tz: 'Europe/London' },
        // No locale and no tz: the mailer is handed `undefined`, never a guessed default.
        { id: 'ben', to: 'ben@example.test' },
      ],
    });

    expect(posted.map((mail) => mail.to)).toEqual(['ana@example.test', 'ben@example.test']);
    expect(posted[0]?.locale).toBe('en-GB');
    expect(posted[0]?.tz).toBe('Europe/London');
    expect(posted[1]?.locale).toBeUndefined();
    expect(posted[1]?.tz).toBeUndefined();
    expect(posted[0]?.batch.map((event) => event.key)).toEqual([`like:${POST}`]);
  });

  test('a recipient with no address is skipped, not dead-lettered', async () => {
    setNotifyStores({});
    const posted: NotifyMail<TestParams>[] = [];
    const handle = notifier<TestParams>({
      name: 'post.liked',
      input: t.object({ postId: t.uuid }),
      tenant: 'none',
      key: (input) => `like:${input.postId}`,
      deliver: [
        {
          channel: mailChannel<TestParams>({
            mailer: {
              send: (mail) => {
                posted.push(mail);
              },
            },
          }),
        },
      ],
    });

    // Retrying the same event finds the same missing address, so a dead letter per addressless
    // recipient buys nothing. The other recipient still gets their mail.
    const report = await driver().finish(handle, {
      params,
      recipients: [{ id: 'ana' }, { id: 'ben', to: 'ben@example.test' }],
    });
    expect(posted.map((mail) => mail.to)).toEqual(['ben@example.test']);
    expect(report.delivered).toBe(2);
  });
});
