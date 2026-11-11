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
    /**
     * E.164, for the texts an owner asks for (`quotaAlert`). Nullable because most members never
     * give one, and a member without one is simply not texted — never a placeholder number.
     */
    phone: text({ max: 16 }).nullable().personalData('contact'),
    createdAt: timestamp().defaultNow(),
  },
  invariants: (c) => [
    /**
     * The PATTERN, not `contains('@')`. Both render, but `contains` renders
     * `position('@' in email) > 0` — weaker than the `> 1` this table has enforced since
     * `0001_init.sql:38`, so regenerating on the `contains` form would silently drop the rule
     * that an address has a local part. This spelling implies `> 1` and adds that exactly one
     * `@` is present. No `\s` in it deliberately: JS and Postgres read `\s` differently, and
     * `matches` refuses the constructs where they disagree rather than emitting a lookalike.
     *
     * It is STRICTER than what it replaces, so it can fail on rows the old rule admitted —
     * `a@b@c` and `a@` both satisfy `position('@' in email) > 0`. Every seeded address here is
     * valid, so the generated migration applies clean in this app; on a populated database look
     * first (`select email from members where email !~ '^[^@]+@[^@]+$'`) and fix what it returns,
     * or the `add constraint` fails with `23514`.
     */
    invariant('member_email_shape', c.email.matches(/^[^@]+@[^@]+$/)),
    /** One membership per user per org: the uniqueness makes `inviteMember` replay-safe. */
    invariant('member_unique_per_org', c.unique(['orgId', 'userId'])),
    /**
     * E.164 — `+`, a country code, at most 15 digits — exactly notify's `isSmsNumber`, so a number
     * `savePreferences` accepted is one the CHECK accepts and every SMS transport sends to. A NULL
     * passes, as Postgres' CHECK passes it.
     */
    invariant('member_phone_e164', c.phone.matches(/^\+[1-9][0-9]{1,14}$/)),
  ],
  indexes: [
    { on: ['orgId', 'role'] },
    /** The digest walks members by zone, so the scheduler reads one index, not a table scan. */
    { on: ['tz'], where: (c) => c.digestOptIn.isTrue() },
    /** The nightly fan-out pages every opted-in member across orgs, in (org, id) order. */
    { on: ['digestOptIn', 'orgId', 'id'] },
  ],
});

export type Member = typeof members.$row;
