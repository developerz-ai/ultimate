import { describe, expect, test } from 'bun:test';
import * as ui from '@ultimat3/ui';
import { acceptedProposal, loadThemeHost, themeHostOf } from './cmd-design-theme';

describe('loadThemeHost', () => {
  test('the installed @ultimat3/ui is a host: its tables and its defineTheme', async () => {
    const host = await loadThemeHost();
    expect(host?.tables.colors.light['bg']).toBe(ui.colorTokens.light.bg);
    expect(host?.tables.pairs.length).toBe(
      ui.CONTRAST_PAIRS.length + ui.ALIAS_CONTRAST_PAIRS.length,
    );
  });

  test('a module that does not resolve, or does not look like ui, is no host', async () => {
    expect(
      await loadThemeHost(() => Promise.reject(new TypeError('not installed'))),
    ).toBeUndefined();
    expect(themeHostOf({ colorTokens: { light: {}, dark: 'x' } })).toBeUndefined();
  });
});

describe('acceptedProposal', () => {
  test("a proposal defineTheme refuses loses its colours, by defineTheme's own verdict", () => {
    const host = themeHostOf(ui);
    const refused = { colors: { light: { fg: '255 255 255' } }, radius: { md: '6px' } };
    expect(acceptedProposal(refused, host)).toEqual({
      proposal: { radius: { md: '6px' } },
      validated: true,
    });
    expect(acceptedProposal({ radius: { md: '6px' } }, host).proposal).toEqual({
      radius: { md: '6px' },
    });
    expect(acceptedProposal(refused, undefined).validated).toBe(false);
  });
});
