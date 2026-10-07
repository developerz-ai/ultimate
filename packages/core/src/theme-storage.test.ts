// Pins the theme storage key's literal: it is persisted in every visitor's browser, so a new
// spelling would silently drop each stored light/dark choice on the next deploy.
import { describe, expect, test } from 'bun:test';
import * as barrel from './index';
import * as page from './page';
import { THEME_STORAGE_KEY } from './theme-storage';

describe('THEME_STORAGE_KEY', () => {
  test('is the key every shipped boot script and toggle has read and written', () => {
    expect(THEME_STORAGE_KEY).toBe('ultimate.theme');
  });

  test('reaches browser code through the light page entry and the barrel alike', () => {
    expect(page.THEME_STORAGE_KEY).toBe(THEME_STORAGE_KEY);
    expect(barrel.THEME_STORAGE_KEY).toBe(THEME_STORAGE_KEY);
  });
});
