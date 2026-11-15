// `x g invite`: the member invite as the app's own actions over `@ultimat3/auth`'s
// `defineMemberInvite` — the flow, its mail, the one permission it needs, three actions, and the
// two native-form pages that post at them. The framework holds the link to one org, one address
// and one use; who may invite, and what a joiner becomes, are these files' — the app's to edit.

import { catalogJson } from './catalog-json';
import { INVITE_CATALOG, invitePageSource, invitePageTest } from './invite-pages';
import {
  acceptInviteTest,
  inviteMemberTest,
  inviteModuleTest,
  revokeInviteTest,
} from './invite-tests';
import { catalogPath } from './locales';
import type { GeneratedFile } from './naming';
import { authModule } from './scaffold-auth';
import { AUTH_DIR } from './sign-in-shared';

export interface InviteTemplateOptions {
  readonly locales: readonly string[];
  /** The app's `@<app>/i18n`; absent, the pages import `t` from `@ultimat3/i18n`. */
  readonly catalogModule?: string | undefined;
}

/** The inviter's page, and where the mailed link lands beneath it. */
export const INVITES_PATH = '/auth/invites';
export const INVITE_ACCEPT_PATH = `${INVITES_PATH}/accept`;

const moduleSource =
  (): string => `// The member invite: one declaration of the flow, the mail it sends and the link it carries.
// \`defineMemberInvite\` binds each link to ONE org and ONE address, single-use and expiring; the
// actions beside this file are the app's policy over it.
import { defineMemberInvite, type MailSender } from '@ultimat3/auth';
import { EnvMissingError } from '@ultimat3/core';
import { setRedirect, useRequestHeader } from '@ultimat3/http';
import { blocks, defineMail, send, t } from '@ultimat3/mail';

/** A week: long enough to survive a holiday, short enough that a stale inbox is not a door. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** The inviter's page, and the invitee's beneath it. */
export const INVITES_PATH = '${INVITES_PATH}';
export const INVITE_ACCEPT_PATH = '${INVITE_ACCEPT_PATH}';
/** Where a joiner lands. The app's to move. */
export const AFTER_JOIN = '/dashboard';

export const inviteMail = defineMail({
  id: 'auth.invite',
  subject: 'app.auth.inviteMail.subject',
  input: t.object({ link: t.string }),
  template: ({ data }) => [
    blocks.paragraph('app.auth.inviteMail.body'),
    blocks.button('app.auth.inviteMail.cta', data.link),
  ],
  preview: { link: 'https://app.example${INVITE_ACCEPT_PATH}?orgId=preview&token=preview' },
});

export const memberInvite = defineMemberInvite({ template: inviteMail.id, ttlMs: INVITE_TTL_MS });

/** The flow hands over the address and the link; this mail is what reaches the inbox. */
export const inviteMailer: MailSender = {
  async send(_template, to, data, locale) {
    const link = typeof data.link === 'string' ? data.link : '';
    await send(inviteMail, { link }, { to, locale });
  },
};

/**
 * The origin a mailed link is built on: \`APP_URL\`, declared. Never the request's own — that is
 * the \`Host\` header, which the caller writes, so a link built from it is a phishing link sent
 * from this app's own address. With none declared there is no link to mail.
 */
export const appOrigin = (env: Readonly<Record<string, string | undefined>> = Bun.env): URL => {
  const declared = (env.APP_URL ?? '').trim();
  if (declared === '') {
    throw new EnvMissingError({
      cause: 'APP_URL is not set, so there is no declared origin to build the invite link from',
      fix: 'export APP_URL=http://localhost:3000   # the origin this app is served from',
      meta: { key: 'APP_URL' },
    });
  }
  return new URL(declared);
};

/** The accept page's absolute URL, carrying the org and the token: accept needs both. */
export const inviteLink =
  (origin: URL, orgId: string) =>
  (token: string): string => {
    const url = new URL(INVITE_ACCEPT_PATH, origin);
    url.search = new URLSearchParams({ orgId, token }).toString();
    return url.href;
  };

/** A browser that posted the native form gets a 303; an agent posting JSON gets the path as data. */
export const landAt = (path: string): string => {
  if ((useRequestHeader('accept') ?? '').includes('text/html')) setRedirect(path);
  return path;
};
`;

