import { describe, expect, test } from 'bun:test';
import type { PushPayload, PushSubscriptionRecord, Translate } from './push';
import { pushSource, renderPushPayload, subscriptionState } from './push';

const catalog: Readonly<Record<string, string>> = {
  'push.comment.title': 'Neuer Kommentar',
  'push.comment.body': '{author} hat geantwortet',
};

const translate: Translate = (key, params) => {
  const template = catalog[key];
  if (template === undefined) return `⟦${key}⟧`;
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params?.[name] ?? ''));
};

const payload: PushPayload = {
  titleKey: 'push.comment.title',
  bodyKey: 'push.comment.body',
  params: { author: 'Mira' },
  url: '/posts/1',
};

describe('renderPushPayload', () => {
  test('renders the body in the subscriber locale', () => {
    const rendered = renderPushPayload(payload, 'de-DE', translate);
    expect(rendered.title).toBe('Neuer Kommentar');
    expect(rendered.body).toBe('Mira hat geantwortet');
    expect(rendered.locale).toBe('de-DE');
    expect(rendered.warnings).toEqual([]);
  });

  test('a missing key is a warning, not a notification nobody can read', () => {
    const rendered = renderPushPayload({ ...payload, bodyKey: 'push.missing' }, 'de-DE', translate);
    expect(rendered.body).toBe('⟦push.missing⟧');
    expect(rendered.warnings).toEqual(['missing de-DE translation for push.missing']);
  });
});

describe('subscription lifecycle', () => {
  const record: PushSubscriptionRecord = {
    endpoint: 'https://push.test/abc',
    keys: { p256dh: 'p', auth: 'a' },
    locale: 'de-DE',
    timeZone: 'Europe/Berlin',
    actorId: 'actor-1',
    createdAt: 0,
    expirationTime: 1_000,
  };

  test('410 means gone, an elapsed expiry means expired', () => {
    expect(subscriptionState(record, 410)).toBe('gone');
    expect(subscriptionState(record, 201, 500)).toBe('active');
    expect(subscriptionState(record, 201, 2_000)).toBe('expired');
  });
});

describe('pushSource', () => {
  test('emits the badge call only when badging is enabled', () => {
    expect(pushSource({ badging: true })).toContain('navigator.setAppBadge');
    expect(pushSource({})).not.toContain('navigator.setAppBadge');
  });
});
