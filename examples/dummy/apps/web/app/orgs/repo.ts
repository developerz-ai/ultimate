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
}): Promise<MemberView> => db.members.insert(row).returning();

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

/** The scheduler's view: every opted-in member in every org, ordered for deterministic batching. */
export const allDigestRecipients = (): Promise<MemberView[]> =>
  db.members.where({ digestOptIn: true }).orderBy('orgId', 'id').all();
