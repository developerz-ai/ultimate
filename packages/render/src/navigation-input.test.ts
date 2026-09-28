// The controller under REAL input over the fake DOM: a press is not a hover, a click the view
// transition aimed at `<html>` reaches the element under the pointer, and no guess is sent for the
// page a navigation is already fetching. Chrome: `client-navigation-input.e2e.test.ts`.
import { afterEach, describe, expect, test } from 'bun:test';
import { answers, click, fire, page, stopRouter, tab } from './navigation-controller-fixture';
import { type FakeDocument, type FakeElement, htmlAnswer, settle } from './navigation-dom-fixture';

afterEach(stopRouter);

describe('real input', () => {
  test('a press is not a hover: it cancels the pending guess, and the focus it gives is no guess', async () => {
    const { doc, calls } = tab({ '/b': answers.b });
    const link = doc.getElementById('to-b');
    fire(doc, 'pointerover', link);
    fire(doc, 'pointerdown', link);
    fire(doc, 'focusin', link);
    await new Promise((r) => setTimeout(r, 120));
    fire(doc, 'pointerup', link);
    fire(doc, 'focusin', link);
    await settle();
    expect(calls).toEqual(['GET /b prefetch']);
  });

  test('a click the transition aimed at <html> is given to the element under the pointer', async () => {
    let skipped = 0;
    const { win, doc } = tab({ '/b': answers.b });
    doc.startViewTransition = (update) => {
      update();
      return {
        updateCallbackDone: Promise.resolve(),
        ready: Promise.resolve(),
        // Still animating when the visitor presses.
        finished: new Promise<void>(() => undefined),
        skipTransition: () => {
          skipped += 1;
        },
      } as ReturnType<NonNullable<FakeDocument['startViewTransition']>>;
    };
    click(win, 'to-b');
    await settle();
    const link = doc.getElementById('to-c') as FakeElement;
    doc.underPointer = link;
    fire(doc, 'pointerdown', doc.documentElement);
    fire(win, 'click', doc.documentElement, { clientX: 5, clientY: 5 });
    expect([skipped, link.clicks]).toEqual([1, 1]);
    // Nothing under the pointer but the page itself: nothing to give it to.
    doc.underPointer = null;
    fire(doc, 'pointerdown', doc.documentElement);
    fire(win, 'click', doc.documentElement, { clientX: 5, clientY: 5 });
    expect(link.clicks).toBe(1);
  });

  test('no guess for the page a navigation is already fetching', async () => {
    let release = (_r: Response): void => undefined;
    const { win, doc, calls } = tab({
      '/slow': () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    });
    click(win, 'to-slow');
    fire(doc, 'focusin', doc.getElementById('to-slow'));
    await settle();
    release(htmlAnswer('page:Slow2', page('Slow')));
    await settle();
    expect(calls).toEqual(['GET /slow soft']);
  });
});
