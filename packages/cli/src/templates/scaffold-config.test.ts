// The `app.config.ts` `x new` writes, held to one rule: every key in it is a key something reads.
// Nothing asserted this file's CONTENTS before — `cmd-new.test.ts` proves it exists and
// `scaffold-typecheck.ts` compiles `apps/`, not the config — so a key the framework stopped
// reading could sit in every generated app indefinitely, which is exactly what happened.

import { describe, expect, test } from 'bun:test';
import { defineConfig } from '@ultimat3/core';
import { names } from './naming';
import { repoFiles } from './scaffold-repo';

const source = (): string => {
  const file = repoFiles(names('ledger-demo'), '1.0.0', true).find(
    (entry) => entry.path === 'app.config.ts',
  );
  if (file === undefined) return expect.unreachable('x new writes no app.config.ts');
  return typeof file.contents === 'string'
    ? file.contents
    : expect.unreachable('app.config.ts is bytes, not text');
};

describe('unit · the app.config.ts x new writes', () => {
  test('names no config key the framework does not read', () => {
    const text = source();
    // All three were declared, defaulted and merged by `defineConfig` and read by NO file, and all
    // three are DELETED from `packages/core/src/config.ts` as of 2026-08-22 — so scaffolding any of
    // them would now be `TS2353` in every generated app's first `x verify`, rather than the silent
    // switch-with-no-wire it was. This assertion is what keeps one from coming back.
    for (const dead of ['installPrompt', 'afterSignInPath', 'modelEnv']) {
      expect(`app.config.ts names ${dead}: ${String(text.includes(dead))}`).toBe(
        `app.config.ts names ${dead}: false`,
      );
    }
  });

  test('the pwa block it does write is the half that is wired', () => {
    expect(source()).toContain("pwa: { enabled: true, offline: 'runtime' }");
  });

  test('the block it writes is one defineConfig accepts, and it grows no key back', () => {
    // The half that makes the deletion safe rather than merely tidy: the scaffold's literal block
    // still builds, and the RESULT carries no `installPrompt` — `section()` copies every own key of
    // the patch, so a default reinstated in core would reappear here without a scaffold change.
    const built = defineConfig({ name: 'ledger-demo', pwa: { enabled: true, offline: 'runtime' } });

    expect(built.pwa.offline).toBe('runtime');
    expect(Object.keys(built.pwa).sort()).toEqual(['backgroundSync', 'enabled', 'offline', 'push']);
  });
});
