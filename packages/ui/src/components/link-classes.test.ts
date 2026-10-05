// Which stylesheet a `<Link>` draws from is the whole of `appearance`: a text link reads its own
// sheet, a button-link reads Button's. Decided here, in a pure function, because under `bun test`
// a `.module.scss` import is a file path and no render can show which class an element got.

import { describe, expect, test } from 'bun:test';
import { compileScssFile, declaredClasses } from '../sass-probe-fixture';
import { buttonClassKeys } from './button-classes';
import { linkClasses } from './link-classes';

const sheet = (name: string): string => new URL(`./${name}.module.scss`, import.meta.url).pathname;

describe('linkClasses', () => {
  test('a link with no appearance is a text link: accent, underlined on hover', () => {
    expect(linkClasses({})).toEqual({
      sheet: 'link',
      keys: ['link', 'underline-hover', 'tone-accent'],
    });
    expect(linkClasses({ appearance: 'link', underline: 'always', tone: 'inherit' })).toEqual({
      sheet: 'link',
      keys: ['link', 'underline-always', 'tone-inherit'],
    });
  });

  test('appearance="button" is exactly the classes a <Button> of that look carries', () => {
    const look = { variant: 'secondary', tone: 'danger', size: 'sm', fullWidth: true } as const;
    expect(linkClasses({ appearance: 'button', ...look })).toEqual({
      sheet: 'button',
      keys: buttonClassKeys(look),
    });
  });

  test('a button-link never carries a text-link class, whatever else it was handed', () => {
    const { keys } = linkClasses({ appearance: 'button', underline: 'always' });
    expect(keys).toEqual(buttonClassKeys({}));
    expect(keys.some((key) => key.startsWith('underline-') || key === 'link')).toBe(false);
  });

  test('every text-link key is a class Link.module.scss declares', async () => {
    const declared = declaredClasses(await compileScssFile(sheet('Link')));
    const used = (['always', 'hover', 'none'] as const).flatMap((underline) =>
      (['accent', 'inherit'] as const).flatMap((tone) => linkClasses({ underline, tone }).keys),
    );
    expect(used.filter((key) => !declared.has(key))).toEqual([]);
  });
});
