// One set of button styles, two elements: `<Button>` and `<Link appearance="button">` ask this
// one function for their classes. Compiled, because the tone classes come out of a mixin — the
// source of `Button.module.scss` never spells `.tone-danger`, so only Sass's output can say
// whether a key this function returns is a class the sheet declares.

import { describe, expect, test } from 'bun:test';
import { compileScssFile, declaredClasses } from '../sass-probe';
import { BUTTON_CONTENT_KEYS, buttonClassKeys } from './button-classes';
import { BUTTON_VARIANTS, SIZES, TONES } from './variants';

const SHEET = new URL('./Button.module.scss', import.meta.url).pathname;

describe('buttonClassKeys', () => {
  test('defaults to the primary, accent, medium button', () => {
    expect(buttonClassKeys({})).toEqual(['button', 'variant-primary', 'tone-accent', 'size-md']);
  });

  test('names the look it was asked for, and `full` only when asked', () => {
    expect(
      buttonClassKeys({ variant: 'secondary', tone: 'neutral', size: 'sm', fullWidth: true }),
    ).toEqual(['button', 'variant-secondary', 'tone-neutral', 'size-sm', 'full']);
    expect(buttonClassKeys({ fullWidth: false })).not.toContain('full');
  });

  test('every key it can return is a class Button.module.scss declares', async () => {
    const declared = declaredClasses(await compileScssFile(SHEET));
    const missing = new Set<string>();
    for (const variant of BUTTON_VARIANTS) {
      for (const tone of TONES) {
        for (const size of SIZES) {
          for (const key of buttonClassKeys({ variant, tone, size, fullWidth: true })) {
            if (!declared.has(key)) missing.add(key);
          }
        }
      }
    }
    for (const key of BUTTON_CONTENT_KEYS) if (!declared.has(key)) missing.add(key);
    expect([...missing]).toEqual([]);
  });
});
