// The seeding expression, by value: offline drivers key recordings on the exact string, so it has
// to be deterministic — and it has to write the key the boot script READS, or a dark-default app
// keeps capturing dark with a seed nobody consults (issue #489).

import { describe, expect, test } from 'bun:test';
import { THEME_STORAGE_KEY, themeScriptBody } from '@ultimat3/render';
import { readThemeFlag, themeChoiceExpression } from './shot-theme';

describe('unit · themeChoiceExpression', () => {
  test('stores the scheme under the key the boot reads, deterministically', () => {
    const light = themeChoiceExpression('light');
    expect(light).toBe('try{localStorage.setItem("ultimate.theme","light")}catch(e){}');
    expect(themeChoiceExpression('light')).toBe(light);
    expect(themeChoiceExpression('dark')).toBe(
      'try{localStorage.setItem("ultimate.theme","dark")}catch(e){}',
    );
    // The same literal the boot's `getItem` names — derived, never restated, so the two cannot
    // drift the way the toggle's and the boot's keys once did.
    expect(light).toContain(`setItem(${JSON.stringify(THEME_STORAGE_KEY)}`);
    expect(themeScriptBody()).toContain(`getItem(${JSON.stringify(THEME_STORAGE_KEY)})`);
  });

  // The boot honours only `"light"` and `"dark"` from storage, so there is no choice to store
  // for the third scheme — and a stored `"no-preference"` would be a value the tokens have no
  // block for, falling through to the app's default exactly as if nothing were stored.
  test("'no-preference' seeds nothing", () => {
    expect(themeChoiceExpression('no-preference')).toBeUndefined();
  });
});

describe('unit · x shot --theme', () => {
  test('light and dark pass through; absent stays absent', () => {
    expect([readThemeFlag('light'), readThemeFlag('dark'), readThemeFlag(undefined)]).toEqual([
      'light',
      'dark',
      undefined,
    ]);
  });

  test('anything else is X_CLI_BAD_FLAG naming --theme, before anything boots', () => {
    let thrown: { code?: string; cause?: string } = {};
    try {
      readThemeFlag('no-preference');
    } catch (caught) {
      thrown = caught as { code?: string; cause?: string };
    }
    expect(thrown.code).toBe('X_CLI_BAD_FLAG');
    expect(thrown.cause).toContain('--theme');
  });
});
