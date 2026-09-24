// What a failed island build's cause is made of: `describeBuildError` over every value `Bun.build`
// or an import can throw — no bundle, no disk. Split from `island-bundle.test.ts` at its ceiling.

import { describe, expect, test } from 'bun:test';
import { describeBuildError } from './island-bundle';

describe('unit · the bundler diagnostic a cause is built from', () => {
  test('an ordinary Error keeps its message', () => {
    expect(describeBuildError(new TypeError('Could not resolve: "solid-js"'))).toContain(
      'Could not resolve: "solid-js"',
    );
  });

  test('an aggregate is flattened, which is what puts a line number in the cause', () => {
    const rendered = describeBuildError(
      new AggregateError([new Error('a.tsx:3 unresolved'), new Error('b.tsx:9 syntax')], 'nope'),
    );
    expect(rendered).toContain('a.tsx:3 unresolved');
    expect(rendered).toContain('b.tsx:9 syntax');
    expect(rendered).toContain(';');
  });

  test('a message getter that throws is rendered, never re-thrown', () => {
    const hostile = new Error('unused');
    Object.defineProperty(hostile, 'message', {
      get() {
        throw new TypeError('message is a trap');
      },
    });
    expect(() => describeBuildError(hostile)).not.toThrow();
    expect(describeBuildError(hostile)).not.toContain('message is a trap');
  });

  test('a Symbol is rendered, where String() throws outright', () => {
    expect(() => describeBuildError(Symbol('boom'))).not.toThrow();
    expect(describeBuildError(Symbol('boom')).length).toBeGreaterThan(0);
  });

  test('a Proxy that traps getPrototypeOf and get is rendered too', () => {
    const trap = new Proxy(
      { errors: [] },
      {
        getPrototypeOf() {
          throw new TypeError('no prototype for you');
        },
        get() {
          throw new TypeError('no properties for you');
        },
      },
    );
    expect(() => describeBuildError(trap)).not.toThrow();
  });

  test('a non-Error throw is not flattened to a placeholder', () => {
    expect(describeBuildError('bundle failed')).toContain('bundle failed');
  });
});
