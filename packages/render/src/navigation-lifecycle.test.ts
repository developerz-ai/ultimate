// The controller across the page's own lifecycle, over the fake DOM: a document LOADED onto an
// entry with a saved offset, the back/forward cache (an open channel keeps a page out of it), the
// sheets of a navigation aborted before its swap, and a form's line breaks as a native submit sends them.
import { afterEach, describe, expect, test } from 'bun:test';
import { startNavigation } from './navigation';
import { answers, fire, page, stopRouter, tab } from './navigation-controller-fixture';
import {
  type FakeElement,
  type FakeForm,
  fakeWindow,
  h,
  htmlAnswer,
  settle,
} from './navigation-dom-fixture';
import { NAVIGATION_CHANNEL } from './navigation-tabs';

let started: ReturnType<typeof startNavigation>;
afterEach(() => {
  started?.stop();
  started = undefined;
  stopRouter();
});

/** A tab on `url` whose current entry already holds `state` — a reload, or Back after a full load. */
function loadOnto(url: string, state: unknown) {
  const doc = page('A');
  const win = fakeWindow(doc, url, () => Promise.reject(new TypeError('offline')));
  win.history.replaceState(state, '');
  started = startNavigation(win as unknown as Window);
  return win;
}

describe('a document loaded onto a saved entry', () => {
  test('lands where the visitor left it, and the entry keeps that offset', () => {
    const win = loadOnto('https://app.test/a', {
      app: 1,
      __x: { scroll: [0, 2000], doc: 'https://app.test/a' },
    });
    expect(win.scrollY).toBe(2000);
    expect(win.history.state).toEqual({
      app: 1,
      __x: { scroll: [0, 2000], doc: 'https://app.test/a' },
    });
  });

  test("an entry naming another document is not this one's to restore", () => {
    const win = loadOnto('https://app.test/a', {
      __x: { scroll: [0, 2000], doc: 'https://app.test/b' },
    });
    expect(win.scrollY).toBe(0);
  });

  test('an entry with no saved offset starts at the top', () => {
    const win = loadOnto('https://app.test/a', { app: 1 });
    expect(win.scrollY).toBe(0);
    expect(win.history.state).toEqual({
      app: 1,
      __x: { scroll: [0, 0], doc: 'https://app.test/a' },
    });
  });
});

/** Every channel the router opens on this origin's name, and whether it was closed. */
function watchChannels() {
  const Real = globalThis.BroadcastChannel;
  const opened: { closed: boolean }[] = [];
  class Watched extends Real {
    readonly record = { closed: false };
    constructor(name: string) {
      super(name);
      if (name === NAVIGATION_CHANNEL) opened.push(this.record);
    }
    override close(): void {
      this.record.closed = true;
      super.close();
    }
  }
  globalThis.BroadcastChannel = Watched;
  return { opened, restore: () => (globalThis.BroadcastChannel = Real) };
}

const pageEvent = (type: string, persisted: boolean): Event =>
  Object.assign(new Event(type), { persisted });

describe('the back/forward cache', () => {
  test('pagehide closes the channel; a restore reopens it and forgets every guess', async () => {
    const channels = watchChannels();
    try {
      const { win, doc, calls } = tab({ '/b': answers.b });
      expect(channels.opened).toEqual([{ closed: false }]);
      fire(doc, 'focusin', doc.getElementById('to-b'));
      await settle();
      win.dispatchEvent(pageEvent('pagehide', true));
      expect(channels.opened).toEqual([{ closed: true }]);
      // A fresh load's own `pageshow` is not a restore: nothing reopens or empties.
      win.dispatchEvent(pageEvent('pageshow', false));
      expect(channels.opened).toHaveLength(1);
      win.dispatchEvent(pageEvent('pageshow', true));
      expect(channels.opened).toEqual([{ closed: true }, { closed: false }]);
      fire(doc, 'focusin', doc.getElementById('to-b'));
      await settle();
      expect(calls).toEqual(['GET /b prefetch', 'GET /b prefetch']);
      stopRouter();
      expect(channels.opened).toEqual([{ closed: true }, { closed: true }]);
    } finally {
      channels.restore();
    }
  });
});

describe('a navigation aborted while its sheets load', () => {
  test('leaves no sheet behind once the next page is in place', async () => {
    const styled = page('B');
    styled.head.append(h('link', { rel: 'stylesheet', href: '/b.css' }));
    const { win, doc } = tab({
      '/b': () => htmlAnswer('page:B-styled', styled),
      '/c': answers.c,
    });
    // The newer click lands the moment /b's sheet is appended — between its load and its swap.
    const head = doc.head;
    const append = head.append.bind(head);
    head.append = (...nodes: FakeElement[]) => {
      append(...nodes);
      if (nodes.some((node) => node.getAttribute('href') === 'https://app.test/b.css')) {
        fire(win, 'click', doc.getElementById('to-c'));
      }
    };
    fire(win, 'click', doc.getElementById('to-b'));
    await settle();
    expect(doc.title).toBe('C');
    expect(head.querySelectorAll('link').map((link) => link.getAttribute('href'))).toEqual([]);
  });
});

describe('a form', () => {
  const formPage = (method: string) =>
    page('A', {}, [
      h('form', { id: 'f', action: '/c', method }, [h('textarea', { name: 'note' })]),
    ]);

  test('a POST body and a GET query carry their line breaks as CRLF, as the browser does', async () => {
    const sent: string[] = [];
    const record = (init: RequestInit | undefined) => {
      sent.push(String(init?.body));
      return answers.c();
    };
    const expected = 'note%0D%0Akey=a%0D%0Ab%0D%0Ac%0D%0Ad';
    for (const method of ['post', 'get']) {
      const { win, doc, calls } = tab({ '/c': record }, formPage(method));
      const form = doc.getElementById('f') as FakeForm;
      form.fields = [['note\nkey', 'a\nb\rc\r\nd']];
      fire(win, 'submit', form, { submitter: null });
      await settle();
      if (method === 'post') expect(sent).toEqual([expected]);
      else expect(calls).toEqual([`GET /c?${expected} soft`]);
      stopRouter();
    }
  });

  test('an action no URL parses is left to the browser, not thrown from the handler', () => {
    const { win, doc } = tab({}, formPage('post'));
    const form = doc.getElementById('f') as FakeForm;
    form.setAttribute('action', 'http://');
    expect(fire(win, 'submit', form, { submitter: null }).defaultPrevented).toBe(false);
  });
});
