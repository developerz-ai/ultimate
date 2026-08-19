import { describe, expect, test } from 'bun:test';
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
 * The wire body and the handler that reads it are two halves of one contract with no type between
 * them: `RenderedNotification.locale` leaves as `lang`, and `warnings` must not leave at all. So the
 * serialized string is fed to the emitted `push` handler rather than inspected for field names.
 */
describe('serializePushMessage, read by the emitted push handler', () => {
  interface ShownNotification {
    readonly title: string;
    readonly options: Record<string, unknown>;
  }

  function pushRealm(source: string) {
    const listeners = new Map<string, (event: unknown) => void>();
    const shown: ShownNotification[] = [];
    const badged: number[] = [];

    const self = {
      location: { origin: 'https://app.test' },
      addEventListener(type: string, listener: (event: unknown) => void): void {
        listeners.set(type, listener);
      },
      registration: {
        showNotification: async (
          title: string,
          options: Record<string, unknown>,
        ): Promise<void> => {
          shown.push({ title, options });
        },
      },
    };
    const navigator = {
      setAppBadge: (): void => {
        badged.push(1);
      },
    };
    const factory = new Function('self', 'clients', 'navigator', source) as (
      scope: typeof self,
      clientList: Record<string, unknown>,
      nav: typeof navigator,
    ) => void;
    factory(self, { matchAll: async () => [], openWindow: async () => null }, navigator);

    return {
      shown,
      badged,
      async deliver(body: string | null): Promise<void> {
        let work: Promise<unknown> = Promise.resolve();
        listeners.get('push')?.({
          data: body === null ? null : { json: (): unknown => JSON.parse(body) },
          waitUntil: (p: Promise<unknown>) => {
            work = p;
          },
        });
        await work;
      },
    };
  }

  const rendered = renderPushPayload(
    {
      ...payload,
      tag: 'comments',
      icon: '/icons/comment.png',
      renotify: true,
      requireInteraction: true,
      actions: [{ action: 'reply', titleKey: 'push.comment.title' }],
    },
    'de-DE',
    translate,
  );

  test('carries the locale as lang, which is the field the handler actually reads', async () => {
    const sw = pushRealm(pushSource({}));
    await sw.deliver(serializePushMessage(rendered));

    expect(sw.shown).toHaveLength(1);
    const shown = sw.shown[0];
    expect(shown?.title).toBe('Neuer Kommentar');
    expect(shown?.options['body']).toBe('Mira hat geantwortet');
    expect(shown?.options['lang']).toBe('de-DE');
    expect(shown?.options['tag']).toBe('comments');
    expect(shown?.options['icon']).toBe('/icons/comment.png');
    expect(shown?.options['renotify']).toBe(true);
    expect(shown?.options['requireInteraction']).toBe(true);
    expect(shown?.options['data']).toEqual({ url: '/posts/1' });
    expect(shown?.options['actions']).toEqual([{ action: 'reply', title: 'Neuer Kommentar' }]);
  });

  test('the missing-translation warnings stay server-side — they are not shipped to a device', () => {
    const missing = renderPushPayload({ ...payload, bodyKey: 'push.gone' }, 'de-DE', translate);
    expect(missing.warnings).toHaveLength(1);

    const wire: Record<string, unknown> = JSON.parse(serializePushMessage(missing));
    expect(Object.keys(wire).sort()).toEqual([
      'actions',
      'badge',
      'body',
      'icon',
      'lang',
      'renotify',
      'requireInteraction',
      'tag',
      'title',
      'url',
    ]);
  });

  test('the badge falls back to the default the generator was given, not to the payload', async () => {
    const sw = pushRealm(pushSource({ defaultBadge: '/icons/mono.png' }));
    await sw.deliver(serializePushMessage(rendered));

    expect(sw.shown[0]?.options['badge']).toBe('/icons/mono.png');
    // badging off → no app-badge call at all, not a guarded one.
    expect(sw.badged).toEqual([]);
  });

  test('badging on sets the app badge after the notification is shown', async () => {
    const sw = pushRealm(pushSource({ badging: true }));
    await sw.deliver(serializePushMessage(rendered));

    expect(sw.badged).toEqual([1]);
  });

  test('a push with no data body still shows something, rooted at /', async () => {
    const sw = pushRealm(pushSource({}));
    await sw.deliver(null);

    expect(sw.shown[0]?.title).toBe('');
    expect(sw.shown[0]?.options['data']).toEqual({ url: '/' });
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
