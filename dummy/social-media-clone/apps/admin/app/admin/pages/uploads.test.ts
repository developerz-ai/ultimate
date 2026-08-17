// The gate the ops board grew in 2026-08. `mediaStateCounts` reaches the media table directly —
// it is imported BY `admin.ts`, so it cannot ask the `AdminApp`'s authz without closing a cycle —
// which made this call the one place in apps/admin that touched the database with nothing deciding.

import { expect, test } from 'bun:test';
import type { CrudCtx } from '@ultimat3/admin';
import { memoryAuditLog, staticAuthz } from '@ultimat3/admin';
import { uploadsFor } from './uploads';

/**
 * An EXACT grant list. `staticAuthz` is the seam for it — every role this app defines carries
 * `media:read` beside `job:read`, so the app's own policies cannot express the actor this gate
 * exists for: one who may open the ops board and may not read the media table.
 */
const ctxWith = (granted: readonly string[]): CrudCtx => ({
  actor: { id: 'test-actor', roles: [], locale: 'en', timeZone: 'UTC' },
  requestId: `test-${granted.join('-')}`,
  audit: memoryAuditLog(),
  authz: staticAuthz(granted),
});

// Failure first: opening the board is `job:read`, and `job:read` is not permission to count media.
test('unit · an actor who may open the board does not get counts they may not list', async () => {
  const uploads = await uploadsFor(ctxWith(['admin:read', 'job:read']));

  expect(uploads.decision.allowed).toBe(false);
  // The refusal names the media table's own permission, not the page's.
  expect(uploads.decision.permission).toBe('media:read');
  // `null` and not `{}`: the query is never made, so there is no zeroed breakdown to misread.
  expect(uploads.counts).toBeNull();
});

test('unit · the same call, with media:read, counts — so the refusal is a permission, not a gap', async () => {
  const uploads = await uploadsFor(ctxWith(['admin:read', 'job:read', 'media:read']));

  expect(uploads.decision.allowed).toBe(true);
  // The three states the sweep moves an upload between, every one of them answered.
  expect(Object.keys(uploads.counts ?? {})).toEqual(['pending', 'attached', 'orphan']);
});
