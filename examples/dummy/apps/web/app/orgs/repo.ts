/** Every SQL statement the orgs feature runs. No rules, no formatting, no HTTP. */

import { db } from '@postly/db';
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
import type { MemberView, OrgView } from './entity';

export const orgById = (orgId: OrgId): Promise<OrgView | null> =>
  db.orgs.where({ id: orgId }).one();

export const memberCount = (orgId: OrgId): Promise<number> => db.members.where({ orgId }).count();

export const memberById = (orgId: OrgId, id: MemberId): Promise<MemberView | null> =>
  db.members.where({ orgId, id }).one();

export const insertMember = (row: {
  orgId: OrgId;
  userId: string;
  email: string;
  name: string;
  role: MemberRole;
  tz: AppZone;
  locale: AppLocale;
  // `insert` RESOLVES with the stored row — there is no `.returning()` on a write of one row, and
  // `db.members.insert(row).returning()` was a `TypeError` on the first invite this app ever ran.
  // `update(...).returning()` below is a different builder and is correct.
}): Promise<MemberView> => db.members.insert(row);

export const setPlan = (orgId: OrgId, planCode: PlanCode): Promise<OrgView> =>
  db.orgs.where({ id: orgId }).update({ planCode }).returning();

export const updatePreferences = (
  orgId: OrgId,
  memberId: MemberId,
  values: { tz?: AppZone; locale?: AppLocale; theme?: AppTheme; digestOptIn?: boolean },
): Promise<MemberView> => db.members.where({ orgId, id: memberId }).update(values).returning();

/** Everyone who asked for mail. The partial index on `tz` is what makes this cheap. */
export const digestRecipients = (orgId: OrgId): Promise<MemberView[]> =>
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
export const allDigestRecipients = (): Promise<MemberView[]> =>
  withChildContext({ actor: digestSweeper }, () =>
    crossTenant(
      'the nightly digest schedules one delivery per (org, zone), so its recipient read spans every org',
      () => db.members.where({ digestOptIn: true }).orderBy('orgId', 'id').all(),
    ),
  );
