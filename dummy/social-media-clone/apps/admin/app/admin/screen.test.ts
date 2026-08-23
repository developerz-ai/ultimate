// What a cell is allowed to assume. Nothing: not the reader's language, not their zone, and not
// that "yes" is a word every operator reads. All three were assumed here until 2026-08 — the
// locale was the literal `'en'` beside a `timeZone` read off the actor, and `—`/`yes`/`no` never
// went through `t()`, so they had no translation for anyone to notice was missing.

import { beforeAll, expect, test } from 'bun:test';
// Side-effect import: `defineCatalogs()` runs on the way through. Without it every `t()` below
// renders `⟦key⟧` and the boolean assertion would pass for the wrong reason.
import '@social-media-clone/i18n';
import { seedDemo } from '@social-media-clone/db';
import { createContext, runWithContext, userActor } from '@ultimat3/core';

// Loaded after `@ultimat3/render/server` has installed its `.tsx` loader, and never statically:
// `screen.ts` reaches `admin.ts`, which imports `pages/ops.tsx`. A static import compiles that
// `.tsx` before the plugin exists, so it is cached against `React.createElement` and every
// later render in the process dies with `React is not defined`. The rule is enforced by
// `apps/admin/static-tsx-imports.test.ts`, which explains the whole mechanism.
await import('@ultimat3/render/server');
const { resourceScreen } = await import('./screen');

/** `users` lists handle, displayName, role, suspended, createdAt — in that order. */
const SUSPENDED = 3;
const CREATED_AT = 4;

const screenFor = (locale: string, tz: string) =>
  runWithContext(
    createContext({ actor: userActor({ id: 'seeded-admin', roles: ['admin'] }), locale, tz }),
    () => resourceScreen('users'),
  );

const column = async (locale: string, tz: string, at: number): Promise<string> => {
  const screen = await screenFor(locale, tz);
  return screen.rows[0]?.cells[at] ?? '';
};

beforeAll(async () => {
  await seedDemo();
});

test('a timestamp is formatted in the ACTOR’s locale, never a literal one', async () => {
  const british = await column('en-GB', 'UTC', CREATED_AT);
  const american = await column('en-US', 'UTC', CREATED_AT);
  expect(british).not.toBe('');
  // Same instant, same zone, two locales: identical output means the locale argument is ignored,
  // which is exactly what a hardcoded `'en'` looks like from here.
  expect(british).not.toBe(american);
});

test('a timestamp is formatted in the actor’s zone, and there is no ambient default', async () => {
  const utc = await column('en-US', 'UTC', CREATED_AT);
  const tokyo = await column('en-US', 'Asia/Tokyo', CREATED_AT);
  expect(utc).not.toBe('');
  expect(tokyo).not.toBe(utc);
});

test('a boolean is a translated word, not a literal', async () => {
  // `No`, from the catalog — the literal was lowercase `no`, which is what makes this assertion
  // able to fail if the `t()` call is taken back out.
  expect(await column('en', 'UTC', SUSPENDED)).toBe('No');
});

test('every row carries the id its action form has to name', async () => {
  const screen = await screenFor('en', 'UTC');
  expect(screen.rows.length).toBeGreaterThan(0);
  for (const row of screen.rows) expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
});
