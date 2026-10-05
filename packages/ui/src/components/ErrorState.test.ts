// `errorParts` is the renderer-free half of `<ErrorState>` — the only part of the component a test
// can reach without a Solid runtime, and the only part that touches a value the app controls.

// Bare, as `index.ts` imports it: the server's `useUi()` reader — the request locale and the
// catalog behind every string asserted below — is registered by the barrel, and this file reaches
// components by their module paths (issue #490).
import '../theme/ambient';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { FRAMEWORK_CATALOG } from '@ultimat3/i18n';
import { UI_KEYS } from '../i18n-keys';
import { byTag, probe, renderNodes, unprobe } from '../jsx-probe';
import { ErrorState, errorParts } from './ErrorState';

/**
 * What this component must render for a ui key, looked up BY THE KEY in the catalog it ships in.
 *
 * These assertions read `⟦ui.x⟧` until 5.1.0, because `registerFrameworkCatalog()` had one caller
 * and a unit test was never it — so every framework string was a loud miss here and the marker was
 * the only observable. It is registered by importing `@ultimat3/i18n` now, so the marker is gone;
 * the KEY is still what is asserted, which is what these tests are about.
 */
const uiString = (key: string): string => FRAMEWORK_CATALOG[key] ?? `no catalog entry for ${key}`;

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
 * A getter, or a `Proxy` trap, on the error itself. `errorParts` read `error.code`/`.cause`/`.fix`
 * and `error.message` as plain properties, so a value that throws while being READ blanked the
 * screen that was reporting it — the same hole as a hostile `toString`, one property earlier.
 */
describe('an error whose fields throw when read', () => {
  const trap = (target: object, field: string): object =>
    new Proxy(target, {
      get(held, key, receiver) {
        if (key === field) throw new TypeError(`${field} getter`);
        return Reflect.get(held, key, receiver);
      },
    });
  const coded = (): UltimateError =>
    new UltimateError({ code: 'X_ID_INVALID', cause: 'not a uuid', fix: 'parseId()' });

  test('an Error with a throwing message getter still renders X_INTERNAL', () => {
    class Unreadable extends Error {
      override get message(): string {
        throw new TypeError('message getter');
      }
    }
    let parts: ReturnType<typeof errorParts> | undefined;
    expect(() => {
      parts = errorParts(new Unreadable());
    }).not.toThrow();
    expect(parts?.code).toBe('X_INTERNAL');
    expect(parts?.cause.length).toBeGreaterThan(0);
  });

  test('a coded error whose cause will not read keeps its code, title and fix', () => {
    const error = coded();
    const parts = errorParts(trap(error, 'cause'));
    expect(parts.code).toBe('X_ID_INVALID');
    expect(parts.title).toBe(error.title);
    expect(parts.fix).toBe('parseId()');
    expect(parts.cause.length).toBeGreaterThan(0);
  });

  test('a coded error whose fix will not read gets the explain command as its fix', () => {
    expect(errorParts(trap(coded(), 'fix')).fix).toBe('x errors explain X_ID_INVALID');
  });

  test('a hostile code never reaches the explain command verbatim', () => {
    // `isUltimateError` is a brand check, so a Proxy over a real error can answer any `code` — and
    // the fallback fix is pasted into a shell. `;` would end `x errors explain` and run the rest.
    const hostile = new Proxy(coded(), {
      get(held, key, receiver) {
        if (key === 'code') return 'X_A; rm -rf ~';
        if (key === 'fix') throw new TypeError('fix getter');
        return Reflect.get(held, key, receiver);
      },
    });
    const fix = errorParts(hostile).fix;
    expect(fix).not.toContain('rm -rf');
    expect(fix).toBe("x errors explain '<the code above>'");
  });

  test('a coded error whose code will not read is X_INTERNAL, never a throw', () => {
    let parts: ReturnType<typeof errorParts> | undefined;
    expect(() => {
      parts = errorParts(trap(coded(), 'code'));
    }).not.toThrow();
    expect(parts?.code).toBe('X_INTERNAL');
  });

  test('a remote title off the wire still reaches the screen', () => {
    // Sweep 3's `remoteTitle`: a code this realm never registered renders the server's title, and
    // reading fields defensively must not drop it back to the humanised fallback.
    const remote = new UltimateError({
      code: 'X_SOME_SERVER_ONLY_CODE',
      cause: 'refused upstream',
      fix: 'retry later',
      remoteTitle: 'the server titled this',
    });
    expect(errorParts(remote).title).toBe('the server titled this');
  });
});

/**
 * The other half — which strings the component RENDERS, as opposed to which ones `errorParts`
 * computes. The translator outside a request is the loud-miss one, so a resolved key comes out as
 * uiString('ui.error.title'): that is the assertion. A key rendered as its own English text would mean the
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
    expect(text(byTag(nodes, 'span'))).toContain(uiString(UI_KEYS.error));
  });

  test('the code is labelled, like the cause and the fix beside it', () => {
    const nodes = renderNodes(ErrorState, {
      error: new UltimateError({ code: 'X_ID_INVALID', cause: 'not a uuid', fix: 'parseId()' }),
      showDocs: false,
    });
    const labels = text(byTag(nodes, 'dt'));
    for (const key of [UI_KEYS.errorCode, UI_KEYS.errorCause, UI_KEYS.errorFix]) {
      expect(labels).toContain(uiString(key));
    }
  });
});
