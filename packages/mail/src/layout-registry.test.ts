// The layout registry: `registerLayout` is the documented escape hatch `X_MAIL_LAYOUT_UNKNOWN`'s
// fix line names ("registerLayout('<name>', myLayout) at boot"), and nothing exercised it — so the
// one path an app has to a layout of its own was unproven while the error told people to take it.
//
// Additive only. The map has no delete, so this file registers under a name nothing else uses and
// never touches `base`.

import { describe, expect, test } from 'bun:test';
import { loadCatalog, registerCatalog } from '@ultimat3/i18n';
import { blocks } from './blocks';
import {
  BASE_LAYOUT,
  type LayoutInput,
  layoutFor,
  registeredLayouts,
  registerLayout,
} from './layout';
import { type RenderableMail, renderMail } from './render';

registerCatalog(
  'en',
  loadCatalog({ test: { layout: { subject: 'Receipt for {name}', body: 'One line.' } } }),
);
registerCatalog(
  'ar',
  loadCatalog({ test: { layout: { subject: 'AR receipt for {name}', body: 'AR one line.' } } }),
);

const CUSTOM = 'test-custom-layout';
const seen: LayoutInput[] = [];

registerLayout(CUSTOM, (input) => {
  seen.push(input);
  return `<custom dir="${input.direction}">${input.content}</custom>`;
});

const mailWith = (layout: string): RenderableMail<{ name: string }> => ({
  id: 'test-layout',
  subject: 'test.layout.subject',
  layout,
  template: () => [blocks.paragraph('test.layout.body')],
});

describe('registerLayout', () => {
  test('a registered layout is the one the renderer calls, and the base one is untouched', () => {
    expect(layoutFor(CUSTOM)).toBeInstanceOf(Function);
    const rendered = renderMail(mailWith(CUSTOM), { name: 'Ada' }, { locale: 'en', tz: 'UTC' });
    // The custom shell wraps the body, and the 600px base table is nowhere in it.
    expect(rendered.html).toStartWith('<custom ');
    expect(rendered.html).toContain('One line.');
    expect(rendered.html).not.toContain('600');
    // The base layout still renders the same mail its own way.
    const base = renderMail(mailWith(BASE_LAYOUT), { name: 'Ada' }, { locale: 'en', tz: 'UTC' });
    expect(base.html).toContain('<!doctype html>');
    expect(base.html).not.toContain('<custom');
  });

  test('the layout receives the subject, the preheader, the content and the direction', () => {
    seen.length = 0;
    renderMail(mailWith(CUSTOM), { name: 'Ada' }, { locale: 'ar', tz: 'UTC' });
    expect(seen).toHaveLength(1);
    const input = seen[0] as LayoutInput;
    // The locale drives BOTH halves: the catalog it translates through and the direction the
    // shell is written in.
    expect(input.subject).toBe('AR receipt for Ada');
    // No `mail.test-layout.preheader` key is registered, so the preheader falls back to the
    // subject rather than rendering ⟦…⟧ into an inbox preview.
    expect(input.preheader).toBe(input.subject);
    expect(input.content).toContain('AR one line.');
    // Direction comes from the locale, and a layout that ignored it would ship an LTR shell to
    // an Arabic reader.
    expect(input.direction).toBe('rtl');
    expect(input.locale).toBe('ar');
    expect(input.unsubscribe).toBeUndefined();
  });

  test('an unsubscribe url reaches the layout as a slot, not as raw html', () => {
    seen.length = 0;
    renderMail(
      mailWith(CUSTOM),
      { name: 'Ada' },
      { locale: 'en', tz: 'UTC', unsubscribeUrl: 'https://example.test/u?t=1' },
    );
    expect(seen[0]?.unsubscribe).toEqual({
      label: expect.any(String),
      url: 'https://example.test/u?t=1',
    });
    // The slot is the layout's to render — the content it was handed does not contain the link.
    expect(seen[0]?.content).not.toContain('https://example.test/u?t=1');
  });

  test('registeredLayouts lists it beside base, sorted, and names it in the unknown-layout fix', () => {
    const names = registeredLayouts();
    expect(names).toContain(CUSTOM);
    expect(names).toContain(BASE_LAYOUT);
    expect(names).toEqual([...names].sort());

    let cause = 'no-throw';
    try {
      renderMail(mailWith('never-registered'), { name: 'Ada' }, { locale: 'en', tz: 'UTC' });
    } catch (error) {
      cause = String((error as { cause?: unknown }).cause);
    }
    // The list in the error is `registeredLayouts()`, so a layout an app registered shows up as
    // an option rather than the reader being told only `base` exists.
    expect(cause).toContain(CUSTOM);
    expect(cause).toContain(BASE_LAYOUT);
  });

  // "registering the same name again replaces it — last writer wins" USED to be pinned here, and
  // pinning it is what kept it: a second `registerLayout('base', …)` from any dependency silently
  // re-shelled every framework mail. The rule is now the opposite and lives in
  // `a layout name is taken once` at the bottom of this file.
  test('one registration, one entry — a name never appears twice in the list', () => {
    const name = 'test-single-entry-layout';
    registerLayout(name, () => '<first/>');
    expect(renderMail(mailWith(name), { name: 'Ada' }, { locale: 'en', tz: 'UTC' }).html).toBe(
      '<first/>',
    );
    expect(registeredLayouts().filter((entry) => entry === name)).toHaveLength(1);
  });
});

/**
 * `layouts.set(name, layout)` — a second registration silently replaced the first, `base` included,
 * so an app importing a package that registers `base` had every framework mail re-shelled with no
 * error anywhere. `defineMail` refuses a duplicate id one file over (`X_MAIL_DUPLICATE`), and
 * `@ultimat3/mcp`'s `ResourceRegistry.register` states the general rule: one package cannot answer
 * "this name is taken" two ways.
 */
describe('a layout name is taken once', () => {
  const TAKEN = 'test-taken-layout';
  const layout = (marker: string) => (): string => `<${marker}/>`;

  test('the first registration wins and the second is refused', () => {
    registerLayout(TAKEN, layout('first'));
    expect(() => {
      registerLayout(TAKEN, layout('second'));
    }).toThrow(expect.objectContaining({ code: 'X_MAIL_DUPLICATE' }));
    // Unchanged, not replaced: a refusal that had already mutated the map would be worse than
    // the overwrite it refused.
    expect(layoutFor(TAKEN)?.({} as LayoutInput)).toBe('<first/>');
  });

  test("the framework's own base layout cannot be replaced", () => {
    expect(() => {
      registerLayout(BASE_LAYOUT, layout('hijacked'));
    }).toThrow(expect.objectContaining({ code: 'X_MAIL_DUPLICATE' }));
    expect(registeredLayouts()).toContain(BASE_LAYOUT);
  });
});
