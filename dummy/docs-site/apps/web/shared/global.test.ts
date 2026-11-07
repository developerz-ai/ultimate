// The global layer reaches this app's module graph through exactly one edge. Cut it and every
// `var(--…)` a component emits resolves to nothing: the app renders unstyled, with every test of
// every component still green.
import { registeredStylesheets } from '@ultimat3/render/server';
import { expect, unitTest } from '@ultimat3/testing';
import './global';

unitTest('importing shared/global registers the one global stylesheet', () => {
  const sheets = registeredStylesheets().filter((sheet) => sheet.global);
  // Split on either separator: `file` is a host path, `D:\…\global.scss` on Windows.
  expect(sheets.map((sheet) => sheet.file.split(/[\\/]/).slice(-3).join('/'))).toEqual([
    'web/shared/global.scss',
  ]);
  // The custom properties themselves, declared once on the root — what `tokens.role()` refers to.
  expect(sheets[0]?.css).toContain(':root{');
  expect(sheets[0]?.css).toContain('--color-bg:');
});
