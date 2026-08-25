// A person. Carries the two preferences every surface reads at the edge — `locale` for strings and
// `tz` for every timestamp — because a server that formats in its own zone tells a reader in
// another one the wrong day.

import { HANDLE_RE, MAX_HANDLE, USER_ROLES } from '@social-media-clone/domain';
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

/** The zones the seed uses. One southern-hemisphere and one without DST, on purpose. */
export const SUPPORTED_ZONES = [
  'UTC',
  'America/New_York',
  'Europe/Madrid',
  'Asia/Tokyo',
  'Pacific/Auckland',
] as const;

export const SUPPORTED_LOCALES = ['en', 'es'] as const;

export const users = entity('users', {
  columns: {
    id: uuid().primaryKey(),
    /** The `@name` in the URL. Globally unique, lowercase — a URL differing only in case is two URLs. */
    handle: text({ max: MAX_HANDLE }).unique(),
    email: text({ max: 254 }).unique(),
    displayName: text({ max: 80 }),
    bio: text({ max: 300 }).nullable(),
    /** A storage key, never a URL: the CDN host is deploy configuration, not a column. */
    avatarKey: text({ max: 512 }).nullable(),
    role: enumerated(USER_ROLES).default('member'),
    /** IANA zone, never a UTC offset — an offset is wrong twice a year. */
    tz: tz(SUPPORTED_ZONES).default('UTC'),
    locale: locale(SUPPORTED_LOCALES).default('en'),
    /** Presence of this column is what makes the entity soft-deletable. */
    deletedAt: timestamp().nullable(),
    suspended: boolean().default(false),
    createdAt: timestamp().defaultNow(),
    updatedAt: timestamp().defaultNow().onUpdateNow(),
  },
  invariants: (c) => [
    /**
     * The PATTERN, not `isValidHandle`. A predicate reports `sql: null`, so this table had NO
     * handle constraint in Postgres while the declaration read as though it did. `HANDLE_RE` is
     * inside the subset both engines read identically, so one declaration now feeds both.
     */
    invariant('user_handle_shape', c.handle.matches(HANDLE_RE)),
    invariant('user_email_shape', c.email.contains('@')),
    invariant('user_display_name_present', c.displayName.trimmed().minLength(1)),
  ],
  // The profile lookup is by handle and nothing else, so it gets the index the URL implies.
  indexes: [
    { on: ['handle'], unique: true },
    { on: ['createdAt'], order: 'desc' },
  ],
});

export type User = typeof users.$row;
