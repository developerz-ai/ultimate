// A next page whose stylesheet will not load (a rolling deploy's other replica 404s it): a GET
// becomes the browser's full load, a POST swaps but keeps the sheet that styles the tab, a refresh
// stays quiet — and the working sheet is never retired for one that did not arrive.
import { afterEach, describe, expect, test } from 'bun:test';
import { click, currentRouter, fire, page, stopRouter, tab } from './navigation-controller-fixture';
import {
  type FakeDocument,
  type FakeForm,
  type FakeWindow,
  h,
  htmlAnswer,
  settle,
} from './navigation-dom-fixture';

afterEach(stopRouter);

/** `doc` with `href` linked in its head, as the server rendered it. */
const styled = (doc: FakeDocument, href: string): FakeDocument => {
  doc.head.append(h('link', { rel: 'stylesheet', href }));
  return doc;
};

const sheets = (doc: FakeDocument): (string | null)[] =>
  doc.head.querySelectorAll('link').map((l) => l.getAttribute('href'));

describe('a stylesheet that does not load', () => {
  test('a loaded sheet swaps and the previous page’s own is retired', async () => {
    const { win, doc } = tab(
      { '/b': () => htmlAnswer('page:B', styled(page('B'), '/b.css')) },
      styled(page('A'), '/a.css'),
    );
    click(win, 'to-b');
    await settle();
    expect(doc.title).toBe('B');
    expect(sheets(doc)).toEqual(['https://app.test/b.css']);
    expect(win.assigned).toEqual([]);
  });

  test('a GET is loaded by the browser; the page on screen keeps its sheet', async () => {
    const { win, doc } = tab(
      { '/b': () => htmlAnswer('page:B', styled(page('B'), '/fail.css')) },
      styled(page('A'), '/a.css'),
    );
    click(win, 'to-b');
    await settle();
    expect(win.assigned).toEqual(['https://app.test/b']);
    expect(doc.title).toBe('A');
    // The failed link is gone too: a later navigation asks for it again instead of trusting it.
    expect(sheets(doc)).toEqual(['/a.css']);
  });

  test('a POST answered in place is shown, never re-sent, and the old sheet stays', async () => {
    const f = h('form', { id: 'f', method: 'post', action: '/send' }) as FakeForm;
    f.fields = [];
    const { win, doc, calls } = tab(
      { '/send': () => htmlAnswer('page:Sent', styled(page('Sent'), '/fail.css')) },
      styled(page('A', {}, [f]), '/a.css'),
    );
    fire(win as FakeWindow, 'submit', doc.getElementById('f'), { submitter: null });
    await settle();
    expect(calls).toEqual(['POST /send soft']);
    expect(win.assigned).toEqual([]);
    expect(doc.title).toBe('Sent');
    expect(sheets(doc)).toEqual(['/a.css']);
  });

  test('a refresh ends quietly: nothing swapped, nothing reloaded, settled', async () => {
    const { win, doc } = tab(
      { '/a': () => htmlAnswer('page:A2', styled(page('A2'), '/fail.css')) },
      styled(page('A'), '/a.css'),
    );
    const settled = currentRouter()?.refresh();
    await settle();
    expect(await settled).toBe(true);
    expect(win.assigned).toEqual([]);
    expect(doc.title).toBe('A');
    expect(sheets(doc)).toEqual(['/a.css']);
  });
});
