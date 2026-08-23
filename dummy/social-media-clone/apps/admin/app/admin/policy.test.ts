// The load-bearing test: `admin/admin` is view-only BY PERMISSION.
//
// Both halves, every time — the control is not rendered AND the call behind it is refused, by the
// SAME `decideAll()`. A test that only checked the render would pass for an admin whose buttons
// were merely hidden, which is the failure mode this whole design exists to make impossible.
//
// `operator` is the positive control. It runs the identical code path and is allowed, so a refusal
// below is provably a missing permission and not a missing feature.

import { beforeAll, expect, test } from 'bun:test';
import { seedDemo } from '@social-media-clone/db';
import type { AdminActor, CrudCtx } from '@ultimat3/admin';
import {
  actionButtons,
  adminCreate,
  adminDestroy,
  adminList,
  adminUpdate,
  confirmationToken,
  decideOperation,
  invokeAdminAction,
  memoryAuditLog,
  permissionsForOperation,
} from '@ultimat3/admin';
import { assert } from '@ultimat3/core';
import { seedId } from '@ultimat3/entity';
import { adminPolicies } from './policy';

// Loaded after `@ultimat3/render/server` has installed its `.tsx` loader, and never statically:
// `admin.ts` statically imports `pages/ops.tsx`. A static import compiles that `.tsx` before
// the plugin exists, so it is cached against `React.createElement` and every later render in
// the process dies with `React is not defined`. The rule is enforced by `apps/admin/static-tsx-
// imports.test.ts`, which explains the whole mechanism.
await import('@ultimat3/render/server');
const { admin } = await import('./admin');

const MARA = seedId('user:mara');
const TENANCY = seedId('post:tenancy');

/** `assert` rather than `throw new Error`: a bare Error is banned here, and this one narrows too. */
const FIX_WRITE =
  'restore the admin role grant list in apps/admin/app/admin/policy.ts — it must not carry admin:write';
const FIX_DESTROY =
  'restore the admin role grant list in apps/admin/app/admin/policy.ts — it must not carry admin:destroy';

const ctxFor = (roles: readonly string[]): CrudCtx => {
  const actor: AdminActor = { id: 'test-actor', roles, locale: 'en', timeZone: 'UTC' };
  return admin.ctx({ actor, requestId: `test-${roles.join('-')}` });
};

const readOnly = (): CrudCtx => ctxFor(['admin']);
const writer = (): CrudCtx => ctxFor(['operator']);

beforeAll(async () => {
  await seedDemo();
});

test('the seeded admin holds admin:read and never admin:write — the grant list is the rule', () => {
  const users = admin.resource('users');
  expect(decideOperation(users, 'list', readOnly()).allowed).toBe(true);
  expect(decideOperation(users, 'detail', readOnly()).allowed).toBe(true);
  expect(decideOperation(users, 'create', readOnly()).allowed).toBe(false);
  expect(decideOperation(users, 'update', readOnly()).allowed).toBe(false);
  expect(decideOperation(users, 'delete', readOnly()).allowed).toBe(false);
});

test('a WRITE is refused at the decision level, not merely un-rendered', async () => {
  const users = admin.resource('users');
  const result = await adminUpdate(users, readOnly(), MARA, { suspended: true });

  expect(result.ok).toBe(false);
  assert(
    !result.ok && result.kind === 'denied',
    'the read-only actor was allowed an UPDATE',
    FIX_WRITE,
  );
  expect(result.kind).toBe('denied');
  // The FIRST permission of the pair is what refused: `admin:write` is asked before the
  // per-entity gate, so an actor who somehow held `users:write` alone still cannot write.
  expect(result.decision.permission).toBe('admin:write');
  expect(permissionsForOperation('users', 'update')[0]).toBe('admin:write');
  // Refused BEFORE the repo, not by it: the row is untouched.
  expect((await users.repo?.find(MARA))?.suspended).toBe(false);
});

