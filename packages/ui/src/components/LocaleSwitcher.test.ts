// The locale picker has two shapes and one rule: the option labels are endonyms, so the list needs
// no catalog of its own, and the "you are here" marker belongs to exactly one entry. The links
// shape is the 0kb-JS path a `site/` route uses, and it must carry `hreflang` as well as `lang`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Locale } from '@ultimat3/i18n';
import { UI_KEYS } from '../i18n-keys';
import { byTag, fire, one, probe, renderNodes, unprobe, withAttr } from '../jsx-probe';
import { LocaleSwitcher, localeLabel } from './LocaleSwitcher';

describe('LocaleSwitcher', () => {
  beforeAll(probe);
  afterAll(unprobe);

  test('option labels are endonyms — each language named in its own language', () => {
    expect(localeLabel('de' as Locale)).toBe('Deutsch');
    expect(localeLabel('fr' as Locale)).toBe('français');
    // An unknown tag falls back to the tag itself rather than to an empty option.
    expect(localeLabel('zz' as Locale)).toBe('zz');
  });

  test('as a select, it names itself from the catalog and preselects the context locale', () => {
    const nodes = renderNodes(LocaleSwitcher, { locales: ['en', 'de'] });
    expect(one(byTag(nodes, 'select'), 'select').props['aria-label']).toBe(`⟦${UI_KEYS.language}⟧`);
    expect(byTag(nodes, 'option').map((node) => node.props['children'])).toEqual([
      'English',
      'Deutsch',
    ]);
    expect(withAttr(byTag(nodes, 'option'), 'selected', true).map((n) => n.props['value'])).toEqual(
      ['en'],
    );
  });

  test('the chosen locale is reported to the caller', () => {
    const seen: string[] = [];
    const nodes = renderNodes(LocaleSwitcher, {
      locales: ['en', 'de'],
      onLocaleChange: (locale: string) => void seen.push(locale),
    });
    fire(one(byTag(nodes, 'select'), 'select'), 'onChange', { currentTarget: { value: 'de' } });
    expect(seen).toEqual(['de']);
  });

  test('hrefFor renders a real nav of links — the 0kb-JS path', () => {
    const nodes = renderNodes(LocaleSwitcher, {
      locales: ['en', 'de'],
      value: 'de',
      hrefFor: (tag: string) => `/${tag}/pricing`,
    });

    expect(byTag(nodes, 'select')).toEqual([]);
    const nav = one(byTag(nodes, 'nav'), 'nav');
    expect(nav.props['aria-label']).toBe(`⟦${UI_KEYS.language}⟧`);

    const links = byTag(nodes, 'a');
    expect(links.map((node) => node.props['href'])).toEqual(['/en/pricing', '/de/pricing']);
    // `hreflang` AND `lang`: the link points at another language and is itself written in it.
    expect(links.map((node) => node.props['hreflang'])).toEqual(['en', 'de']);
    expect(links.map((node) => node.props['lang'])).toEqual(['en', 'de']);
    expect(links.map((node) => node.props['aria-current'])).toEqual([undefined, 'true']);
    expect(links.map((node) => node.props['children'])).toEqual(['English', 'Deutsch']);
  });
});
