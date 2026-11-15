// The statement `x drill roll-before-migrate` hands its fleet: the framework schema stamp rewound
// to name one older build only, so every serving role this build starts meets a schema behind it.
// Here and not in `@ultimat3/testing`: the stamp is this package's (`framework-schema-stamp.ts`).

import { literal } from '@ultimat3/db';
import { nextStamp, STAMP_RELATION } from './framework-schema-stamp';

/** No build's DDL hashes to this, so the stamp names a build this one is not. */
const OLDER_SCHEMA = '0000000000000000';

/** A version before `version`: the previous minor, else the previous patch, else the last major. */
export function olderVersion(version: string): string {
  const [major = 0, minor = 0, patch = 0] = version
    .split(/[.+-]/)
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
  if (minor > 0) return `${String(major)}.${String(minor - 1)}.0`;
  if (patch > 0) return `${String(major)}.0.${String(patch - 1)}`;
  return `${String(Math.max(major - 1, 0))}.0.0`;
}

/** The statement that leaves the stamp naming only a build older than `version`. */
export const behindStampSql = (version: string): string =>
  `comment on table ${STAMP_RELATION} is ${
    literal(nextStamp(null, { version: olderVersion(version), schema: OLDER_SCHEMA })).text
  }`;
