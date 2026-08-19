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
