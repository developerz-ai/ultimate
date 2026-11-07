// The brand the boot inlines. The default theme renders no CSS — no `<style>`, no CSP entry —
// and the preset is a whole palette; either way `defineTheme()` validated it at import.
import { expect, unitTest } from '@ultimat3/testing';
import { defineTheme } from '@ultimat3/ui';
import { brand } from './theme';

unitTest('the app ships the default theme until it opts into a preset', () => {
  expect(brand.css).toBe('');
  // The opt-in is one edit, and what it would ship is real CSS the boot inlines.
  expect(defineTheme({ preset: 'scifi' }).css).toContain('--color-');
});
