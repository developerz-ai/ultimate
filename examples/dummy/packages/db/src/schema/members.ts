/**
 * A person inside an org. Carries the two preferences the whole app reads at the edge:
 * `tz` (every timestamp, and the digest's delivery hour) and `locale` (every string).
 */

import { MEMBER_ROLES, SUPPORTED_LOCALES, SUPPORTED_ZONES, THEMES } from '@postly/domain';
import {
  boolean,
  entity,
  enumerated,
  invariant,
  locale,
  text,
  timestamp,
  tz,
  uuid,
} from '@ultimat3/entity';
import { orgs } from './orgs';

export const members = entity('members', {
  columns: {
    id: uuid().primaryKey(),
    orgId: uuid()
      .references(() => orgs.id, { onDelete: 'cascade' })
      .tenant(),
    /** Better Auth owns identity; membership is ours. One user may belong to several orgs. */
    userId: uuid(),
    email: text({ max: 254 }),
    name: text({ max: 80 }),
    role: enumerated(MEMBER_ROLES).default('author'),
    /** IANA zone. Never a UTC offset — an offset is wrong twice a year. */
    tz: tz(SUPPORTED_ZONES).default('UTC'),
    locale: locale(SUPPORTED_LOCALES).default('en'),
    /** Preference, not a device setting: the same person gets the same theme on every device. */
    theme: enumerated(THEMES).default('system'),
    digestOptIn: boolean().default(true),
    createdAt: timestamp().defaultNow(),
  },
  invariants: (c) => [
    invariant('member_email_shape', c.email.contains('@')),
    /** One membership per user per org: the uniqueness makes `inviteMember` replay-safe. */
    invariant('member_unique_per_org', c.unique(['orgId', 'userId'])),
  ],
  indexes: [
    { on: ['orgId', 'role'] },
    /** The digest walks members by zone, so the scheduler reads one index, not a table scan. */
    { on: ['tz'], where: (c) => c.digestOptIn.isTrue() },
  ],
});

export type Member = typeof members.$row;
