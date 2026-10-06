// The sticky first column and the explicit table role. Both are attributes on the <table> — state
// the stylesheet selects on — so the wiring is read off the node tree and the rule off what Sass
// emits: a pinned cell with a transparent background shows the scrolled cells through it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { byTag, one, probe, renderNodes, unprobe } from '../jsx-probe';
import { compileScssFile } from '../sass-probe-fixture';
import { Table } from './Table';

const SHEET = Bun.fileURLToPath(new URL('./Table.module.scss', import.meta.url));

describe('Table', () => {
  beforeAll(probe);
  afterAll(unprobe);

  const table = (extra: Record<string, unknown> = {}) =>
    one(byTag(renderNodes(Table, { caption: 'Rows', children: null, ...extra }), 'table'), 'table');

  test('stickyFirstColumn marks the table, and is off unless asked for', () => {
    expect(table().props['data-sticky-first']).toBeUndefined();
    expect(table({ stickyFirstColumn: false }).props['data-sticky-first']).toBeUndefined();
    expect(table({ stickyFirstColumn: true }).props['data-sticky-first']).toBe('');
  });

  test('the table role is declared only for a caller that restyles the display', () => {
    expect(table().props['role']).toBeUndefined();
    expect(table({ explicitRoles: true }).props['role']).toBe('table');
  });

  test('a pinned first cell is sticky at the inline start, over an opaque surface', async () => {
    const css = await compileScssFile(SHEET);
    const rule =
      /\.table\[data-sticky-first\] :global\(:is\(th, td\):first-child\)\s*\{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    const body = rule?.[1] ?? '';
    expect(body).toContain('position: sticky');
    // Logical, so an RTL table pins its first column on the right.
    expect(body).toContain('inset-inline-start: 0');
    expect(body).toMatch(/background-color: rgb\(var\(--color-surface\)\/1\)/);
  });

  test('the corner cell sits above both the header row and the pinned column', async () => {
    const css = await compileScssFile(SHEET);
    expect(css).toMatch(
      /\.sticky\[data-sticky-first\] :global\(thead th:first-child\)\s*\{\s*z-index: var\(--z-sticky\)/,
    );
    expect(css).toMatch(
      /\.sticky\[data-sticky-first\] :global\(thead th:not\(:first-child\)\)\s*\{\s*z-index: var\(--z-raised\)/,
    );
  });
});