test('a DELETE is refused at the decision level, before the confirmation is even considered', async () => {
  const posts = admin.resource('posts');
  // The CORRECT confirmation token, deliberately: the denial has to come from `admin:destroy`
  // and not from a missing echo, or this would pass for a dashboard that only forgot the token.
  const result = await adminDestroy(
    posts,
    readOnly(),
    TENANCY,
    confirmationToken('posts', TENANCY),
  );

  expect(result.ok).toBe(false);
  assert(
    !result.ok && result.kind === 'denied',
    'the read-only actor was allowed a DELETE',
    FIX_DESTROY,
  );
  expect(result.kind).toBe('denied');
  expect(result.decision.permission).toBe('admin:destroy');
  expect(result.confirmationRequired).toBe(false);
  expect(await posts.repo?.find(TENANCY)).not.toBeNull();
});

test('a CREATE is refused too — read-only means read-only on every verb', async () => {
  const result = await adminCreate(admin.resource('users'), readOnly(), {
    handle: 'intruder',
    email: 'intruder@demo.example',
    displayName: 'Intruder',
  });
  expect(result.ok).toBe(false);
  assert(
    !result.ok && result.kind === 'denied',
    'the read-only actor was allowed a CREATE',
    FIX_WRITE,
  );
  expect(result.decision.permission).toBe('admin:write');
});

test('the button an actor cannot press never renders, and the call is refused by that decision', async () => {
  const users = admin.resource('users');
  const action = users.actions[0];
  assert(
    action !== undefined,
    'no admin action is registered on users',
    'add the user.suspend action back to defineAdmin() in apps/admin/app/admin/admin.ts',
  );

  const ctx = readOnly();
  // Half one: nothing to click.
  expect(actionButtons({ actions: users.actions, actor: ctx.actor, authz: ctx.authz })).toEqual([]);

  // Half two: the call, made anyway, refused by the same permissions the button asked about.
  const invoked = await invokeAdminAction({
    action,
    input: { id: MARA },
    actor: ctx.actor,
    authz: ctx.authz,
    audit: memoryAuditLog(),
    requestId: 'test-invoke',
  });
  expect(invoked.ok).toBe(false);
  assert(!invoked.ok, 'the read-only actor invoked a write action', FIX_WRITE);
  expect(invoked.decision.permission).toBe('admin:write');
  expect((await users.repo?.find(MARA))?.suspended).toBe(false);
});

test('every denial is on the audit log, keyed by the request that caused it', async () => {
  const result = await adminUpdate(admin.resource('users'), readOnly(), MARA, { suspended: true });
  expect(result.audit.outcome).toBe('denied');
  expect(result.audit.entity).toBe('users');
  expect(result.audit.requestId).toBe('test-admin');
  // Readable back off the log the whole dashboard shares — a denial nobody can find afterwards
  // is a denial nobody can review.
  const logged = admin.audit.entries({ entity: 'users', limit: 5 });
  expect(logged.some((entry) => entry.id === result.audit.id)).toBe(true);
});

test('operator — the same code path, allowed: the refusal above is a permission, not a gap', async () => {
  const users = admin.resource('users');
  expect(decideOperation(users, 'update', writer()).allowed).toBe(true);
  expect(decideOperation(users, 'delete', writer()).allowed).toBe(true);

  // A real write through the real path, valued so the row ends exactly where it started.
  const written = await adminUpdate(users, writer(), MARA, { suspended: false });
  expect(written.ok).toBe(true);
  expect(
    actionButtons({ actions: users.actions, actor: writer().actor, authz: writer().authz }),
  ).toHaveLength(1);
});

test('a permission with no registered policy is denied, never defaulted to allow', () => {
  expect(adminPolicies['users:teleport']).toBeUndefined();
  const decision = admin.authz.decide({
    permission: 'users:teleport',
    actor: { id: 'test-actor', roles: ['operator'] },
  });
  expect(decision.allowed).toBe(false);
  expect(decision.reason).toBe('admin.policy.missing');
});

test('reading still works for the read-only actor — view-only is not no-access', async () => {
  const page = await adminList(admin.resource('media'), readOnly(), { limit: 10 });
  expect(page.ok).toBe(true);
  assert(
    page.ok,
    'the read-only actor could not list media',
    'grant media:read to the admin role in apps/admin/app/admin/policy.ts — view-only is not no-access',
  );
  expect(page.page.rows.length).toBeGreaterThan(0);
});
