import { t } from '@ultimat3/jobs';

/**
 * An instant on the wire is an ISO-8601 string, not a `Date`. The queue round-trips input through
 * JSON, so a `Date` input would reach `idempotencyKeyFor` as a `Date` on the enqueue side and as a
 * string on the replay side — two spellings of one key, which is no key at all.
 */
export const instant = t.string;

/** An occurrence's instant as the ISO-8601 string `instant` reads. */
export const iso = (ms: number): string => new Date(ms).toISOString();