const policySource =
  (): string => `// Who may invite into — and remove from — their own org: one permission, which \`x g invite\`
// granted to \`admin\`. Seat limits and which roles a joiner gets are this app's: add them here.
import { can, definePermissions } from '@ultimat3/policy';

declare module '@ultimat3/policy' {
  interface PermissionRegistry {
    'member:invite': true;
  }
}

export const invitePermissions = definePermissions(['member:invite']);

/**
 * The org is the actor's own, never an input: the tenancy rule is that the actor HAS one. It also
 * gates \`revokeInvite\`, which removes an address that joined through an invite — and only such an
 * address (\`defineMemberInvite\`'s revoke never touches a member who did not). Who may remove
 * whom beyond that — an owner nobody may remove, a seat that must stay filled — is this app's:
 * give \`revokeInvite\` its own rule here, \`can<{ email: string }>('member:invite', …)\`.
 */
export const canInvite = can(
  'member:invite',
  ({ actor }) => actor !== null && typeof actor.orgId === 'string' && actor.orgId !== '',
);
`;

const inviteMemberSource =
  (): string => `// Invite a person into the actor's org: a single-use link, mailed in the inviter's locale. Asking
// again for the same address is the resend — the new link replaces the old one.
import { action, t } from '@ultimat3/action';
import { authForbidden } from '@ultimat3/auth';
import { appAuth } from '../auth';
import { appOrigin, INVITES_PATH, inviteLink, inviteMailer, landAt, memberInvite } from '../invite';
import { canInvite } from '../policy';

export const inviteMember = action({
  input: t.object({ email: t.email }),
  output: t.object({ ok: t.boolean, next: t.string }),
  policy: canInvite,
  // Mailing a person is a browser operation here; an app that wants it as a tool exposes it.
  mcp: { expose: false },
  async handle({ input, ctx }) {
    const orgId = ctx.actor.orgId;
    if (typeof orgId !== 'string' || orgId === '') {
      throw authForbidden('POST inviteMember', 'the actor belongs to no org');
    }
    await memberInvite.invite(appAuth(), inviteMailer, {
      orgId,
      email: input.email,
      locale: ctx.locale,
      link: inviteLink(appOrigin(), orgId),
    });
    return { ok: true, next: landAt(INVITES_PATH) };
  },
});
`;

const acceptInviteSource =
  (): string => `// Accept an invite: the signed-in account joins the org the link names. The link is the
// credential — \`accept\` consumes it only under this account's own address, so a forwarded link
// joins nobody — and the session is rotated, because membership is a privilege change.
import { action, t } from '@ultimat3/action';
import { authUnauthenticated, verifySession } from '@ultimat3/auth';
import { isAnonymous } from '@ultimat3/core';
import { useRequestContext, useRequestCookie } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { appAuth } from '../auth';
import { AFTER_JOIN, landAt, memberInvite } from '../invite';

export const acceptInvite = action({
  input: t.object({ orgId: t.uuid, token: t.string.min(1).max(256) }),
  output: t.object({ ok: t.boolean, next: t.string }),
  // Public by declaration: the invitee holds no permission yet. The link is what authorises, and
  // the handler refuses an anonymous caller before it reads it.
  policy: allow('invite-link'),
  mcp: { expose: false },
  async handle({ input, ctx }) {
    if (isAnonymous(ctx.actor)) throw authUnauthenticated('POST acceptInvite');
    const auth = appAuth();
    const cookie = useRequestCookie(auth.sessions.policy.cookieName);
    const session =
      cookie === null || cookie === '' ? undefined : await verifySession(auth.sessions, cookie);
    const joined = await memberInvite.accept(auth, {
      orgId: input.orgId,
      token: input.token,
      userId: ctx.actor.id,
      session,
    });
    if (joined.cookie !== undefined) {
      useRequestContext('acceptInvite').headers.append('set-cookie', joined.cookie);
    }
    return { ok: true, next: landAt(AFTER_JOIN) };
  },
});
`;

