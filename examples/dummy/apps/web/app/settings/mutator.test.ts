/**
 * unit — no I/O, no queue. The rebase decision only, because that is the half of `custom()` no
 * other test reaches: `resolveConflict` is what @ultimat3/realtime calls when an offline toggle
 * comes back to a row the server has since changed.
 */

import { expect, test } from 'bun:test';
import { resolveConflict } from '@ultimat3/action';
import type { MemberView } from '../orgs/entity';
import { setTheme, toggleDigestOptIn } from './mutator';

const member = (patch: Partial<MemberView> = {}): MemberView => ({
  id: '00000000-0000-4000-8000-0000000000a1',
  orgId: '00000000-0000-4000-8000-0000000000e1',
  email: 'ada@postly.example',
  name: 'Ada Lovelace',
  role: 'author',
  tz: 'Europe/Madrid',
  locale: 'en',
  theme: 'system',
  digestOptIn: true,
  ...patch,
});

const rebase = (local: MemberView, server: MemberView): MemberView =>
  resolveConflict(toggleDigestOptIn.conflict, local, server);

test('an unsubscribe the server recorded survives a stale offline re-subscribe', () => {
  const merged = rebase(member({ digestOptIn: true }), member({ digestOptIn: false }));

  expect(merged.digestOptIn).toBe(false);
});

test('the local value wins while the server is still opted in, in both directions', () => {
  const server = member({ digestOptIn: true });

  expect(rebase(member({ digestOptIn: false }), server).digestOptIn).toBe(false);
  expect(rebase(member({ digestOptIn: true }), server).digestOptIn).toBe(true);
});

test('every field this mutator is not about comes back from the server', () => {
  // The row moved on another device while the toggle sat in the offline queue: a new theme, a
  // new locale, a promotion. None of them is this mutator's to decide, on either branch.
  const local = member({ digestOptIn: true, theme: 'dark', locale: 'en', role: 'author' });
  const server = member({ digestOptIn: false, theme: 'light', locale: 'es', role: 'admin' });

  expect(rebase(local, server)).toEqual(
    member({ digestOptIn: false, theme: 'light', locale: 'es', role: 'admin' }),
  );
  expect(rebase(local, { ...server, digestOptIn: true })).toEqual(
    member({ digestOptIn: true, theme: 'light', locale: 'es', role: 'admin' }),
  );
});

test('the theme mutator is last-write-wins, so the device that set it last keeps it', () => {
  const merged = resolveConflict(setTheme.conflict, member({ theme: 'dark' }), member());

  expect(merged.theme).toBe('dark');
});
