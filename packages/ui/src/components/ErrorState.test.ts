// `errorParts` is the renderer-free half of `<ErrorState>` — the only part of the component a test
// can reach without a Solid runtime, and the only part that touches a value the app controls.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { UI_KEYS } from '../i18n-keys';
import { byTag, probe, renderNodes, unprobe } from '../jsx-probe';
import { ErrorState, errorParts } from './ErrorState';

describe('errorParts', () => {
  test('an UltimateError is passed through verbatim, never paraphrased', () => {
    const error = new UltimateError({
      code: 'X_ID_INVALID',
      cause: 'not a uuid',
      fix: 'parseId()',
    });
    expect(errorParts(error)).toEqual({
      code: 'X_ID_INVALID',
      title: error.title,
      cause: 'not a uuid',
      fix: 'parseId()',
      docs: error.docs,
    });
  });

  test('an ordinary Error keeps its message as the cause', () => {
    expect(errorParts(new TypeError('x is not a function')).cause).toBe('x is not a function');
  });

  // This component is what a screen renders INSTEAD of the thing that failed, so a throw while
  // building its text is a blank tree where the report was. `String(error)` runs the value's own
  // `toString`, and the value is whatever the app threw.
  describe('a thrown value it cannot control', () => {
    const hostile = (): ReadonlyMap<string, unknown> =>
      new Map<string, unknown>([
        [
          'a hostile toString',
          {
            toString: () => {
              throw new Error('gotcha');
            },
          },
        ],
        ['a null-prototype object', Object.create(null)],
        ['a symbol', Symbol('boom')],
      ]);

    for (const [label, value] of hostile()) {
      test(`still renders X_INTERNAL for ${label}`, () => {
        let parts: ReturnType<typeof errorParts> | undefined;
        expect(() => {
          parts = errorParts(value);
        }).not.toThrow();
        expect(parts?.code).toBe('X_INTERNAL');
        // No command: `x logs` is planned and exits X_NOT_IMPLEMENTED, and nothing shipped can
        // name a throw site the framework never saw typed. The fix is the throw-site edit.
        expect(parts?.fix).toContain('throw an UltimateError subclass');
        expect(parts?.fix).not.toContain('x logs');
        expect(parts?.cause.length).toBeGreaterThan(0);
      });
    }
  });
});

/**
 * The other half — which strings the component RENDERS, as opposed to which ones `errorParts`
 * computes. The translator outside a request is the loud-miss one, so a resolved key comes out as
 * `⟦ui.error.title⟧`: that is the assertion. A key rendered as its own English text would mean the
 * component wrote the string itself.
 */
describe('<ErrorState> resolves its own chrome through the catalog', () => {
  beforeAll(probe);
  afterAll(unprobe);

  const text = (nodes: readonly { props: Record<string, unknown> }[]): string =>
    JSON.stringify(nodes.map((node) => node.props['children']));

  test('the heading is the translated ui.error.title, not the error registry’s English', () => {
    const nodes = renderNodes(ErrorState, {
      error: new UltimateError({ code: 'X_ID_INVALID', cause: 'not a uuid', fix: 'parseId()' }),
      showDocs: false,
    });
    expect(text(byTag(nodes, 'span'))).toContain(UI_KEYS.error);
  });

  test('the code is labelled, like the cause and the fix beside it', () => {
    const nodes = renderNodes(ErrorState, {
      error: new UltimateError({ code: 'X_ID_INVALID', cause: 'not a uuid', fix: 'parseId()' }),
      showDocs: false,
    });
    const labels = text(byTag(nodes, 'dt'));
    for (const key of [UI_KEYS.errorCode, UI_KEYS.errorCause, UI_KEYS.errorFix]) {
      expect(labels).toContain(key);
    }
  });
});
