// The tests `x g invite` writes beside its files: the link shape on its own, then each action RUN
// inside a real request context over the app's migrated database, so the paths a person takes —
// refused, invited, joined, replayed, removed — are what is held.

const DATABASE = `// A template restore is ~0.5 s; its first build (initdb plus every migration) is what this bounds.
const BOOT_MS = 120_000;

const workerDatabase = reusableDatabase(() => migratedDatabase({ root: import.meta.dir }));
beforeAll(async () => {
  setDbClient(await workerDatabase());
}, BOOT_MS);
// Back to memory, so this file's database never reaches the next file's unit tests.
afterAll(() => setDbClient(undefined));`;

const SHARED_IMPORTS = `import { migratedDatabase } from '@ultimat3/cli';
import { type Actor, runWithContext } from '@ultimat3/core';
import { setDbClient } from '@ultimat3/db';
import { asCtx, defineHttpConfig, requestContext } from '@ultimat3/http';
import { testActor } from '@ultimat3/policy';
import { afterAll, beforeAll, expect, reusableDatabase, unitTest } from '@ultimat3/testing';`;

/** One POST as `actor`, the action run inside it: the response headers come back with it. */
const postAs = (
  action: string,
  path: string,
): string => `const post = async (input: Parameters<typeof target>[0], actor: Actor | undefined, cookie = '') => {
  const request = requestContext({
    url: new URL('https://app.test${path}'),
    method: 'POST',
    role: 'web',
    config: defineHttpConfig({ dev: true, rateLimit: { scope: 'process' } }),
    requestHeaders: { accept: 'application/json', cookie },
  });
  if (actor !== undefined) request.actor = actor;
  const output = await runWithContext(asCtx(request), () => target(input, { ctx: asCtx(request) }));
  return { output, request };
};

const target = ${action}.named('${action}');`;

/** Org ids are uuids: \`x_users.org_id\` is one. */
const ORGS = `const ORG = '00000000-0000-4000-8000-0000000000a1';
const OTHER_ORG = '00000000-0000-4000-8000-0000000000b2';
const PASSWORD = 'a long scaffold test passphrase';
/** Issuing mails nothing in these tests: the link comes back as the returned token. */
const silent = { send: async () => {} };`;

export const inviteModuleTest =
  (): string => `// The invite link is absolute and carries both halves accept needs; the flow is the one declared.
import { expect, unitTest } from '@ultimat3/testing';
import { appOrigin, INVITE_ACCEPT_PATH, INVITE_TTL_MS, inviteLink, memberInvite } from './invite';

unitTest('the mailed link is the accept page, carrying the org and the token', () => {
  const link = new URL(inviteLink(new URL('https://app.test/x'), 'org-1')('a-token'));
  expect(link.origin).toBe('https://app.test');
  expect(link.pathname).toBe(INVITE_ACCEPT_PATH);
  expect(link.searchParams.get('orgId')).toBe('org-1');
  expect(link.searchParams.get('token')).toBe('a-token');
});

unitTest('the origin is APP_URL, and with none declared there is no link to mail', () => {
  expect(appOrigin({ APP_URL: 'https://app.example/' }).origin).toBe('https://app.example');
  expect(() => appOrigin({})).toThrow(expect.objectContaining({ code: 'X_ENV_MISSING' }));
  expect(() => appOrigin({ APP_URL: ' ' })).toThrow(
    expect.objectContaining({ code: 'X_ENV_MISSING' }),
  );
});

unitTest('an invite is the declared member-invite purpose and lives a week', () => {
  expect(memberInvite.purpose).toBe('member-invite');
  expect(INVITE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
});
`;

export const inviteMemberTest =
  (): string => `// inviteMember, run inside a real request over the app's migrated database: an actor without the
// grant is refused, and one holding it mails a single-use link into their own org.
${SHARED_IMPORTS}
import { INVITE_ACCEPT_PATH } from '../invite';
import { inviteMember } from './invite-member';

${DATABASE}

const ORG = '00000000-0000-4000-8000-0000000000a1';

${postAs('inviteMember', '/auth/invites')}

unitTest('inviteMember is an action that takes an address and refuses the rest', async () => {
  expect(target.kind).toBe('action');
  await expect(target.input).toAcceptInput({ email: 'ada@example.com' });
  await expect(target.input).toRejectInput({ email: 'not an address' });
});

unitTest('an actor without member:invite is refused', async () => {
  const outsider = testActor('outsider', { orgId: ORG }).actor;
  const refused = await post({ email: 'ada@example.com' }, outsider).catch((e: unknown) => e);
  expect(refused).toBeUltimateError('X_FORBIDDEN');
});

/** \`APP_URL\` set for one test, and put back after it. */
const withAppUrl = async (value: string | undefined, run: () => Promise<void>): Promise<void> => {
  const before = Bun.env.APP_URL;
  if (value === undefined) delete Bun.env.APP_URL;
  else Bun.env.APP_URL = value;
  try {
    await run();
  } finally {
    if (before === undefined) delete Bun.env.APP_URL;
    else Bun.env.APP_URL = before;
  }
};

unitTest('an inviter mails a link on the declared origin', async ({ mail, runJobs }) => {
  const inviter = testActor('inviter', { orgId: ORG, permissions: ['member:invite'] }).actor;
  await withAppUrl('https://invites.example', async () => {
    // The request arrives on another host: the caller writes \`Host\`, so it never names the link.
    const { output } = await post({ email: 'Ada@Example.com' }, inviter);
    expect(output.ok).toBe(true);
  });
  await runJobs.drain();
  const sent = mail.lastTo('ada@example.com');
  const link = \`https://invites.example\${INVITE_ACCEPT_PATH}?orgId=\${ORG}\`;
  expect(sent?.message.html).toContain(link);
  expect(sent?.message.html).not.toContain('app.test');
});

unitTest('with no APP_URL declared nothing is mailed', async ({ mail, runJobs }) => {
  const inviter = testActor('inviter', { orgId: ORG, permissions: ['member:invite'] }).actor;
  await withAppUrl(undefined, async () => {
    const refused = await post({ email: 'nobody@example.com' }, inviter).catch((e: unknown) => e);
    expect(refused).toBeUltimateError('X_ENV_MISSING');
  });
  await runJobs.drain();
  expect(mail.lastTo('nobody@example.com')).toBeUndefined();
});
`;

