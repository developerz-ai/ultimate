// The demo opts into the sci-fi preset, and nothing else: an override layered on later is a
// decision this test makes someone state, because the deployed demo is what the preset is judged by.

import { expect, unitTest } from '@ultimat3/testing';
import { brandStyleTag, defineTheme } from '@ultimat3/ui';
import { brand } from './theme';

unitTest('the brand is the sci-fi preset, byte for byte', () => {
  expect(brandStyleTag(brand)).toBe(brandStyleTag(defineTheme({ preset: 'scifi' })));
});

unitTest('it restyles both themes, so the toggle flips between two sci-fi palettes', () => {
  expect(brand.css).toContain("html[data-theme='light']");
  expect(brand.css).toContain("html[data-theme='dark']");
  expect(brand.css).toContain('@media (prefers-color-scheme: dark)');
});
