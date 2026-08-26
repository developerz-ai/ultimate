/**
 * The X_* error codes owned by @ultimat3/time.
 * DST ambiguity is a real state of the world, so it gets a code instead of a guess.
 *
 * `X_LOCALE_INVALID` is NOT here: it moved to `@ultimat3/core` beside `assertLocale`, because
 * `@ultimat3/money` needs the same screen and tier 1 may not import sideways. A code has exactly
 * one declaration — a second `registerErrorCodes` claim is `X_ERROR_CODE_DUPLICATE`.
 */

import { registerErrorCodes, renderCauseValue, UltimateError } from '@ultimat3/core';

export const TIME_ERROR_CODES = [
  'X_TIMEZONE_INVALID',
  'X_CRON_INVALID',
  'X_DURATION_INVALID',
  'X_DST_AMBIGUOUS',
  'X_DST_NONEXISTENT',
  'X_INSTANT_INVALID',
  'X_SCHEDULE_INVALID',
  'X_CRON_NOT_DESCRIBABLE',
] as const;

export type TimeErrorCode = (typeof TIME_ERROR_CODES)[number];

export const TIME_ERROR_TITLES: Readonly<Record<TimeErrorCode, string>> = {
  X_TIMEZONE_INVALID: 'not an IANA zone',
  X_CRON_INVALID: 'not a parseable cron expression',
  X_DURATION_INVALID: 'not a parseable duration',
  X_DST_AMBIGUOUS: 'the local time occurs twice',
  X_DST_NONEXISTENT: 'the local time does not exist',
  X_INSTANT_INVALID: 'not a parseable instant',
  X_SCHEDULE_INVALID: 'a wall-clock field is out of range',
  X_CRON_NOT_DESCRIBABLE: 'a valid cron expression describeCron has no vocabulary for',
};

// Titles must be registered for `format()` to render the contract's first line. Every code above is
// owned here and none is borrowed, so the call is unconditional: a second package claiming one has
// to fail as X_ERROR_CODE_DUPLICATE, not quietly keep whichever title was registered first.
registerErrorCodes(
  Object.fromEntries(Object.entries(TIME_ERROR_TITLES).map(([code, title]) => [code, { title }])),
);

export class TimeError extends UltimateError {
  constructor(init: { code: TimeErrorCode; cause: string; fix: string }) {
    super({
      code: init.code,
      cause: init.cause,
      fix: init.fix,
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
    // `value` is whatever a caller put in a `LocalSlot` — this factory is exported, so it is a form
    // field or a config value as often as it is the `number` the in-package caller passes.
    cause: `${field} must be ${range}, got ${renderCauseValue(value)}`,
    fix: `pass an integer in ${range} for ${field} — wall-clock fields are not wrapped or clamped, because a silently shifted schedule is worse than a failed one`,
  });
}

/**
 * Two refused classes, and they need different instructions — one `fix:` that only described the
 * abbreviations left an operator holding `"Japan"` reading advice about `CET`. A legacy single-label
 * link has a mechanical replacement; an abbreviation has none, and saying so IS the instruction.
 */
export function timezoneInvalid(zone: string): TimeError {
  return new TimeError({
    code: 'X_TIMEZONE_INVALID',
    cause: `"${zone}" is not an IANA Area/Location zone name`,
    fix: "use Area/Location, or UTC. A single-label legacy name swaps mechanically — Japan → Asia/Tokyo, GB → Europe/London, Universal → UTC. An abbreviation or a numeric offset does not: CET and EST5EDT name no jurisdiction and carry no DST rule, so name the city whose clock you mean (Europe/Paris, America/New_York). Every accepted name: Intl.supportedValuesOf('timeZone')",
  });
}

export function cronInvalid(expression: string, reason: string): TimeError {
  return new TimeError({
    code: 'X_CRON_INVALID',
    cause: `cron "${expression}": ${reason}`,
    fix: "use 5 fields (m h dom mon dow) or 6 with seconds, e.g. '0 3 * * *' for 03:00 daily, '*/15 * * * *' every 15 minutes, '0 9 * * MON-FRI' weekday mornings",
  });
}

/**
 * The expression parses and schedules correctly — `describeCron` just cannot put it into words.
 * Separate from `X_CRON_INVALID`, which is a typo: this one is a valid schedule, and telling the
 * caller to fix their cron would be telling them to break a working task.
 */
export function cronNotDescribable(cron: {
  source: string;
  seconds: readonly number[];
}): TimeError {
  return new TimeError({
    code: 'X_CRON_NOT_DESCRIBABLE',
    cause: `cron "${cron.source}" fires on second ${cron.seconds.join(',')}, and CronPhrases has no seconds vocabulary`,
    fix: `render the real runs instead of a summary — nextCronOccurrences('${cron.source}', zone, from, 3) — or, if second-level precision is not wanted, describe the 5-field schedule describeCron('${cron.source.split(/\s+/).slice(1).join(' ')}', locale, phrases)`,
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

export function instantInvalid(input: string): TimeError {
  return new TimeError({
    code: 'X_INSTANT_INVALID',
    cause: `"${input}" is not a valid instant`,
    fix: 'pass an ISO-8601 timestamp with an offset or Z, e.g. 2026-03-14T09:00:00Z',
  });
}
