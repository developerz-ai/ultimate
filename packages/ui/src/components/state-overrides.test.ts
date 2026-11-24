// A state a PERSON reads: AsyncRegion's failed branch can be the app's own screen instead of the
// developer's `ErrorState` (code, cause, shell fix), and EmptyState / Alert can title themselves
// with a real heading a screen reader jumps to. Defaults unchanged.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { byTag, renderNodes } from '@ultimat3/core/render-nodes';
import { Alert } from './Alert';
import { AsyncRegion } from './AsyncRegion';
import { EmptyState } from './EmptyState';

const coded = (): UltimateError =>
  new UltimateError({ code: 'X_INTERNAL', cause: 'the cause', fix: 'x errors explain X_INTERNAL' });

/** A hand-built node no component renders: seen in the output only if `failed`'s JSX was kept. */
const APP_SCREEN = { inert: true, type: 'section', props: { 'data-screen': 'feed-unavailable' } };

describe('AsyncRegion · failed', () => {
  test('a failed render prop replaces ErrorState, handed the error and the exact retry', () => {
    const onRetry = (): undefined => undefined;
    const handed: { error?: unknown; retry?: unknown } = {};
    const nodes = renderNodes(AsyncRegion, {
      state: { status: 'failed', error: coded() },
      reserve: { lines: 1, height: '1rem' },
      ready: () => null,
      empty: () => null,
      onRetry,
      failed: (error: unknown, retry?: () => void) => {
        handed.error = error;
        handed.retry = retry;
        return APP_SCREEN;
      },
    });
    expect(handed.error instanceof UltimateError ? handed.error.code : 'not coded').toBe(
      'X_INTERNAL',
    );
    expect(handed.retry).toBe(onRetry);
    // The app's screen is what renders, once.
    expect(nodes.filter((node) => node.props['data-screen'] === 'feed-unavailable')).toHaveLength(
      1,
    );
    // No developer report: no alert role, no cause, no fix on the page.
    expect(nodes.some((node) => node.props['role'] === 'alert')).toBe(false);
    expect(JSON.stringify(nodes.map((node) => node.props))).not.toContain('the cause');
  });

  test('without one, ErrorState still renders the report', () => {
    const nodes = renderNodes(AsyncRegion, {
      state: { status: 'failed', error: coded() },
      reserve: { lines: 1, height: '1rem' },
      ready: () => null,
      empty: () => null,
    });
    expect(nodes.some((node) => node.props['role'] === 'alert')).toBe(true);
  });
});

describe('EmptyState and Alert · level', () => {
  /** Each title-bearing paragraph: its role, its level, and its whole content. */
  const titles = (nodes: ReturnType<typeof renderNodes>, title: string) =>
    byTag(nodes, 'p')
      .filter((node) => node.props['role'] === 'heading' || node.props['children'] === title)
      .map((node) => [
        node.props['role'] ?? 'paragraph',
        node.props['aria-level'],
        node.props['children'],
      ]);

  test('EmptyState titles itself with the heading asked for; a plain paragraph by default', () => {
    expect(titles(renderNodes(EmptyState, { title: 'None', level: 3 }), 'None')).toEqual([
      ['heading', 3, 'None'],
    ]);
    expect(titles(renderNodes(EmptyState, { title: 'None' }), 'None')).toEqual([
      ['paragraph', undefined, 'None'],
    ]);
  });

  test('Alert titles itself with the heading asked for; a paragraph by default', () => {
    const asked = renderNodes(Alert, { title: 'Saved', level: 2, children: 'ok' });
    expect(titles(asked, 'Saved')).toEqual([['heading', 2, 'Saved']]);
    expect(titles(renderNodes(Alert, { title: 'Saved', children: 'ok' }), 'Saved')).toEqual([
      ['paragraph', undefined, 'Saved'],
    ]);
  });
});
