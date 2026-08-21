/**
 * Who a browser is on a laptop, while Postly can issue no session of its own.
 *
 * `login.ts`'s two OAuth descriptors are declared and not served and `BuiltinAdapter`'s tables have
 * no migration, so this app configured no authenticator at all — and `hooks.authenticate` is the
 * only place an actor can come from, so every `app/` route answered 401 (`X_CONFIG_INVALID` at
 * boot) and the reference app could not be looked at. This is the stand-in and only that: a viewer
 * named by a cookie, declared here, installed in `development` and nowhere else.
 */

import { seatLimit } from '@postly/domain';
import { type Actor, logger, tryResolveEnvironment } from '@ultimat3/core';
import { seedId } from '@ultimat3/entity';
import type { RequestContext, UltimateRequest } from '@ultimat3/http';
import { configureAuthenticator, readCookie } from '@ultimat3/http';
import { postlyActor } from '../../shared/actor';
import type { MemberView, OrgView } from '../orgs/entity';

/** Set it to any name in `DEMO_MEMBER_NAMES` to look as that member; unset means the default. */
export const DEMO_MEMBER_COOKIE = 'postly_demo_member';

export const DEMO_MEMBER_NAMES = ['ada', 'kenji', 'mara'] as const;

export type DemoMemberName = (typeof DEMO_MEMBER_NAMES)[number];

/** Acme's owner: the tenant the seed fills with posts, likes and comments. */
export const DEFAULT_DEMO_MEMBER: DemoMemberName = 'ada';

export interface DemoViewer {
  readonly member: MemberView;
  readonly org: OrgView;
}

/** `seats` is the plan's, never a column — the same derivation `ctx.orgs.byId` performs. */
const orgViewFor = (label: string, values: Omit<OrgView, 'id' | 'seats'>): OrgView => ({
  ...values,
  id: seedId(label),
  seats: seatLimit(values.planCode),
});

const ACME: OrgView = orgViewFor('org:acme', {
  slug: 'acme',
  name: 'Acme Editorial',
  planCode: 'team',
  billingCurrency: 'USD',
  seatsUsed: 3,
});

const TINTA: OrgView = orgViewFor('org:tinta', {
  slug: 'tinta',
  name: 'Tinta Studio',
  planCode: 'free',
  billingCurrency: 'EUR',
  seatsUsed: 2,
});

/**
 * Three viewers, two tenants: an owner who holds every grant, a reader who holds none of the write
 * ones — so `useCan('post:publish')` has something to hide — and the second org, in the second
 * locale, on the second currency.
 *
 * Ids are DERIVED: `seedId(label)` is the same v5 uuid `packages/db/seeds/dev.ts` writes, and the
 * ids are the half that has to be right, because they join to the seeded posts and likes the moment
 * this process reads a store holding them. The display columns beside them are restated, and
 * `demo-actor.test.ts` pins every one against the seed's own rows — so a column edited there fails
 * this app's `unit` step instead of rendering a stale name in dev.
 *
 * Declared rather than read back, because a viewer has to resolve on a database nobody has seeded,
 * which is every fresh clone: an authenticator that needed rows first would reproduce the 401 it
 * exists to remove.
 */
export const DEMO_VIEWERS = Object.freeze<Record<DemoMemberName, DemoViewer>>({
  ada: {
    org: ACME,
    member: {
      id: seedId('member:ada'),
      orgId: ACME.id,
      email: 'ada@acme.example',
      name: 'Ada Okonjo',
      role: 'owner',
      tz: 'America/New_York',
      locale: 'en',
      theme: 'dark',
      digestOptIn: true,
    },
  },
  kenji: {
    org: ACME,
    member: {
      id: seedId('member:kenji'),
      orgId: ACME.id,
      email: 'kenji@acme.example',
      name: 'Kenji Mori',
      role: 'reader',
      tz: 'Asia/Tokyo',
      locale: 'en',
      // The seed sets no theme, so this is the column's own default and not a preference.
      theme: 'system',
      digestOptIn: false,
    },
  },
  mara: {
    org: TINTA,
    member: {
      id: seedId('member:mara'),
      orgId: TINTA.id,
      email: 'mara@tinta.example',
      name: 'Mara Ferrer',
      role: 'owner',
      tz: 'Pacific/Auckland',
      locale: 'es',
      theme: 'light',
      digestOptIn: true,
    },
  },
});

/** `readCookie` answers `null` for an absent cookie; the guard takes that arm rather than a cast. */
const isDemoMemberName = (value: string | null): value is DemoMemberName =>
  value !== null && (DEMO_MEMBER_NAMES as readonly string[]).includes(value);

/**
 * An unknown cookie value falls back rather than refusing: the cookie is a viewing convenience, and
 * a typo that resolved nobody would reproduce the 401 this module exists to remove.
 */
export const demoMemberFrom = (cookieHeader: string | null): DemoMemberName => {
  const named = readCookie(cookieHeader, DEMO_MEMBER_COOKIE);
  return isDemoMemberName(named) ? named : DEFAULT_DEMO_MEMBER;
};

/**
 * `postlyActor` and never a literal: the roster's role becomes the permission set through the one
 * constructor every fixture already goes through, so a page gated on `member:self` is gated here by
 * exactly the rule that gates it in production.
 */
export const demoActorFor = (name: DemoMemberName): Actor => postlyActor(DEMO_VIEWERS[name]);

const authenticate = (request: UltimateRequest, _ctx: RequestContext): Actor =>
  demoActorFor(demoMemberFrom(request.header('cookie')));

/**
 * Installs it, and says so. Gated on `development` alone — not `isLocal()`, which is also true
 * under `test`, where every fixture mints its own actor and a second one arriving from a cookie
 * would decide which member a test is about.
 *
 * A deploy therefore still configures nothing and still warns `X_CONFIG_INVALID` at boot, which is
 * correct: this app cannot hold a session yet, and a viewer that followed it to staging would sign
 * every visitor in as the seed's owner.
 */
export function installDemoAuthenticator(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (tryResolveEnvironment({ env }) !== 'development') return false;
  configureAuthenticator(authenticate);
  logger.warn('postly is answering every request as a declared demo viewer', {
    member: DEFAULT_DEMO_MEMBER,
    cause:
      'apps/web/app/auth/demo-actor.ts installs a viewer in development only, because this app mounts no sign-in route',
    fix: `look as someone else: document.cookie = '${DEMO_MEMBER_COOKIE}=mara'`,
  });
  return true;
}

installDemoAuthenticator();
