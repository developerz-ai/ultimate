// The `app.config.ts` `x new` writes, held to one rule: every key in it is a key `AppConfigInput`
// still declares. Nothing asserted this file's CONTENTS before — `cmd-new.test.ts` proves it
// exists and `scaffold-typecheck.ts` compiles `apps/`, not the config — so a key the framework
// stopped reading could sit in every generated app indefinitely, which is exactly what happened.
//
// The rule is DERIVED, not a list. It was a list — `installPrompt`, `afterSignInPath`, `modelEnv`,
// hand-copied and hand-extended — and `realtime.tier` was deleted from `packages/core/src/config.ts`
// on 2026-08-23 without anyone adding a fourth entry, so `x new` kept emitting a key that is
// `TS2353` and CI's `scaffold-smoke` was one merge from red. A rule that needs a human to remember
// it is the documentation axiom 3 says does not exist. Every key path the emitted literal names is
// now resolved against what `defineConfig` really returns, so the FOURTEENTH deletion fails here
// with no edit at all.
//
// `text.includes(dead)` could not have been extended anyway: adding `'tier'` to that list matches
// `cache: { tiers: [...] }`, which is a live key. Whole key paths, never substrings.

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

/** The `defineConfig({ … })` argument, brace-matched — never the `envSchema` block above it. */
const configLiteral = (text: string): string => {
  const open = text.indexOf('defineConfig({');
  if (open === -1) return expect.unreachable('the emitted app.config.ts calls no defineConfig');
  const start = text.indexOf('{', open);
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return expect.unreachable('the defineConfig({ … }) call is unbalanced');
};

/**
 * Every dotted key path the literal names — `cache.tiers`, `ai.mcp.expose`. Strings and line
 * comments are blanked first: a `//` inside a URL, or a `:` inside `'no-reply@example.test'`,
 * would otherwise read as structure.
 */
const keyPathsIn = (literal: string): readonly string[] => {
  const masked = literal
    .replaceAll(/'[^']*'/g, (match) => `'${' '.repeat(Math.max(match.length - 2, 0))}'`)
    .replaceAll(/\/\/[^\n]*/g, (match) => ' '.repeat(match.length));
  const paths: string[] = [];
  const stack: string[] = [];
  const token = /([A-Za-z_$][\w$]*)\s*:|([{}[\]])/g;
  let pending: string | undefined;
  for (const match of masked.matchAll(token)) {
    const [, key, brace] = match;
    if (key !== undefined) {
      paths.push([...stack, key].join('.'));
      pending = key;
      continue;
    }
    if (brace === '{' || brace === '[') {
      stack.push(pending ?? '');
      pending = undefined;
      continue;
    }
    if (brace === '}' || brace === ']') stack.pop();
  }
  // The outermost `{` pushes an empty segment; drop it so paths read `cache.tiers`.
  return paths.map((path) => path.replace(/^\.+/, ''));
};

/** `built.cache.tiers` — `in`, never `!== undefined`: `realtime.urlEnv` is a declared `undefined`. */
const declares = (built: Record<string, unknown>, path: string): boolean => {
  let node: unknown = built;
  for (const segment of path.split('.')) {
    if (typeof node !== 'object' || node === null) return false;
    if (!(segment in node)) return false;
    node = (node as Record<string, unknown>)[segment];
  }
  return true;
};

describe('unit · the app.config.ts x new writes', () => {
  test('names no config key the framework does not read', () => {
    // The result of the scaffold's OWN literal, so this asks about the exact object `x new` emits
    // rather than about defaults. A key `AppConfigInput` no longer declares is absent from it, and
    // is `TS2353` in the generated app's first `x verify`.
    const built = defineConfig({
      name: 'ledger-demo',
      cache: { tiers: ['request-memo', 'lru'] },
      jobs: { queues: ['ledger-demo-default'], concurrency: 4 },
      realtime: { enabled: true, transport: 'memory' },
      pwa: {
        enabled: true,
        offline: 'runtime',
        name: 'Ledger Demo',
        colors: {
          light: { themeColor: '#1b1f3b', backgroundColor: '#ffffff' },
          dark: { themeColor: '#1b1f3b', backgroundColor: '#0b0d1a' },
        },
      },
      ai: { mcp: { expose: true, path: '/mcp' } },
    }) as unknown as Record<string, unknown>;

    const emitted = keyPathsIn(configLiteral(source()));
    // The scan is worthless if it found nothing, and `realtime.transport` is the sibling of the
    // key that got through — so the file names both facts rather than trusting the loop.
    expect(emitted.length).toBeGreaterThan(8);
    expect(emitted).toContain('realtime.transport');

    const dead = emitted.filter((path) => !declares(built, path));
    expect(`app.config.ts names dead keys: ${dead.join(', ')}`).toBe(
      'app.config.ts names dead keys: ',
    );
  });

  // Every key of it is wired now (#362): `offline` is still the one half with no build behind it,
  // and `name`/`colors` are what `packages/cli/src/pwa-artifacts.ts` reads to emit the manifest a
  // browser needs before it will offer to install the app.
  test('the pwa block it does write says what an install needs', () => {
    const emitted = source();
    expect(emitted).toContain("offline: 'runtime',");
    // A HUMAN title, never the slug: `app.name` is `ledger-demo` by `NAME_RE`, and that is what an
    // install prompt would have shown a person.
    expect(emitted).toContain("name: 'Ledger Demo',");
    expect(emitted).toContain("light: { themeColor: '#1b1f3b', backgroundColor: '#ffffff' },");
    expect(emitted).toContain("dark: { themeColor: '#1b1f3b', backgroundColor: '#0b0d1a' },");
  });

  test('the block it writes is one defineConfig accepts, and it grows no key back', () => {
    // The half that makes the deletion safe rather than merely tidy: the scaffold's literal block
    // still builds, and the RESULT carries no `installPrompt` — `section()` copies every own key of
    // the patch, so a default reinstated in core would reappear here without a scaffold change.
    const built = defineConfig({
      name: 'ledger-demo',
      pwa: {
        enabled: true,
        offline: 'runtime',
        name: 'Ledger Demo',
        colors: {
          light: { themeColor: '#1b1f3b', backgroundColor: '#ffffff' },
          dark: { themeColor: '#1b1f3b', backgroundColor: '#0b0d1a' },
        },
      },
    });

    expect(built.pwa.offline).toBe('runtime');
    expect(Object.keys(built.pwa).sort()).toEqual([
      'backgroundSync',
      'colors',
      'enabled',
      'name',
      'offline',
      'push',
    ]);
  });
});