export const acceptInviteTest =
  (): string => `// acceptInvite, run inside a real request over the app's migrated database: anonymous is refused,
// the invited account joins and its session is rotated, and the spent link never works again.
import { login, register } from '@ultimat3/auth';
${SHARED_IMPORTS}
import { appAuth } from '../auth';
import { memberInvite } from '../invite';
import { acceptInvite } from './accept-invite';

${DATABASE}

${ORGS}

${postAs('acceptInvite', '/auth/invites/accept')}

unitTest('an anonymous caller is refused before the link is read', async () => {
  const refused = await post({ orgId: ORG, token: 'a-token' }, undefined).catch((e: unknown) => e);
  expect(refused).toBeUltimateError('X_UNAUTHENTICATED');
});

unitTest('the invited account joins, its session is rotated, and the link is spent', async () => {
  const user = await register(appAuth(), { email: 'join@example.com', password: PASSWORD });
  const signedIn = await login(appAuth(), { email: 'join@example.com', password: PASSWORD });
  const { token } = await memberInvite.invite(appAuth(), silent, {
    orgId: ORG,
    email: 'join@example.com',
    locale: 'en',
  });
  const cookie = signedIn.cookie.split(';')[0] ?? '';
  const actor = testActor(user.id).actor;
  const { output, request } = await post({ orgId: ORG, token }, actor, cookie);
  expect(output.ok).toBe(true);
  expect((await appAuth().adapter.findUserById(user.id))?.orgId).toBe(ORG);
  const name = appAuth().sessions.policy.cookieName;
  expect(request.headers.getSetCookie().some((line) => line.startsWith(\`\${name}=\`))).toBe(true);
  const replayed = await post({ orgId: ORG, token }, actor).catch((e: unknown) => e);
  expect(replayed).toBeUltimateError('X_UNAUTHENTICATED');
});

unitTest('a link for one org redeems in no other', async () => {
  const user = await register(appAuth(), { email: 'cross@example.com', password: PASSWORD });
  const { token } = await memberInvite.invite(appAuth(), silent, {
    orgId: ORG,
    email: 'cross@example.com',
    locale: 'en',
  });
  const actor = testActor(user.id).actor;
  const refused = await post({ orgId: OTHER_ORG, token }, actor).catch((e: unknown) => e);
  expect(refused).toBeUltimateError('X_UNAUTHENTICATED');
  expect((await appAuth().adapter.findUserById(user.id))?.orgId).toBeNull();
});
`;

export const revokeInviteTest =
  (): string => `// revokeInvite, run inside a real request over the app's migrated database: an actor without the
// grant is refused, and an inviter removes a joined member from their own org.
import { register } from '@ultimat3/auth';
${SHARED_IMPORTS}
import { appAuth } from '../auth';
import { memberInvite } from '../invite';
import { revokeInvite } from './revoke-invite';

${DATABASE}

${ORGS}

${postAs('revokeInvite', '/auth/invites')}

unitTest('an actor without member:invite is refused', async () => {
  const outsider = testActor('outsider', { orgId: ORG }).actor;
  const refused = await post({ email: 'ada@example.com' }, outsider).catch((e: unknown) => e);
  expect(refused).toBeUltimateError('X_FORBIDDEN');
});

unitTest('a joined member is removed from the inviter org, never from another', async () => {
  const user = await register(appAuth(), { email: 'leave@example.com', password: PASSWORD });
  const { token } = await memberInvite.invite(appAuth(), silent, {
    orgId: ORG,
    email: 'leave@example.com',
    locale: 'en',
  });
  await memberInvite.accept(appAuth(), { orgId: ORG, token, userId: user.id });
  const elsewhere = testActor('elsewhere', { orgId: OTHER_ORG, permissions: ['member:invite'] });
  const untouched = await post({ email: 'leave@example.com' }, elsewhere.actor);
  expect(untouched.output.memberRemoved).toBe(false);
  const inviter = testActor('inviter', { orgId: ORG, permissions: ['member:invite'] }).actor;
  const { output } = await post({ email: 'leave@example.com' }, inviter);
  expect(output.memberRemoved).toBe(true);
  expect((await appAuth().adapter.findUserById(user.id))?.orgId).toBeNull();
});
`;
