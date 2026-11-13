/**
 * Who a browser with no session is under `x dev`: a viewer named by a cookie, declared here. Postly
 * signs in with GitHub, SAML and passkeys (`./authenticator.ts` resolves the session they mint), and
 * none of them works on a fresh clone with no client id, no IdP and no enrolled key — so without this
 * the reference app could not be looked at. `./authenticator.ts` asks it ONLY when the request
 * carries no session cookie and ONLY in `development`; a session always wins.
 */

import { seatLimit } from '@postly/domain';
import { type Actor, readCookie } from '@ultimat3/core';
import { seedId } from '@ultimat3/entity';
import { postlyActor } from '../../shared/actor';
import type { MemberView, OrgView } from '../orgs/entity';

/** Set it to any name in `DEMO_MEMBER_NAMES` to look as that member; unset means the default. */
export const DEMO_MEMBER_COOKIE = 'postly_demo_member';

export const DEMO_MEMBER_NAMES = ['ada', 'bruno', 'kenji', 'mara'] as const;

/**
 * The cookie's value after "Sign out": nobody. Anything else unknown still reads as the default
 * member — this one value is the demo session ENDED, and the request is anonymous.
 */
export const DEMO_SIGNED_OUT = 'signed-out';

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
  // Acme's author in Madrid, writing in Spanish — the seeded member whose zone AND locale differ from
  // the server's, which is what `offline-feed.e2e.test.ts`'s "dates in the member's zone" signs in as.
  bruno: {
    org: ACME,
    member: {
      id: seedId('member:bruno'),
      orgId: ACME.id,
      email: 'bruno@acme.example',
      name: 'Bruno Salas',
      role: 'author',
      tz: 'Europe/Madrid',
      locale: 'es',
      // The seed sets no theme, so this is the column's own default and not a preference.
      theme: 'system',
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

/**
 * The viewer a cookie header names — or nobody, once "Sign out" set the cookie to `DEMO_SIGNED_OUT`.
 * `postlyActor` carries the member's saved `locale` and `tz`; the pipeline's auth stage does the
 * rest, so no preference is resolved here.
 */
export const demoAuthenticate = (cookieHeader: string | null): Actor | null =>
  readCookie(cookieHeader, DEMO_MEMBER_COOKIE) === DEMO_SIGNED_OUT
    ? null
    : demoActorFor(demoMemberFrom(cookieHeader));
