/**
 * contract — the server half of a preference write, which `mutator.test.ts` cannot reach: that
 * file tests `conflict` resolution, which is pure, and nothing in this app had ever driven the
 * statement underneath.
 *
 * `updatePreferences` chained `.where({ orgId, id }).update(values).returning()` onto a
 * `ReadBuilder` until 2026-08-24 — neither method exists — so `savePreferences`, `setTheme` and
 * `toggleDigestOptIn` were one `TypeError` each, on three write paths, under a green suite.
 *
 * Registration happens in `scripts/test-setup.ts`, the preload — this file does not import `api/`.
 */

import { expect, test } from '@ultimat3/testing';
import { savePreferences } from './actions';

test('savePreferences writes the member row and answers it as stored', async ({
  seed,
  actorFor,
}) => {
  // Bruno is `Europe/Madrid`, `en`, opted in — every field below is a real change, so a write
  // that silently did nothing could not pass by agreeing with the row it started from.
  const { member } = await seed('dev').pick({ member: 'member:bruno' });

  const saved = await savePreferences.as(actorFor(member), {
    locale: 'es',
    tz: 'Asia/Tokyo',
    theme: 'dark',
    digestOptIn: false,
  });

  expect(saved.id).toBe(member.id);
  expect(saved.orgId).toBe(member.orgId);
  expect(saved.locale).toBe('es');
  expect(saved.tz).toBe('Asia/Tokyo');
  expect(saved.theme).toBe('dark');
  expect(saved.digestOptIn).toBe(false);
  // Untouched columns come back as they were: this is `update(id, patch)`, never a row replace.
  expect(saved.email).toBe(member.email);
  expect(saved.role).toBe(member.role);
});

test('a partial write leaves the fields it does not name alone', async ({ seed, actorFor }) => {
  const { member } = await seed('dev').pick({ member: 'member:ada' });

  // The path `setTheme` and `toggleDigestOptIn` take — one column each, through the same service
  // method, which is why `OrgsService.savePreferences` declares every field optional.
  const saved = await savePreferences.as(actorFor(member), {
    locale: member.locale,
    tz: member.tz,
    theme: 'light',
    digestOptIn: member.digestOptIn,
  });

  expect(saved.theme).toBe('light');
  expect(saved.tz).toBe(member.tz);
  expect(saved.locale).toBe(member.locale);
});
