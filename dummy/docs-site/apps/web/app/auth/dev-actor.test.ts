// The development viewer is safe because of what it refuses: a role nobody declared is never the
// default viewer, and the actor it mints holds what its role holds and nothing else. WHEN it is
// asked is `authenticator.ts`'s, and `authenticator.test.ts` holds that half.
import { installLogSink } from '@ultimat3/core';
import { actorHas } from '@ultimat3/policy';
import { expect, unitTest } from '@ultimat3/testing';
import { roles } from '../../shared/roles';
import {
  DEFAULT_DEV_ROLE,
  DEV_ROLE_COOKIE,
  declaredDevRoles,
  devActorFor,
  devAuthenticate,
  devRoleFrom,
} from './dev-actor';

unitTest('the cookie names a DECLARED role; with no cookie it is the default viewer', () => {
  expect(devRoleFrom(`${DEV_ROLE_COOKIE}=member`)).toBe('member');
  expect(devRoleFrom(null)).toBe(DEFAULT_DEV_ROLE);
  // Read off the role map, so a role added to shared/roles.ts is one this cookie can name.
  expect(declaredDevRoles()).toEqual(Object.keys(roles));
  expect(declaredDevRoles()).toContain(DEFAULT_DEV_ROLE);
});

unitTest('a cookie naming an undeclared role is never the default viewer', () => {
  // It fell back to admin: a typo, or a role not declared yet, browsed as the most privileged
  // role there is — and a "read-only role cannot write" check passed for the wrong reason.
  for (const named of ['nobody', 'Admin', 'constructor', '']) {
    expect(devRoleFrom(`${DEV_ROLE_COOKIE}=${named}`)).toBeUndefined();
  }
});

unitTest('the actor it mints holds what the role map grants it, and nothing else', () => {
  // `actorHas` and not `holds`: this is the function `can()` itself calls, so the assertion is
  // the pipeline's own decision rather than a second implementation of it. The map is passed
  // explicitly — a test that depended on which module imported first would pass alone and fail
  // inside a suite.
  expect(actorHas(devActorFor('admin'), 'admin:read', roles)).toBe(true);
  expect(actorHas(devActorFor('member'), 'dashboard:read', roles)).toBe(true);
  // The whole reason this is development-only: a member is not an admin, and neither is a deploy.
  expect(actorHas(devActorFor('member'), 'admin:read', roles)).toBe(false);
});

unitTest('it answers a request from its cookie header, and no other', () => {
  const cookie = `${DEV_ROLE_COOKIE}=member`;
  const request = { header: (name: string) => (name === 'cookie' ? cookie : null) };
  expect(devAuthenticate(request)?.roles).toEqual(['member']);
  // A request with no cookie is the default viewer, never an anonymous one.
  expect(devAuthenticate({ header: () => null })?.roles).toEqual([DEFAULT_DEV_ROLE]);
});

unitTest('an undeclared role is answered as ANONYMOUS, and the log names what it read', () => {
  const lines: Record<string, unknown>[] = [];
  const releaseLogSink = installLogSink((line) =>
    lines.push(JSON.parse(line) as Record<string, unknown>),
  );
  try {
    const cookie = `${DEV_ROLE_COOKIE}=auditor`;
    expect(devAuthenticate({ header: () => cookie })).toBeNull();
  } finally {
    releaseLogSink();
  }
  expect(lines).toHaveLength(1);
  expect(lines[0]?.level).toBe('warn');
  expect(lines[0]?.named).toBe('auditor');
  expect(lines[0]?.declared).toEqual(Object.keys(roles));
});
