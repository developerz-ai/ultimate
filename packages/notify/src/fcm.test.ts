// Golden payloads for FCM HTTP v1: the `message` a send carries, byte for byte, per shape — data
// only, an alert, a collapse key, a TTL, a normal priority. A field renamed here is a push Android
// silently drops, and no other suite reads the wire this closely.

import { describe, expect, test } from 'bun:test';
import { fcmMessage } from './fcm';
import type { RenderedNativePush } from './push-message';

const alert = (over: Partial<RenderedNativePush> = {}): RenderedNativePush => ({
  title: 'New reply',
  body: 'Ada answered your post',
  url: '/posts/42',
  collapse: undefined,
  ttlSeconds: 86_400,
  urgent: true,
  ...over,
});

describe('unit · fcmMessage golden payloads', () => {
  test('data only: no notification block, high priority, the ids as data', () => {
    expect(
      JSON.stringify(fcmMessage('tok', { kind: 'data', data: { postId: '42', kind: 'reply' } })),
    ).toBe('{"token":"tok","data":{"postId":"42","kind":"reply"},"android":{"priority":"high"}}');
  });

  test('an alert: title and body as notification, url as data, TTL in seconds', () => {
    expect(JSON.stringify(fcmMessage('tok', { kind: 'alert', push: alert() }))).toBe(
      '{"token":"tok","notification":{"title":"New reply","body":"Ada answered your post"},' +
        '"data":{"url":"/posts/42"},"android":{"priority":"high","ttl":"86400s"}}',
    );
  });

  test('a collapse id rides as collapse_key, a non-urgent alert is normal priority', () => {
    const message = fcmMessage('tok', {
      kind: 'alert',
      push: alert({ collapse: 'thread-42', urgent: false, ttlSeconds: 60 }),
    });
    expect(message['android']).toEqual({
      priority: 'normal',
      ttl: '60s',
      collapse_key: 'thread-42',
    });
  });

  test('no collapse id emits no collapse_key member at all', () => {
    const android = fcmMessage('tok', { kind: 'alert', push: alert() })['android'];
    expect(Object.keys(android as object)).toEqual(['priority', 'ttl']);
  });

  test('the data payload is a copy: mutating it never reaches the caller', () => {
    const data = { postId: '42' };
    const message = fcmMessage('tok', { kind: 'data', data });
    (message['data'] as Record<string, string>)['postId'] = 'changed';
    expect(data.postId).toBe('42');
  });
});
