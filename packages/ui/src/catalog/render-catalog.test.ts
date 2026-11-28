// The components-only page another package (`@ultimat3/effects`) renders with ui's builder: the
// same component sections ui's own page carries, under that package's title, and no ui tokens.

import { describe, expect, test } from 'bun:test';
import type { ComponentDoc } from './parse-component';
import { CATALOG_BANNER, renderCatalog, renderComponentsCatalog } from './render-catalog';

const DOCS: readonly ComponentDoc[] = [
  {
    name: 'Aurora',
    summary: 'A drifting gradient behind a hero.',
    props: [{ name: 'tone', type: "'accent' | 'info'", required: false, doc: 'The hue.' }],
  },
  { name: 'Noise', summary: 'Film grain.', props: [] },
];

describe('renderComponentsCatalog', () => {
  const page = renderComponentsCatalog('@ultimat3/effects', DOCS);

  test('titles the page and its import path with the package it was given', () => {
    expect(page).toContain('# @ultimat3/effects catalog\n');
    expect(page).toContain('Import all of it from `@ultimat3/effects`.');
    expect(page).toContain('2 components: `Aurora` · `Noise`');
  });

  test('carries a generated banner, and not ui’s, which names packages/ui/src', () => {
    expect(page.startsWith('<!-- GENERATED')).toBe(true);
    expect(page.startsWith(CATALOG_BANNER)).toBe(false);
  });

  test('each component section is byte-for-byte the one ui’s own page renders', () => {
    const ui = renderCatalog(DOCS);
    const section = (text: string): string =>
      text.slice(text.indexOf('### Aurora'), text.indexOf('### Noise') + '### Noise'.length);
    expect(section(page)).toBe(section(ui));
    expect(page).toContain("| `tone` | `'accent' \\| 'info'` | — | The hue. |");
    expect(page).toContain('_No props._');
  });

  test('renders no ui vocabulary or token table', () => {
    expect(page).not.toContain('## Vocabulary');
    expect(page).not.toContain('## Tokens');
    expect(page.endsWith('\n')).toBe(true);
  });
});
