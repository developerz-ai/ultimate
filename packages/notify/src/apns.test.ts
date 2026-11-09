// Golden payloads for APNs: the headers and body a send carries, per shape — background data, an
// alert, a collapse id, the expiration a TTL becomes, the priority urgency picks. Apple refuses a
// background push at priority 10 and drops an alert whose `aps` is misspelled, silently.

import { describe, expect, test } from 'bun:test';
import { apnsRequest } from './apns';
import type { RenderedNativePush } from './push-message';

const NOW = 1_800_000_000;
const TOPIC = 'com.example.app';

const alert = (over: Partial<RenderedNativePush> = {}): RenderedNativePush => ({
  title: 'New reply',
  body: 'Ada answered your post',
  url: '/posts/42',
  collapse: undefined,
  ttlSeconds: 86_400,
  urgent: true,
  ...over,
});

describe('unit · apnsRequest golden payloads', () => {
  test('data only: background push type, priority 5, content-available, no expiration', () => {
    expect(apnsRequest({ kind: 'data', data: { postId: '42' } }, TOPIC, NOW)).toEqual({
      headers: { 'apns-topic': TOPIC, 'apns-push-type': 'background', 'apns-priority': '5' },
      body: '{"postId":"42","aps":{"content-available":1}}',
    });
  });

  test('an alert: alert push type, priority 10, expiration = now + TTL, url beside aps', () => {
    expect(apnsRequest({ kind: 'alert', push: alert() }, TOPIC, NOW)).toEqual({
      headers: {
        'apns-topic': TOPIC,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(NOW + 86_400),
      },
      body: '{"aps":{"alert":{"title":"New reply","body":"Ada answered your post"}},"url":"/posts/42"}',
    });
  });

  test('a collapse id and a non-urgent alert: apns-collapse-id, priority 5', () => {
    const { headers } = apnsRequest(
      { kind: 'alert', push: alert({ collapse: 'thread-42', urgent: false, ttlSeconds: 60 }) },
      TOPIC,
      NOW,
    );
    expect(headers).toEqual({
      'apns-topic': TOPIC,
      'apns-push-type': 'alert',
      'apns-priority': '5',
      'apns-expiration': String(NOW + 60),
      'apns-collapse-id': 'thread-42',
    });
  });

  test('a data key named aps cannot replace the content-available block', () => {
    const { body } = apnsRequest({ kind: 'data', data: { aps: 'x' } }, TOPIC, NOW);
    expect(JSON.parse(body)).toEqual({ aps: { 'content-available': 1 } });
  });
});
