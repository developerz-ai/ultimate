// `getByRole` and `getByText` are not CSS, so this RUNS the expression the driver builds against a
// document it can hold in one screen. Asserting on the generated string instead would prove the
// driver writes text, never that the text finds the right element.

import { describe, expect, test } from 'bun:test';
import type { FakeE2eElement } from './e2e-dom-fixture';
import { fakeE2eDocument, runInFakePage } from './e2e-dom-fixture';
import type { E2eResolution, E2eSelection } from './e2e-selection';
import {
  MARK_ATTRIBUTE,
  markSelector,
  selectionCall,
  selectionExpression,
  unmarkExpression,
} from './e2e-selection';

const resolve = async (
  root: FakeE2eElement,
  selection: E2eSelection,
  mark?: string,
): Promise<E2eResolution> => {
  const raw = await runInFakePage(selectionExpression(selection, mark), fakeE2eDocument(root));
  return JSON.parse(String(raw)) as E2eResolution;
};

const page: FakeE2eElement = {
  tag: 'html',
  attrs: {},
  children: [
    {
      tag: 'header',
      attrs: {},
      children: [{ tag: 'h1', attrs: {}, text: 'Acme Editorial' }],
    },
    { tag: 'script', attrs: { src: '/x/app.js' } },
    {
      tag: 'ul',
      attrs: {},
      children: [
        {
          tag: 'li',
          attrs: {},
          children: [
            { tag: 'p', attrs: {}, text: 'Tenancy is a column, not a convention' },
            { tag: 'button', attrs: {}, text: 'Like' },
            { tag: 'span', attrs: {}, text: '3 likes' },
          ],
        },
        {
          tag: 'li',
          attrs: {},
          children: [
            { tag: 'p', attrs: {}, text: 'Money is minor units' },
            { tag: 'button', attrs: {}, text: 'Like' },
          ],
        },
      ],
    },
    { tag: 'div', attrs: { role: 'button' }, text: 'Publish' },
    { tag: 'button', attrs: { role: 'link' }, text: 'Away' },
    { tag: 'h2', attrs: {}, text: 'Hidden section', style: { display: 'none' } },
    { tag: 'h3', attrs: { 'aria-level': '2' }, text: 'Lifted' },
    { tag: 'img', attrs: { alt: 'Avatar' } },
  ],
};

describe('e2e selection — nothing matches', () => {
  test('an unknown css selector resolves to zero, never to a throw', async () => {
    expect(await resolve(page, { kind: 'css', selector: 'video', first: false })).toEqual({
      count: 0,
      visible: false,
      marked: false,
    });
  });

  test('a role nothing carries resolves to zero', async () => {
    expect((await resolve(page, { kind: 'role', role: 'slider', first: false })).count).toBe(0);
  });

  test('a name that does not match the accessible name resolves to zero', async () => {
    const found = await resolve(page, {
      kind: 'role',
      role: 'button',
      name: 'Unlike',
      first: false,
    });
    expect(found.count).toBe(0);
  });

  test('a mark is not written when nothing matched', async () => {
    expect(
      (await resolve(page, { kind: 'css', selector: 'video', first: false }, 'm1')).marked,
    ).toBe(false);
  });
});

describe('e2e selection — css', () => {
  test('counts every match, not just the first', async () => {
    expect((await resolve(page, { kind: 'css', selector: 'button', first: false })).count).toBe(3);
  });

  test('first() narrows the count to one', async () => {
    expect((await resolve(page, { kind: 'css', selector: 'button', first: true })).count).toBe(1);
  });

  test('an attribute selector reaches the scripts the budget test counts', async () => {
    expect(
      (await resolve(page, { kind: 'css', selector: 'script[src]', first: false })).count,
    ).toBe(1);
  });
});

describe('e2e selection — role', () => {
  test('an implicit role is found without the attribute', async () => {
    expect((await resolve(page, { kind: 'role', role: 'heading', first: false })).count).toBe(3);
  });

  test('an explicit role on a non-semantic element is found', async () => {
    const found = await resolve(page, {
      kind: 'role',
      role: 'button',
      name: 'Publish',
      first: false,
    });
    expect(found.count).toBe(1);
  });

  test('an element whose own role CONTRADICTS its tag is excluded', async () => {
    // `<button role="link">Away</button>` is a link. A union selector alone would count it.
    const found = await resolve(page, { kind: 'role', role: 'button', name: 'Away', first: false });
    expect(found.count).toBe(0);
  });

  test('level reads the heading tag', async () => {
    const found = await resolve(page, { kind: 'role', role: 'heading', level: 1, first: false });
    expect(found.count).toBe(1);
  });

  test('aria-level overrides the heading tag', async () => {
    // An `<h3 aria-level="2">` is a level-2 heading, and an `<h2>` is hidden — so level 2 is one.
    const found = await resolve(page, { kind: 'role', role: 'heading', level: 2, first: false });
    expect(found.count).toBe(2);
    expect(
      (await resolve(page, { kind: 'role', role: 'heading', level: 3, first: false })).count,
    ).toBe(0);
  });

  test("the accessible name comes off alt before it comes off the element's text", async () => {
    const found = await resolve(page, { kind: 'role', role: 'img', name: 'Avatar', first: false });
    expect(found.count).toBe(1);
  });

  test('the accessible name is matched case-insensitively on collapsed whitespace', async () => {
    const found = await resolve(page, {
      kind: 'role',
      role: 'button',
      name: '  like ',
      first: false,
    });
    expect(found.count).toBe(2);
  });

  test('aria-label wins over the text', async () => {
    const labelled: FakeE2eElement = {
      tag: 'html',
      attrs: {},
      children: [{ tag: 'button', attrs: { 'aria-label': 'Close dialog' }, text: 'x' }],
    };
    expect(
      (
        await resolve(labelled, {
          kind: 'role',
          role: 'button',
          name: 'Close dialog',
          first: false,
        })
      ).count,
    ).toBe(1);
    expect(
      (await resolve(labelled, { kind: 'role', role: 'button', name: 'x', first: false })).count,
    ).toBe(0);
  });

  test('aria-labelledby is resolved through the document', async () => {
    const labelled: FakeE2eElement = {
      tag: 'html',
      attrs: {},
      children: [
        { tag: 'span', attrs: { id: 'lbl' }, text: 'Send invite' },
        { tag: 'button', attrs: { 'aria-labelledby': 'lbl' }, text: 'go' },
      ],
    };
    expect(
      (await resolve(labelled, { kind: 'role', role: 'button', name: 'Send invite', first: false }))
        .count,
    ).toBe(1);
  });
});

