// The emitted push and notificationclick handlers on input the framework did not compose: a push
// body is written by whatever holds the VAPID key, and a tap opens whatever URL that body names.

import { describe, expect, test } from 'bun:test';
import { pushSource } from './push';

const ORIGIN = 'https://app.test';

interface Shown {
  readonly title: string;
  readonly options: Record<string, unknown>;
}

function realm() {
  const listeners = new Map<string, (event: unknown) => void>();
  const shown: Shown[] = [];
  const opened: string[] = [];
  const self = {
    location: { origin: ORIGIN },
    addEventListener(type: string, listener: (event: unknown) => void): void {
      listeners.set(type, listener);
    },
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        // WebIDL: `actions` is a sequence, so a non-iterable rejects and nothing is shown.
        if (!Array.isArray(options['actions'])) throw new TypeError('actions is not a sequence');
        shown.push({ title, options });
      },
    },
  };
  const clients = {
    matchAll: async () => [],
    openWindow: async (url: string): Promise<null> => {
      opened.push(url);
      return null;
    },
  };
  const factory = new Function('self', 'clients', 'navigator', pushSource({})) as (
    scope: typeof self,
    clientList: typeof clients,
    nav: Record<string, unknown>,
  ) => void;
  factory(self, clients, {});

  /** Fires an event; `extended` is false when the handler threw before it called `waitUntil`. */
  const fire = async (type: string, event: Record<string, unknown>) => {
    let work: Promise<unknown> | undefined;
    listeners.get(type)?.({
      ...event,
      waitUntil: (p: Promise<unknown>) => {
        work = p;
      },
    });
    await work;
    return { extended: work !== undefined };
  };

  return {
    shown,
    opened,
    push: (text: string) =>
      fire('push', { data: { json: (): unknown => JSON.parse(text), text: () => text } }),
    click: (url: unknown) =>
      fire('notificationclick', { notification: { close: () => undefined, data: { url } } }),
  };
}

/**
 * `event.data.json()` ran before `waitUntil`, so a body that is not JSON threw out of the listener:
 * no notification, and a `userVisibleOnly` subscription the browser may revoke for it.
 */
describe('the push handler, on a body it did not compose', () => {
  test('a plain-text body is shown as the body, inside waitUntil', async () => {
    const sw = realm();
    const { extended } = await sw.push('Your order shipped');
    expect(extended).toBe(true);
    expect(sw.shown).toHaveLength(1);
    expect(sw.shown[0]?.options['body']).toBe('Your order shipped');
    expect(sw.shown[0]?.options['data']).toEqual({ url: '/' });
  });

  test.each(['null', '42', '"hi"', '[1,2]'])(
    'JSON that is no object (%s) still shows',
    async (body) => {
      const sw = realm();
      expect((await sw.push(body)).extended).toBe(true);
      expect(sw.shown).toHaveLength(1);
    },
  );

  test('actions that are not a list do not cost the notification', async () => {
    const sw = realm();
    await sw.push(JSON.stringify({ title: 't', actions: 'reply' }));
    expect(sw.shown[0]?.options['actions']).toEqual([]);
  });

  test('a well-formed body is read as before', async () => {
    const sw = realm();
    await sw.push(JSON.stringify({ title: 'Hola', body: 'b', url: '/posts/1' }));
    expect(sw.shown[0]?.title).toBe('Hola');
    expect(sw.shown[0]?.options['data']).toEqual({ url: '/posts/1' });
  });
});

/** A tap opens a window on THIS app only; anything else opens the app's root instead. */
describe('the notificationclick handler, on a URL off this origin', () => {
  test.each([
    'https://evil.test/login',
    '//evil.test/login',
    'javascript:alert(1)',
    'data:text/html,hi',
    'http://app.test/posts/1',
    'http://[',
  ])('%s opens the app root', async (url) => {
    const sw = realm();
    await sw.click(url);
    expect(sw.opened).toEqual([`${ORIGIN}/`]);
  });

  test.each([
    ['/posts/1', `${ORIGIN}/posts/1`],
    [`${ORIGIN}/posts/1?x=1#c`, `${ORIGIN}/posts/1?x=1#c`],
    [{}, `${ORIGIN}/`],
  ] as const)('%p on this origin is opened', async (url, href) => {
    const sw = realm();
    await sw.click(url);
    expect(sw.opened).toEqual([href]);
  });
});
