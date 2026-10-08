// The push channel through a real notifier run: one `send` per recipient addressed by id (the
// pusher reaches every device that person subscribed), catalog keys never text, and a pusher that
// throws is the run's retry like any channel's — while a replayed run sends nothing twice.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resetJobs } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import type { NotifyPushMessage, Pusher } from './channel-push';
import { PUSH_CHANNEL, pushChannel } from './channel-push';
import { notifier } from './notifier';
import type { TestParams } from './notify-fixture';
import { driver } from './notify-fixture';
import { resetNotifyStores } from './stores';

const POST = '00000000-0000-7000-8000-00000000beef';
const params: TestParams = { postId: POST };

beforeEach(() => resetJobs());
afterEach(() => {
  resetNotifyStores();
  resetJobs();
});

const recording = (sent: { to: string; message: NotifyPushMessage }[]): Pusher => ({
  send: ({ to, message }) => {
    sent.push({ to, message });
  },
});

const liked = (pusher: Pusher) =>
  notifier<TestParams>({
    name: 'post.liked',
    input: t.object({ postId: t.uuid }),
    tenant: 'none',
    key: (input) => `like:${input.postId}`,
    deliver: [
      {
        channel: pushChannel<TestParams>({
          pusher,
          message: ({ event }) => ({
            titleKey: 'push.liked.title',
            bodyKey: 'push.liked.body',
            url: `/posts/${event.params.postId}`,
            tag: `post:${event.params.postId}`,
          }),
        }),
      },
    ],
  });

describe('unit · the push channel', () => {
  test('one send per recipient, addressed by id, carrying keys and a tag', async () => {
    const sent: { to: string; message: NotifyPushMessage }[] = [];
    await driver().finish(liked(recording(sent)), {
      params,
      recipients: [{ id: 'ana' }, { id: 'ben' }],
    });
    expect(sent).toEqual([
      {
        to: 'ana',
        message: {
          titleKey: 'push.liked.title',
          bodyKey: 'push.liked.body',
          url: `/posts/${POST}`,
          tag: `post:${POST}`,
        },
      },
      {
        to: 'ben',
        message: {
          titleKey: 'push.liked.title',
          bodyKey: 'push.liked.body',
          url: `/posts/${POST}`,
          tag: `post:${POST}`,
        },
      },
    ]);
    const message: NotifyPushMessage = { titleKey: 'a', bodyKey: 'b', url: '/' };
    expect(pushChannel({ pusher: recording([]), message: () => message }).name).toBe(PUSH_CHANNEL);
  });

  test('a pusher that throws is X_NOTIFY_DELIVERY_FAILED — the job’s retry, not a lost push', async () => {
    const failing: Pusher = {
      send: () =>
        Promise.reject(Object.assign(new RangeError('429'), { code: 'X_PWA_PUSH_FAILED' })),
    };
    await expect(
      driver().finish(liked(failing), { params, recipients: [{ id: 'ana' }] }),
    ).rejects.toBeUltimateError('X_NOTIFY_DELIVERY_FAILED');
  });
});