describe('e2e selection — text', () => {
  test('matches the INNERMOST element that holds the string', async () => {
    // `<html>`, `<ul>`, `<li>` and `<p>` all contain it; only the `<p>` is the answer.
    expect(
      (await resolve(page, { kind: 'text', text: 'Tenancy is a column', first: false })).count,
    ).toBe(1);
  });

  test('matches on a substring, case-insensitively, on collapsed whitespace', async () => {
    expect((await resolve(page, { kind: 'text', text: '3 LIKES', first: false })).count).toBe(1);
  });

  test('never lands on a script, whose text is markup rather than copy', async () => {
    const scripted: FakeE2eElement = {
      tag: 'html',
      attrs: {},
      children: [{ tag: 'script', attrs: {}, text: 'const banner = "You are offline";' }],
    };
    expect(
      (await resolve(scripted, { kind: 'text', text: 'You are offline', first: false })).count,
    ).toBe(0);
  });
});

describe('e2e selection — visibility', () => {
  test('display:none is not visible', async () => {
    const found = await resolve(page, { kind: 'role', role: 'heading', level: 2, first: true });
    expect(found.visible).toBe(false);
  });

  test('an ordinary element is visible', async () => {
    expect(
      (await resolve(page, { kind: 'role', role: 'heading', level: 1, first: true })).visible,
    ).toBe(true);
  });

  test('visibility is about the FIRST match, so first() cannot change the answer', async () => {
    const all = await resolve(page, { kind: 'css', selector: 'button', first: false });
    const one = await resolve(page, { kind: 'css', selector: 'button', first: true });
    expect(all.visible).toBe(one.visible);
  });
});

describe('e2e selection — marking', () => {
  test('the mark lands on the first match and the mark selector finds it again', async () => {
    const document = fakeE2eDocument(page);
    const marked = JSON.parse(
      String(
        await runInFakePage(
          selectionExpression({ kind: 'role', role: 'button', name: 'Like', first: true }, 'm7'),
          document,
        ),
      ),
    ) as E2eResolution;
    expect(marked.marked).toBe(true);
    const found = JSON.parse(
      String(
        await runInFakePage(
          selectionExpression(
            { kind: 'css', selector: markSelector('m7'), first: false },
            undefined,
          ),
          document,
        ),
      ),
    ) as E2eResolution;
    expect(found.count).toBe(1);
  });

  test('unmark removes it again, so the next locator cannot click a stale target', async () => {
    const document = fakeE2eDocument(page);
    await runInFakePage(
      selectionExpression({ kind: 'css', selector: 'button', first: true }, 'm9'),
      document,
    );
    await runInFakePage(unmarkExpression('m9'), document);
    const found = JSON.parse(
      String(
        await runInFakePage(
          selectionExpression({ kind: 'css', selector: markSelector('m9'), first: false }),
          document,
        ),
      ),
    ) as E2eResolution;
    expect(found.count).toBe(0);
  });

  test('the mark selector quotes the token, so it is one attribute selector', () => {
    expect(markSelector('m1')).toBe(`[${MARK_ATTRIBUTE}="m1"]`);
  });
});

describe('e2e selection — the call a refusal quotes', () => {
  test('rebuilds the locator call the test wrote', () => {
    expect(selectionCall({ kind: 'css', selector: 'script[src]', first: false })).toBe(
      'page.locator("script[src]")',
    );
    expect(selectionCall({ kind: 'role', role: 'button', name: 'Like', first: true })).toBe(
      'page.getByRole("button", { name: "Like" }).first()',
    );
    expect(selectionCall({ kind: 'role', role: 'heading', level: 1, first: false })).toBe(
      'page.getByRole("heading", { level: 1 })',
    );
    expect(selectionCall({ kind: 'text', text: '3 likes', first: false })).toBe(
      'page.getByText("3 likes")',
    );
  });
});
