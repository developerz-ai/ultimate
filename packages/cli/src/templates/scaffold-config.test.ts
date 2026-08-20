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
    // `installPrompt` is `PwaConfig`'s and NO file reads it — `packages/core/src/config.ts` carries
    // the marker saying so. Scaffolding it wrote a switch with no wire into every generated app.
    expect(text).not.toContain('installPrompt');
  });

  test('the pwa block it does write is the half that is wired', () => {
    expect(source()).toContain("pwa: { enabled: true, offline: 'runtime' }");
  });

  test('omitting the key still produces a config defineConfig accepts', () => {
    // The half that makes the deletion safe rather than merely tidy: `installPrompt` is REQUIRED on
    // `PwaConfig` and defaulted by `defineConfig`, so a scaffold that omits it still boots — and a
    // future change that made it required-without-a-default would fail here rather than in a
    // generated app's first `x dev`.
    const built = defineConfig({ name: 'ledger-demo', pwa: { enabled: true, offline: 'runtime' } });

    expect(built.pwa.offline).toBe('runtime');
    expect(built.pwa.installPrompt).toBe(false);
  });
});
