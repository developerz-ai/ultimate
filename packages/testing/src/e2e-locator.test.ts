// A locator is LAZY, so what this asserts is when it resolved and what it asked — a recording page
// rather than a DOM, because the question here is the order of calls, not the shape of a document.

import { describe, expect, test } from 'bun:test';
import type { LocatablePage } from './e2e-locator';
import { e2eLocator, resetLocatorMarks } from './e2e-locator';
import { MARK_ATTRIBUTE } from './e2e-selection';

interface Recorder extends LocatablePage {
  readonly evaluated: readonly string[];
  readonly clicked: readonly string[];
}

const recorder = (answers: readonly string[]): Recorder => {
  const evaluated: string[] = [];
  const clicked: string[] = [];
  let turn = 0;
  return {
    evaluated,
    clicked,
    url: () => 'https://app.test/feed',
    evaluate: (expression: string) => {
      evaluated.push(expression);
      const answer = answers[Math.min(turn, answers.length - 1)] ?? '{}';
      turn += 1;
      return Promise.resolve(answer);
    },
    click: (selector: string) => {
      clicked.push(selector);
      return Promise.resolve();
    },
  };
};

const found = (count: number, visible: boolean, marked = false): string =>
  JSON.stringify({ count, visible, marked });

describe('e2e locator — refusals', () => {
  test('a click on a selection that matched nothing is X_E2E_LOCATOR_EMPTY', async () => {
    const page = recorder([found(0, false)]);
    const locator = e2eLocator(page, { kind: 'text', text: '3 likes', first: false });
    await expect(locator.click()).rejects.toThrow(/X_E2E_LOCATOR_EMPTY/);
    expect(page.clicked).toEqual([]);
  });

  test('the empty refusal quotes the call the test wrote', async () => {
    const page = recorder([found(0, false)]);
    const locator = e2eLocator(page, { kind: 'text', text: '3 likes', first: false });
    let message = '';
    try {
      await locator.click();
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain('page.getByText("3 likes")');
  });

  test('a click on an ambiguous selection is X_E2E_LOCATOR_AMBIGUOUS and clicks nothing', async () => {
    const page = recorder([found(2, true, true)]);
    const locator = e2eLocator(page, { kind: 'css', selector: 'button', first: false });
    await expect(locator.click()).rejects.toThrow(/X_E2E_LOCATOR_AMBIGUOUS/);
    expect(page.clicked).toEqual([]);
  });

  test('first() makes the same selection clickable', async () => {
    const page = recorder([found(1, true, true)]);
    const locator = e2eLocator(page, { kind: 'css', selector: 'button', first: false }).first();
    await locator.click();
    expect(page.clicked).toHaveLength(1);
  });

  test('an ambiguous locator still ANSWERS isVisible — an assertion is not a crash', async () => {
    const page = recorder([found(3, true)]);
    const locator = e2eLocator(page, { kind: 'css', selector: 'button', first: false });
    expect(await locator.isVisible()).toBe(true);
  });

  test('an ambiguous locator still answers count', async () => {
    const page = recorder([found(3, true)]);
    const locator = e2eLocator(page, { kind: 'css', selector: 'button', first: false });
    expect(await locator.count()).toBe(3);
  });
});

describe('e2e locator — laziness', () => {
  test('building one asks the page nothing at all', () => {
    const page = recorder([found(1, true)]);
    e2eLocator(page, { kind: 'css', selector: 'button', first: false }).first();
    expect(page.evaluated).toEqual([]);
  });

  test('every question is its own round trip, so a repainted page is re-read', async () => {
    const page = recorder([found(1, false), found(1, true)]);
    const locator = e2eLocator(page, { kind: 'css', selector: 'button', first: false });
    expect(await locator.isVisible()).toBe(false);
    expect(await locator.isVisible()).toBe(true);
    expect(page.evaluated).toHaveLength(2);
  });

  test('first() returns a NEW handle and leaves the original wide', async () => {
    const page = recorder([found(3, true)]);
    const wide = e2eLocator(page, { kind: 'css', selector: 'button', first: false });
    wide.first();
    await wide.count();
    expect(page.evaluated[0]).toContain('found;');
  });
});

describe('e2e locator — clicking', () => {
  test('the click goes to the MARK, not to the selector the test wrote', async () => {
    resetLocatorMarks();
    const page = recorder([found(1, true, true), 'true']);
    await e2eLocator(page, { kind: 'text', text: 'Like', first: false }).click();
    expect(page.clicked).toEqual([`[${MARK_ATTRIBUTE}="m1"]`]);
  });

  test('each click takes a fresh mark, so two locators cannot address one element', async () => {
    resetLocatorMarks();
    const page = recorder([found(1, true, true), 'true', found(1, true, true), 'true']);
    await e2eLocator(page, { kind: 'css', selector: 'button', first: true }).click();
    await e2eLocator(page, { kind: 'css', selector: 'a', first: true }).click();
    expect(page.clicked).toEqual([`[${MARK_ATTRIBUTE}="m1"]`, `[${MARK_ATTRIBUTE}="m2"]`]);
  });

  test('the mark is removed after the click', async () => {
    resetLocatorMarks();
    const page = recorder([found(1, true, true), 'true']);
    await e2eLocator(page, { kind: 'css', selector: 'button', first: true }).click();
    expect(page.evaluated[1]).toContain('removeAttribute');
  });

  test('a click that THREW still removes its mark', async () => {
    resetLocatorMarks();
    const page = recorder([found(1, true, true), 'true']);
    const failing: LocatablePage = {
      ...page,
      click: () => Promise.reject(new RangeError('detached')),
    };
    const locator = e2eLocator(failing, { kind: 'css', selector: 'button', first: true });
    await expect(locator.click()).rejects.toThrow('detached');
    expect(page.evaluated[1]).toContain('removeAttribute');
  });

  test('a cleanup that fails never replaces the click’s own failure', async () => {
    resetLocatorMarks();
    let calls = 0;
    const page: LocatablePage = {
      url: () => 'https://app.test/feed',
      evaluate: () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve(found(1, true, true))
          : Promise.reject(new RangeError('the document went away'));
      },
      click: () => Promise.reject(new TypeError('the button went away')),
    };
    const locator = e2eLocator(page, { kind: 'css', selector: 'button', first: true });
    await expect(locator.click()).rejects.toThrow('the button went away');
  });
});
