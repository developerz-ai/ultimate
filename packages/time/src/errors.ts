/**
 * The X_* error codes owned by @ultimat3/time.
 * DST ambiguity is a real state of the world, so it gets a code instead of a guess.
 */

import { hasErrorCode, registerErrorCodes, UltimateError } from '@ultimat3/core';

export const TIME_ERROR_CODES = [
  'X_TIMEZONE_INVALID',
  'X_CRON_INVALID',
  'X_DURATION_INVALID',
  'X_DST_AMBIGUOUS',
  'X_DST_NONEXISTENT',
  'X_INSTANT_INVALID',
  'X_SCHEDULE_INVALID',
  'X_LOCALE_INVALID',
] as const;

export type TimeErrorCode = (typeof TIME_ERROR_CODES)[number];

export const TIME_ERROR_TITLES: Readonly<Record<TimeErrorCode, string>> = {
  X_TIMEZONE_INVALID: 'not an IANA zone',
  X_CRON_INVALID: 'not a parseable cron expression',
  X_DURATION_INVALID: 'not a parseable duration',
  X_DST_AMBIGUOUS: 'the local time occurs twice',
  X_DST_NONEXISTENT: 'the local time does not exist',
  X_INSTANT_INVALID: 'not a parseable instant',
  // Not yet in wiki/Error-Codes.md — derived from scheduleInvalid()'s own doc comment below,
  // since no design doc names X_SCHEDULE_INVALID either.
  X_SCHEDULE_INVALID: 'a wall-clock field is out of range',
  X_LOCALE_INVALID: 'not a well-formed BCP 47 tag',
};

// Titles must be registered for `format()` to render the contract's first line. Guarded
// because registering a code twice throws X_ERROR_CODE_DUPLICATE at import time.
for (const [code, title] of Object.entries(TIME_ERROR_TITLES)) {
  if (!hasErrorCode(code)) registerErrorCodes({ [code]: { title } });
}

export class TimeError extends UltimateError {
  constructor(init: { code: TimeErrorCode; cause: string; fix: string }) {
    super({
      code: init.code,
      cause: init.cause,
      fix: init.fix,
      docs: `https://ultimate.dev/errors/${init.code}`,
    });
  }
}

/**
 * A wall-clock field outside its range. Separate from `X_DST_*`, which are about times that
 * are legitimately absent or doubled — this one is a spec the caller got wrong.
 */
export function scheduleInvalid(field: string, value: unknown, range: string): TimeError {
  return new TimeError({
    code: 'X_SCHEDULE_INVALID',
    cause: `${field} must be ${range}, got ${String(value)}`,
    fix: `pass an integer in ${range} for ${field} — wall-clock fields are not wrapped or clamped, because a silently shifted schedule is worse than a failed one`,
  });
}

export function timezoneInvalid(zone: string): TimeError {
  return new TimeError({
    code: 'X_TIMEZONE_INVALID',
    cause: `"${zone}" is not an IANA timezone name`,
    fix: 'use an IANA identifier such as Europe/Berlin, America/New_York or UTC — never an abbreviation like CET or a numeric offset',
  });
}

export function cronInvalid(expression: string, reason: string): TimeError {
  return new TimeError({
    code: 'X_CRON_INVALID',
    cause: `cron "${expression}": ${reason}`,
    fix: "use 5 fields (m h dom mon dow) or 6 with seconds, e.g. '0 3 * * *' for 03:00 daily, '*/15 * * * *' every 15 minutes, '0 9 * * MON-FRI' weekday mornings",
  });
}

export function durationInvalid(input: string): TimeError {
  return new TimeError({
    code: 'X_DURATION_INVALID',
    cause: `"${input}" is not a duration`,
    fix: "use a unit-suffixed duration: '90s', '2h30m', '3d', '1w', '250ms' — or an ISO-8601 form like 'PT2H30M'",
  });
}

export function dstAmbiguous(wall: string, zone: string): TimeError {
  return new TimeError({
    code: 'X_DST_AMBIGUOUS',
    cause: `${wall} happens twice in ${zone} (the fall-back hour repeats)`,
    fix: "pass { overlap: 'first' } for the pre-transition instant or { overlap: 'second' } for the post-transition one",
  });
}

export function dstNonexistent(wall: string, zone: string): TimeError {
  return new TimeError({
    code: 'X_DST_NONEXISTENT',
    cause: `${wall} never happens in ${zone} (the spring-forward gap skips it)`,
    fix: "pass { gap: 'next' } to shift forward past the gap or { gap: 'previous' } to shift back before it",
  });
}

/**
 * A tag `Intl` cannot parse. Distinct from i18n's `X_LOCALE_UNSUPPORTED`, which is a
 * well-formed tag outside the app's supported set — this one is not a tag at all, and a raw
 * `RangeError` from a formatter says nothing about which caller supplied it.
 */
export function localeInvalid(locale: string): TimeError {
  return new TimeError({
    code: 'X_LOCALE_INVALID',
    cause: `"${locale}" is not a well-formed BCP 47 language tag`,
    fix: "pass a tag like 'en', 'en-GB' or 'de-DE' — screen a header-supplied value with Intl.DateTimeFormat.supportedLocalesOf([tag]) before it reaches a formatter",
  });
}

export function instantInvalid(input: string): TimeError {
  return new TimeError({
    code: 'X_INSTANT_INVALID',
    cause: `"${input}" is not a valid instant`,
    fix: 'pass an ISO-8601 timestamp with an offset or Z, e.g. 2026-03-14T09:00:00Z',
  });
}
