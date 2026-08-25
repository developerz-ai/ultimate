/** Every SQL statement the orgs feature runs. No rules, no formatting, no HTTP. */

import { db, type Member, type Org } from '@postly/db';
import type {
  AppLocale,
  AppTheme,
  AppZone,
  MemberId,
  MemberRole,
  OrgId,
  PlanCode,
} from '@postly/domain';
import { serviceActor, withChildContext } from '@ultimat3/core';
import { CROSS_TENANT_SCOPE, crossTenant } from '@ultimat3/entity';

/**
 * The org as STORED, which is not `OrgView`: `seats` and `seatsUsed` are derived — one from the
 * plan catalog, one from a second statement — and a repo that claimed to return them was claiming
 * to return two columns no `orgs` row has. `service.ts` is where the two are added, and it already
 * did; only the type here disagreed.
 */
export const orgById = (orgId: OrgId): Promise<Org | null> => db.orgs.where({ id: orgId }).one();

export const memberCount = (orgId: OrgId): Promise<number> => db.members.where({ orgId }).count();

export const memberById = (orgId: OrgId, id: MemberId): Promise<Member | null> =>
  db.members.where({ orgId, id }).one();

export const insertMember = (row: {
  orgId: OrgId;
  userId: string;
  email: string;
  name: string;
  role: MemberRole;
  tz: AppZone;
  locale: AppLocale;
  // `insert` RESOLVES with the stored row — there is no `.returning()` anywhere on this layer.
  // `db.members.insert(row).returning()` was a `TypeError` on the first invite this app ever ran.
}): Promise<Member> => db.members.insert(row);

/**
 * `update(id, patch)` resolves with the stored row, so there is nothing to chain onto it, and the
 * tenant rides in the OPTIONS (`{ orgId }`) rather than in a `where` — `posts/repo.ts` has written
 * it that way all along. It was `db.orgs.where({ id }).update({ planCode }).returning()`: a
 * `ReadBuilder` has no `update`, and nothing in `@ultimat3/entity` has a `returning` at all, so
 * this line and `updatePreferences` below it were both a `TypeError` on their first call.
 * `orgs` carries no tenant column — it IS the tenant — so this one names no org option.
 */
export const setPlan = (orgId: OrgId, planCode: PlanCode): Promise<Org> =>
  db.orgs.update(orgId, { planCode });

export const updatePreferences = (
  orgId: OrgId,
  memberId: MemberId,
  values: { tz?: AppZone; locale?: AppLocale; theme?: AppTheme; digestOptIn?: boolean },
): Promise<Member> => db.members.update(memberId, values, { orgId });

/** Everyone who asked for mail. The partial index on `tz` is what makes this cheap. */
export const digestRecipients = (orgId: OrgId): Promise<readonly Member[]> =>
  db.members.where({ orgId, digestOptIn: true }).orderBy('id').all();

/**
 * Who this read is, and it is not the worker: a job's actor carries the org its `tenant` declared,
 * and the digest fan-out declares none. `crossTenant` refuses an actor that cannot prove
 * `tenancy:cross`, so the sweep names itself — which is what puts an identity on the one read in
 * Postly that crosses orgs instead of leaving it ambient.
 */
const digestSweeper = serviceActor({ id: 'digest-fanout', scopes: [CROSS_TENANT_SCOPE] });

/**
 * The scheduler's view: every opted-in member in every org, ordered for deterministic batching.
 *
 * The ONE statement in this app that spans tenants, and the scope is written here rather than in
 * `sendDigest` because the argument belongs on the read it defends. `members` is tenant-scoped, so
 * without it this is `X_TENANCY_ACTOR_ORG_REQUIRED` — the fan-out has no single org by definition.
 * `withChildContext` and not a context of its own: the run's `requestId` and trace carry through,
 * which is what makes a cross-tenant read auditable back to the digest that asked for it.
 */
export const allDigestRecipients = (): Promise<readonly Member[]> =>
  withChildContext({ actor: digestSweeper }, () =>
    crossTenant(
      'the nightly digest schedules one delivery per (org, zone), so its recipient read spans every org',
      // One `orderBy` per key: the second argument is the DIRECTION, so `orderBy('orgId', 'id')`
      // asked for `order by orgId id`, which is not a sort and is not the total order this sweep's
      // batching depends on.
      () => db.members.where({ digestOptIn: true }).orderBy('orgId').orderBy('id').all(),
    ),
  );
