// The push channel through a real notifier run: one `send` per recipient addressed by id (the
// pusher reaches every device that person subscribed), catalog keys never text, and a pusher that
// throws is the run's retry like any channel's — while a replayed run sends nothing twice.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { memoryStepStore, resetJobs } from '@ultimat3/jobs';
import { t } from '@ultimat3/schema';
import { resetNotifyStores } from './adapter';
import type { DataPusher, NotifyPushMessage, Pusher } from './channel-push';
import { PUSH_CHANNEL, pushChannel } from './channel-push';
import { notifier } from './notifier';
import type { TestParams } from './notify-fixture';
import { driver } from './notify-fixture';

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

  test('a replayed run sends nothing twice — the step checkpoint, then the ledger', async () => {
    const sent: { to: string; message: NotifyPushMessage }[] = [];
    const handle = liked(recording(sent));
    const run = { params, recipients: [{ id: 'ana' }] };
    const store = memoryStepStore();
    await driver({ store }).finish(handle, run);
    // The same run again: every step answers from its checkpoint.
    await driver({ store }).finish(handle, run);
    // Another run of the same event (a requeue that lost its checkpoints): the ledger's claim.
    await driver({ runId: 'run-replayed' }).finish(handle, run);
    expect(sent.map((one) => one.to)).toEqual(['ana']);
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

  test('with `data`, the push is data-only: `sendData` alone, carrying the ids', async () => {
    const sent: { to: string; data: Readonly<Record<string, string>> }[] = [];
    const pusher: Pusher & DataPusher = {
      send: () => expect.unreachable('a data push never reaches send'),
      sendData: ({ to, data }) => {
        sent.push({ to, data });
      },
    };
    const approval = notifier<TestParams>({
      name: 'post.approval',
      input: t.object({ postId: t.uuid }),
      tenant: 'none',
      key: (input) => `approval:${input.postId}`,
      deliver: [
        {
          channel: pushChannel<TestParams>({
            pusher,
            data: ({ event }) => ({ postId: event.params.postId }),
          }),
        },
      ],
    });
    await driver().finish(approval, { params, recipients: [{ id: 'ana' }] });
    expect(sent).toEqual([{ to: 'ana', data: { postId: POST } }]);
  });

  test('a pusher that cannot send data-only — a browser push always shows — is a type error', () => {
    const webOnly: Pusher = recording([]);
    // @ts-expect-error `webPush()` has no `sendData`: a data push through it would render nothing.
    const channel = pushChannel({ pusher: webOnly, data: () => ({ id: '1' }) });
    expect(channel.name).toBe(PUSH_CHANNEL);
  });
});