const revokeInviteSource =
  (): string => `// Withdraw an invite from the actor's org: the link dies, and an address that already joined
// leaves the org with every session it held.
import { action, t } from '@ultimat3/action';
import { authForbidden } from '@ultimat3/auth';
import { appAuth } from '../auth';
import { INVITES_PATH, landAt, memberInvite } from '../invite';
import { canInvite } from '../policy';

export const revokeInvite = action({
  input: t.object({ email: t.email }),
  output: t.object({ ok: t.boolean, next: t.string, memberRemoved: t.boolean }),
  policy: canInvite,
  mcp: { expose: false },
  async handle({ input, ctx }) {
    const orgId = ctx.actor.orgId;
    if (typeof orgId !== 'string' || orgId === '') {
      throw authForbidden('POST revokeInvite', 'the actor belongs to no org');
    }
    const revoked = await memberInvite.revoke(appAuth(), {
      orgId,
      email: input.email,
      reason: \`revokeInvite by \${ctx.actor.id}\`,
    });
    const next = landAt(INVITES_PATH);
    return { ok: true, next, memberRemoved: revoked.memberRemoved };
  },
});
`;

/** The exercise pass draws inputs and actors; none of these three can run on drawn ones. */
const off = (name: string, why: string) => ({ name, value: `{ off: '${why}' }` });

export function inviteFiles(options: InviteTemplateOptions): readonly GeneratedFile[] {
  const module = options.catalogModule;
  return [
    { path: `${AUTH_DIR}/invite.ts`, contents: moduleSource() },
    { path: `${AUTH_DIR}/invite.test.ts`, contents: inviteModuleTest() },
    { path: `${AUTH_DIR}/policy.ts`, contents: policySource() },
    {
      path: `${AUTH_DIR}/actions/invite-member.ts`,
      contents: inviteMemberSource(),
      exercise: off('inviteMember', 'mails a link; the pass holds no actor in an org'),
    },
    { path: `${AUTH_DIR}/actions/invite-member.test.ts`, contents: inviteMemberTest() },
    {
      path: `${AUTH_DIR}/actions/accept-invite.ts`,
      contents: acceptInviteSource(),
      exercise: off('acceptInvite', 'needs a live mailed token; the pass draws one nobody issued'),
    },
    { path: `${AUTH_DIR}/actions/accept-invite.test.ts`, contents: acceptInviteTest() },
    {
      path: `${AUTH_DIR}/actions/revoke-invite.ts`,
      contents: revokeInviteSource(),
      exercise: off('revokeInvite', 'removes a member; the pass holds no actor in an org'),
    },
    { path: `${AUTH_DIR}/actions/revoke-invite.test.ts`, contents: revokeInviteTest() },
    { path: `${AUTH_DIR}/invites/page.tsx`, contents: invitePageSource(module, 'manage') },
    { path: `${AUTH_DIR}/invites/page.test.ts`, contents: invitePageTest(module, 'manage') },
    { path: `${AUTH_DIR}/invites/accept/page.tsx`, contents: invitePageSource(module, 'accept') },
    {
      path: `${AUTH_DIR}/invites/accept/page.test.ts`,
      contents: invitePageTest(module, 'accept'),
    },
    { path: `${AUTH_DIR}/invites/page.module.scss`, contents: STYLE },
    // Every action above imports `../auth`; an app from before `x new` wrote it gets it here.
    { path: `${AUTH_DIR}/auth.ts`, contents: authModule(), merge: 'if-absent' },
    ...options.locales.map((locale) => ({
      path: catalogPath(locale),
      contents: catalogJson(INVITE_CATALOG),
      merge: 'json' as const,
    })),
  ];
}

const STYLE = `// Semantic tokens only: a raw colour here is refused by guards/raw-colour.ts.
@use '@ultimat3/ui/tokens' as tokens;

.page {
  display: grid;
  gap: tokens.space(4);
  max-width: 28rem;
  margin-inline: auto;
  padding: tokens.space(6);
  color: tokens.role('fg');
}
`;
