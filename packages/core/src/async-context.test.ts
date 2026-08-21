import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asyncContext } from './async-context';

describe('asyncContext, on a server', () => {
  test('is undefined outside a scope and the value inside one', () => {
    const scope = asyncContext<string>('the thing');
    expect(scope.get()).toBeUndefined();
    expect(scope.run('inside', () => scope.get())).toBe('inside');
    expect(scope.get()).toBeUndefined();
  });

  test('propagates across an await, which is the whole reason for AsyncLocalStorage', async () => {
    const scope = asyncContext<number>('the thing');
    await scope.run(7, async () => {
      await Bun.sleep(1);
      expect(scope.get()).toBe(7);
    });
  });

  test('stays isolated across interleaved async tasks', async () => {
    const scope = asyncContext<string>('the thing');
    const task = async (value: string, delayMs: number): Promise<string> =>
      scope.run(value, async () => {
        await Bun.sleep(delayMs);
        return scope.get() ?? 'lost';
      });
    expect(await Promise.all([task('a', 20), task('b', 5), task('c', 10)])).toEqual([
      'a',
      'b',
      'c',
    ]);
  });

  test('nests, innermost wins, and the outer value survives the inner scope', () => {
    const scope = asyncContext<string>('the thing');
    scope.run('outer', () => {
      expect(scope.run('inner', () => scope.get())).toBe('inner');
      expect(scope.get()).toBe('outer');
    });
  });

  test('two scopes cannot see each other', () => {
    const left = asyncContext<string>('the left');
    const right = asyncContext<string>('the right');
    left.run('L', () => {
      expect(right.get()).toBeUndefined();
    });
  });
});

/**
 * The mechanical guard for this whole defect class, one level up from the seam: the BARREL is the
 * entry `@ultimat3/ui` reaches (`packages/ui/src/errors.ts` imports `@ultimat3/core`, not a file),
 * so a fourth module-scope `new AsyncLocalStorage()` added anywhere in the package turns this red
 * on the day it lands. The bundler's stub is the subject and cannot be faked by a test.
 */
describe('a browser bundle of @ultimat3/core', () => {
  interface BrowserBarrel {
    readonly hasContext: () => boolean;
    readonly currentSpan: () => unknown;
    readonly isImpersonating: () => boolean;
    readonly createContext: () => unknown;
    readonly anonymousActor: () => unknown;
    readonly runWithContext: (ctx: unknown, fn: () => unknown) => unknown;
    readonly withSpan: (name: string, fn: () => unknown) => unknown;
    readonly impersonate: (actor: unknown, reason: string, fn: () => unknown) => unknown;
  }

  let built: Promise<BrowserBarrel> | undefined;

  function barrel(): Promise<BrowserBarrel> {
    built ??= (async (): Promise<BrowserBarrel> => {
      // Bundled through a re-exporting wrapper, the way an app consumes the barrel — NOT with
      // `index.ts` as the entry point. Bun 1.4.0 shakes the bindings out of a pure re-export entry
      // that a `sideEffects` field does not name, while still emitting the `export { … }` clause,
      // so the direct build answers `"recordRequest" is not declared in this file` (#276). The
      // chunk it produced had no declarations at all, which made every assertion below vacuous.
      const dir = await mkdtemp(join(tmpdir(), 'ultimate-core-'));
      const entry = join(dir, 'entry.ts');
      await Bun.write(
        entry,
        `export * from ${JSON.stringify(join(import.meta.dir, 'index.ts'))};\n`,
      );
      const output = await Bun.build({ entrypoints: [entry], target: 'browser' });
      expect(output.success).toBe(true);
      const chunk = output.outputs[0] ?? expect.unreachable('the browser build emitted no chunk');
      // A fresh path per run: the module cache would otherwise serve a chunk built before a fix.
      const file = join(dir, 'barrel.mjs');
      const code = await chunk.text();
      // Non-vacuity: a chunk that is only an `export { … }` clause passes every assertion below
      // while proving nothing. This is what #276 produced, undetected, until the barrel test grew
      // the same check.
      expect(code.replace(/export\s*\{[^}]*\};?/g, '').trim()).not.toBe('');
      await Bun.write(file, code);
      return import(file) as Promise<BrowserBarrel>;
    })();
    return built;
  }

  test('evaluates instead of throwing at module scope', async () => {
    const core = await barrel();
    expect(typeof core.hasContext).toBe('function');
  }, 60_000);

  test('answers every ambient read with a definite no, not an exception', async () => {
    const core = await barrel();
    expect(core.hasContext()).toBe(false);
    expect(core.currentSpan()).toBeUndefined();
    expect(core.isImpersonating()).toBe(false);
  }, 60_000);

  /**
   * Also the guard that keeps the two tests above from being vacuous: had the bundler inlined the
   * REAL `node:async_hooks`, these would open a scope instead of refusing, and evaluating the
   * chunk would have proved nothing about the stub.
   */
  test('refuses to OPEN a scope, with a code and a fix, on every write path', async () => {
    const core = await barrel();
    expect(() => core.runWithContext(core.createContext(), () => 1)).toThrow(
      /X_ASYNC_CONTEXT_UNAVAILABLE/,
    );
    expect(() => core.withSpan('work', () => 1)).toThrow(/X_ASYNC_CONTEXT_UNAVAILABLE/);
  }, 60_000);

  /**
   * `impersonate()` needs no refusal of its own and deliberately has none: it reads the parent
   * context first, and there is no parent here. A second code for the same fact would be two
   * answers to one question.
   */
  test('reports a missing parent, not a missing runtime, when impersonating', async () => {
    const core = await barrel();
    expect(() => core.impersonate(core.anonymousActor(), 'ticket 4821', () => 1)).toThrow(
      /X_NO_CONTEXT/,
    );
  }, 60_000);
});
