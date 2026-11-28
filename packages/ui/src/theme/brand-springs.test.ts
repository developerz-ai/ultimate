// A spring rung is an easing rung (`--easing-<name>`), so `defineTheme({ motion: { easing } })`
// re-tunes one exactly as it re-tunes `out`: a cubic-bezier, or a `linear()` curve such as
// `springLinear()` answers — matched by grammar, because the value lands in a <style> element.

import { describe, expect, test } from 'bun:test';
import { UiError } from '../errors';
import { springLinear } from '../motion/spring-linear';
import { defineTheme } from './brand';

const codeOf = (run: () => unknown): string | undefined => {
  try {
    run();
  } catch (error) {
    return error instanceof UiError ? error.code : 'not a UiError';
  }
  return undefined;
};

describe('defineTheme — spring rungs', () => {
  test('a spring rung takes the curve springLinear() answers, emitted after the scale', () => {
    const { easing } = springLinear({ stiffness: 400, damping: 28, mass: 1 });
    const css = defineTheme({
      motion: { easing: { snappy: easing, out: 'cubic-bezier(0.2, 0, 0, 1)' } },
    }).css;
    expect(css).toBe(
      `:root {\n  --easing-out: cubic-bezier(0.2, 0, 0, 1);\n  --easing-snappy: ${easing};\n}`,
    );
  });

  test('a spring rung also takes a cubic-bezier', () => {
    expect(
      defineTheme({ motion: { easing: { gentle: 'cubic-bezier(0.3, 1.2, 0.6, 1)' } } }).css,
    ).toContain('--easing-gentle: cubic-bezier(0.3, 1.2, 0.6, 1);');
  });

  test('linear() stops with percentages are a curve too', () => {
    expect(
      defineTheme({ motion: { easing: { bouncy: 'linear(0, 1.2 40%, 0.9 70%, 1)' } } }).css,
    ).toContain('--easing-bouncy: linear(0, 1.2 40%, 0.9 70%, 1);');
  });

  test('anything else is X_UI_INVALID_VALUE: a keyword, an injection, a linear() on a non-spring rung', () => {
    for (const run of [
      () => defineTheme({ motion: { easing: { snappy: 'ease' } } }),
      () =>
        defineTheme({ motion: { easing: { snappy: 'linear(0, 1); } html { display: none }' } } }),
      () => defineTheme({ motion: { easing: { snappy: 'linear()' } } }),
      () => defineTheme({ motion: { easing: { snappy: 'linear(0, var(--x))' } } }),
      () => defineTheme({ motion: { easing: { out: 'linear(0, 1)' } } }),
    ]) {
      expect(codeOf(run)).toBe('X_UI_INVALID_VALUE');
    }
  });
});
