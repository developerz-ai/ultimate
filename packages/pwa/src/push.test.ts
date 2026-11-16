import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { PushPayload, PushSubscriptionRecord, Translate } from './push';
import {
  pushSource,
  renderPushPayload,
  serializePushMessage,
  subscribeSource,
  subscriptionState,
} from './push';

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

  /**
   * A flag that produces neither a build error nor a runtime effect is worse than no flag: an
   * author sets `renotify`, ships, and the only thing it changes is that the device shows nothing.
   * The warning is what turns the silently-dropped flag into something the composing server sees.
   */
  test('renotify without a tag is dropped and reported, never serialized as true', () => {
    const rendered = renderPushPayload({ ...payload, renotify: true }, 'de-DE', translate);
    expect(rendered.renotify).toBe(false);
    expect(rendered.warnings).toEqual([
      'renotify needs a tag to replace — dropped for push.comment.title',
    ]);
    expect(JSON.parse(serializePushMessage(rendered))['renotify']).toBe(false);
  });

  test('renotify with a tag survives, because that is the pair the spec accepts', () => {
    const rendered = renderPushPayload(
      { ...payload, renotify: true, tag: 'comments' },
      'de-DE',
      translate,
    );
    expect(rendered.renotify).toBe(true);
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
    expect(subscriptionState(record, 201, frozenClock(500))).toBe('active');
    expect(subscriptionState(record, 201, frozenClock(2_000))).toBe('expired');
  });

  // `Determinism | no Date.now()` (CLAUDE.md): every tier-4 "now" is a `Clock`, this one too.
  test('now arrives as a Clock, and advancing it is what expires a subscription', () => {
    const clock = frozenClock(999);
    expect(subscriptionState(record, 201, clock)).toBe('active');
    clock.advance(1);
    expect(subscriptionState(record, 201, clock)).toBe('expired');
  });

  test('a dead subscription is gone whatever the clock says', () => {
    expect(subscriptionState(record, 404, frozenClock(0))).toBe('gone');
  });
});

describe('pushSource', () => {
  test('emits the badge call only when badging is enabled', () => {
    expect(pushSource({ badging: true })).toContain('navigator.setAppBadge');
    expect(pushSource({})).not.toContain('navigator.setAppBadge');
  });
});

/**
 * The emitted `notificationclick` handler, executed the way the browser executes it. `payload.url`
 * is a PATH (`/posts/1`, per `PushPayload.url`) and `WindowClient.url` is always ABSOLUTE, so the
 * focus-existing-tab loop matched nothing, ever: every tap opened another window on top of the app
 * the user already had open. Asserting the text of the handler cannot see that.
 */
describe('the emitted notificationclick handler, executed', () => {
  const ORIGIN = 'https://app.test';

  interface FakeClient {
    readonly url: string;
    focus(): Promise<string>;
  }

  function realm(source: string) {
    const listeners = new Map<string, (event: unknown) => void>();
    const focused: string[] = [];
    const opened: string[] = [];
    let windows: readonly FakeClient[] = [];

    const self = {
      location: { origin: ORIGIN },
      addEventListener(type: string, listener: (event: unknown) => void): void {
        listeners.set(type, listener);
      },
      registration: { showNotification: async (): Promise<void> => undefined },
    };
    const clients = {
      matchAll: async (): Promise<readonly FakeClient[]> => windows,
      openWindow: async (url: string): Promise<null> => {
        opened.push(url);
        return null;
      },
    };
    const factory = new Function('self', 'clients', 'navigator', source) as (
      scope: typeof self,
      clientList: typeof clients,
      nav: Record<string, unknown>,
    ) => void;
    factory(self, clients, {});

    return {
      focused,
      opened,
      openTab(url: string): void {
        windows = [
          ...windows,
          {
            url,
            focus: async (): Promise<string> => {
              focused.push(url);
              return url;
            },
          },
        ];
      },
      async click(url: string | undefined): Promise<void> {
        let work: Promise<unknown> = Promise.resolve();
        listeners.get('notificationclick')?.({
          notification: { close: (): void => undefined, data: url === undefined ? {} : { url } },
          waitUntil: (p: Promise<unknown>) => {
            work = p;
          },
        });
        await work;
      },
    };
  }

  test('focuses the tab already showing the path, instead of opening a second window', async () => {
    const sw = realm(pushSource({}));
    sw.openTab(`${ORIGIN}/posts/1`);
    await sw.click('/posts/1');

    expect(sw.focused).toEqual([`${ORIGIN}/posts/1`]);
    expect(sw.opened).toEqual([]);
  });

  test('opens a window when no client is on that path', async () => {
    const sw = realm(pushSource({}));
    sw.openTab(`${ORIGIN}/settings`);
    await sw.click('/posts/1');

    expect(sw.focused).toEqual([]);
    expect(sw.opened).toEqual([`${ORIGIN}/posts/1`]);
  });

  test('a payload with no url falls back to the app root, resolved the same way', async () => {
    const sw = realm(pushSource({}));
    sw.openTab(`${ORIGIN}/`);
    await sw.click(undefined);

    expect(sw.focused).toEqual([`${ORIGIN}/`]);
    expect(sw.opened).toEqual([]);
  });
});

/**
 * `subscribeSource` is emitted client code, so it is executed rather than read: an existing
 * subscription must be reused (subscribing twice invalidates the first endpoint) and the locale
 * must travel with the subscription, which is the whole reason this file exists.
 */
describe('subscribeSource, executed', () => {
  interface SubscribeCall {
    readonly userVisibleOnly: boolean;
    readonly applicationServerKey: string;
  }

  function subscriber(existing: string | null) {
    const calls: SubscribeCall[] = [];
    const source = subscribeSource({
      publicKey: 'BKd-vapid-public-key',
      subject: 'mailto:ops@app.test',
    });
    const run = new Function(
      'registration',
      'locale',
      'timeZone',
      `${source.replace('export async function', 'async function')}
return subscribePush(registration,locale,timeZone);`,
    ) as (
      registration: unknown,
      locale: string,
      timeZone: string,
    ) => Promise<{ subscription: unknown; locale: string; timeZone: string }>;

    const registration = {
      pushManager: {
        getSubscription: async (): Promise<unknown> =>
          existing === null ? null : { toJSON: () => ({ endpoint: existing }) },
        subscribe: async (options: SubscribeCall): Promise<unknown> => {
          calls.push(options);
          return { toJSON: () => ({ endpoint: 'https://push.test/new' }) };
        },
      },
    };

    return {
      calls,
      subscribe: () => run(registration, 'de-DE', 'Europe/Berlin'),
    };
  }

  test('reuses an existing subscription instead of minting a second endpoint', async () => {
    const client = subscriber('https://push.test/old');
    const result = await client.subscribe();

    expect(result.subscription).toEqual({ endpoint: 'https://push.test/old' });
    expect(client.calls).toEqual([]);
    expect(result.locale).toBe('de-DE');
    expect(result.timeZone).toBe('Europe/Berlin');
  });

  test('subscribes with the VAPID key it was generated from, user-visible only', async () => {
    const client = subscriber(null);
    const result = await client.subscribe();

    expect(client.calls).toEqual([
      { userVisibleOnly: true, applicationServerKey: 'BKd-vapid-public-key' },
    ]);
    expect(result.subscription).toEqual({ endpoint: 'https://push.test/new' });
    expect(result.locale).toBe('de-DE');
  });
});
