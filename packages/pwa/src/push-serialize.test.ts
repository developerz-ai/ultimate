// serializePushMessage's wire body, fed to the emitted push handler: the two halves of one contract
// with no type between them, so the string is executed, never inspected. Split from push.test.ts.

import { describe, expect, test } from 'bun:test';
import type { PushPayload, Translate } from './push';
import { pushSource, renderPushPayload, serializePushMessage } from './push';

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
          // The Notifications spec: `showNotification` rejects with a `TypeError` when `renotify`
          // is set and `tag` is empty, and NOTHING is shown. A stub that accepts the pair cannot
          // see the one bug this describes. Not a verdict thrown by the test — it is the browser
          // behaviour the emitted handler is the subject of, the same shape `StubCache.addAll`
          // uses in `service-worker-runtime.test.ts`.
          //
          // The DOMString conversion is the half a stub reading `options['tag']` raw cannot see:
          // `tag` is a `DOMString` in `NotificationOptions`, so WebIDL converts every value before
          // the emptiness test — and `[]` converts to `''`. A stub comparing the raw value found a
          // truthy array and agreed with the truthiness check that shipped the bug.
          const raw = options['tag'];
          const tag = raw === undefined ? undefined : String(raw);
          if (options['renotify'] === true && (tag === undefined || tag === '')) {
            throw new TypeError('Notification: renotify requires a non-empty tag');
          }
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
    expect(shown?.options['data']).toEqual({ url: '/posts/1', actions: {} });
    expect(shown?.options['actions']).toEqual([{ action: 'reply', title: 'Neuer Kommentar' }]);
  });

  test('an action url survives render and the wire into the data notificationclick reads', async () => {
    const withUrl = renderPushPayload(
      {
        ...payload,
        actions: [
          { action: 'reply', titleKey: 'push.comment.title', url: '/posts/1/reply' },
          { action: 'mute', titleKey: 'push.comment.title' },
        ],
      },
      'de-DE',
      translate,
    );
    expect(withUrl.actions).toEqual([
      { action: 'reply', title: 'Neuer Kommentar', url: '/posts/1/reply' },
      { action: 'mute', title: 'Neuer Kommentar' },
    ]);
    const sw = pushRealm(pushSource({}));
    await sw.deliver(serializePushMessage(withUrl));
    expect(sw.shown[0]?.options['data']).toEqual({
      url: '/posts/1',
      actions: { reply: '/posts/1/reply' },
    });
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

  /**
   * `renotify` means "replace the notification carrying this tag and alert again", so the spec
   * makes it meaningless without one and `showNotification` rejects rather than degrading: the
   * device shows NOTHING. A payload declaring `renotify` and no `tag` is a mistake an author makes
   * once, and the worker is the last place that can keep it from costing the whole notification.
   */
  test('renotify without a tag still shows the notification, with renotify dropped', async () => {
    const noTag = renderPushPayload({ ...payload, renotify: true }, 'de-DE', translate);
    const sw = pushRealm(pushSource({}));
    await sw.deliver(serializePushMessage(noTag));

    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0]?.options['renotify']).toBe(false);
    expect(sw.shown[0]?.options['tag']).toBeUndefined();
  });

  test('a payload the worker did not compose is guarded the same way', async () => {
    const sw = pushRealm(pushSource({}));
    // Straight off the wire: this package is not the only thing that may compose a push body.
    await sw.deliver(JSON.stringify({ title: 'x', tag: null, renotify: true, url: '/' }));

    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0]?.options['renotify']).toBe(false);
  });

  /**
   * Every non-string a JSON push body can carry in `tag`. `''` is what a composing server produces
   * from an unset collapse key; `[]` is truthy in JS and converts to the EMPTY DOMString, which is
   * the pair `showNotification` rejects — so `!!d.tag` enabled `renotify` for it and the device
   * showed nothing at all. `{}` converts to `'[object Object]'`, which the browser would accept as
   * a collapse key nobody chose: not a rejection, but a tag that silently replaces an unrelated
   * notification. A non-empty STRING is the one shape that is neither.
   */
  test('a tag that is not a non-empty string never enables renotify', async () => {
    for (const tag of ['', [], {}] as const) {
      const sw = pushRealm(pushSource({}));
      await sw.deliver(JSON.stringify({ title: 'x', tag, renotify: true, url: '/' }));

      expect(sw.shown).toHaveLength(1);
      expect(sw.shown[0]?.options['renotify']).toBe(false);
    }
  });

  /**
   * The same pair one layer up, where the composing server can still be told. `payload.tag` is
   * typed `string`, and `''` is a string: `payload.tag !== undefined` let it through, so
   * `renderPushPayload` emitted the exact pair its own comment says `showNotification` rejects,
   * with no warning for the server that wrote it.
   */
  test('renderPushPayload reads an empty tag as no tag, and says so', () => {
    const blank = renderPushPayload({ ...payload, tag: '', renotify: true }, 'de-DE', translate);

    expect(blank.renotify).toBe(false);
    expect(blank.tag).toBeNull();
    expect(blank.warnings).toEqual([
      expect.stringContaining('renotify needs a tag to replace') as unknown as string,
    ]);
  });

  test('a push with no data body still shows something, rooted at /', async () => {
    const sw = pushRealm(pushSource({}));
    await sw.deliver(null);

    expect(sw.shown[0]?.title).toBe('');
    expect(sw.shown[0]?.options['data']).toEqual({ url: '/', actions: {} });
  });
});

/**
 * `subscribeSource` is emitted client code, so it is executed rather than read: an existing
 * subscription must be reused (subscribing twice invalidates the first endpoint) and the locale
 * must travel with the subscription, which is the whole reason this file exists.
 */
