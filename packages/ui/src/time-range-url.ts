// A time window in the URL — a preset id, or a custom `from`/`to` as wall-clock times in an
// explicit IANA zone — read leniently and written as hrefs. It composes `listUrl`, so "keep every
// other parameter, drop the cursor" is that module's one rule. Pure: no DOM, no router, no clock.

import { renderCauseValue } from '@ultimat3/core';
import {
  assertTimeZone,
  fromIso,
  fromZoned,
  type Instant,
  instant,
  isPlainDate,
  type TimeZone,
  toZoned,
} from '@ultimat3/time';
import { invalidValueError, UI_ERROR_CODES, UiError } from './errors';
import { listUrl } from './list-url';

/** One window the app offers. The list and its words are the app's; none ships (axiom 8). */
export interface TimeRangePreset {
  readonly id: string;
  /** Already-translated. */
  readonly label: string;
  /** A window ending at `now`, this many seconds long. */
  readonly seconds?: number | undefined;
  /** A fixed window, as ISO instants with an offset. */
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

export interface TimeRangeUrlOptions {
  readonly presets: readonly TimeRangePreset[];
  /** The preset id shown when the URL names none, or names one that is not valid. */
  readonly default: string;
  /** Prefixes every parameter, for two windows on one page. */
  readonly ns?: string | undefined;
  /** The zone a custom `from`/`to` is wall-clock time in. Required: there is no ambient one. */
  readonly timeZone: TimeZone;
  /** Where a `seconds` preset ends — the caller's clock, read once per request. */
  readonly now: Date;
}

export type TimeRangeChange =
  | { readonly preset: string }
  | { readonly from: Date; readonly to: Date };

export interface TimeRangeUrl {
  /** The preset shown; `undefined` for a custom window. */
  readonly preset: string | undefined;
  readonly from: Instant;
  readonly to: Instant;
  /** The URL asked for a window that is malformed, backwards or unknown, and got the default. */
  readonly invalid: boolean;
  /** `from` and `to` as `datetime-local` values in `timeZone`: a custom form's defaults. */
  readonly local: { readonly from: string; readonly to: string };
  /** The parameter names, `ns`-prefixed: a GET form's field names. */
  readonly names: { readonly preset: string; readonly from: string; readonly to: string };
  /** Every other parameter, cursor dropped: what a GET form must carry as hidden inputs. */
  readonly hidden: readonly (readonly [string, string])[];
  /** The URL's path: a GET form's `action`. */
  readonly action: string;
  readonly presets: readonly TimeRangePreset[];
  readonly timeZone: TimeZone;
  /** The page under `change`, every other parameter kept, every cursor dropped. */
  href(change: TimeRangeChange): string;
}

const BASE = 'http://range.invalid';
const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

function invalidPreset(preset: TimeRangePreset, why: string): UiError {
  return new UiError({
    code: UI_ERROR_CODES.invalidValue,
    cause: `timeRangeUrl preset ${renderCauseValue(preset.id)} ${why}`,
    fix: "presets: [{ id: 'day', label: labels.day, seconds: 86_400 }]   # each preset: seconds > 0, or an ISO from before an ISO to",
  });
}

/** A preset's window at `now`. Neither `seconds` nor `from`/`to` is refused at construction. */
function presetWindow(preset: TimeRangePreset, now: Instant): { from: Instant; to: Instant } {
  if (preset.seconds !== undefined) {
    if (!Number.isFinite(preset.seconds) || preset.seconds <= 0) {
      throw invalidPreset(preset, `has seconds ${String(preset.seconds)}, not a length above 0`);
    }
    return { from: instant(new Date(now.getTime() - preset.seconds * 1000)), to: now };
  }
  if (preset.from === undefined || preset.to === undefined) {
    throw invalidPreset(preset, 'has neither seconds nor both from and to');
  }
  const from = fromIso(preset.from);
  const to = fromIso(preset.to);
  if (to.getTime() <= from.getTime()) throw invalidPreset(preset, 'ends before it starts');
  return { from, to };
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** `YYYY-MM-DDTHH:mm` in `zone`: what `<input type="datetime-local">` holds. */
export function toLocalDateTime(at: Instant, zone: TimeZone): string {
  const wall = toZoned(at, zone);
  return `${String(wall.year).padStart(4, '0')}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}`;
}

/** A `datetime-local` value in `zone` as an instant; `undefined` for anything not one. */
export function fromLocalDateTime(raw: string | null, zone: TimeZone): Instant | undefined {
  const match = raw === null ? null : WALL.exec(raw);
  if (match === null) return undefined;
  const [, year, month, day, rawHour, rawMinute, rawSecond] = match;
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  const second = rawSecond === undefined ? 0 : Number(rawSecond);
  if (!isPlainDate(`${String(year)}-${String(month)}-${String(day)}`)) return undefined;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  // A wall time a spring-forward skipped resolves to the instant just after the gap.
  return fromZoned(
    { year: Number(year), month: Number(month), day: Number(day), hour, minute, second },
    zone,
  );
}

export function timeRangeUrl(url: URL | string, options: TimeRangeUrlOptions): TimeRangeUrl {
  const zone = assertTimeZone(options.timeZone);
  const now = instant(options.now);
  const presets = new Map<string, TimeRangePreset>();
  for (const preset of options.presets) {
    if (presets.has(preset.id)) throw invalidPreset(preset, 'is declared twice');
    presetWindow(preset, now);
    presets.set(preset.id, preset);
  }
  const fallback = presets.get(options.default);
  if (fallback === undefined) {
    throw invalidValueError('timeRangeUrl default', options.default, 'the id of one of presets');
  }
  const name = (param: string): string =>
    options.ns === undefined ? param : `${options.ns}.${param}`;
  const names = { preset: name('range'), from: name('from'), to: name('to') };
  const parsed = new URL(url, BASE);
  const params = parsed.searchParams;

  const rawFrom = params.get(names.from);
  const rawTo = params.get(names.to);
  const rawPreset = params.get(names.preset);
  let preset: string | undefined = fallback.id;
  let window = presetWindow(fallback, now);
  let invalid = false;
  if (rawFrom !== null || rawTo !== null) {
    const from = fromLocalDateTime(rawFrom, zone);
    const to = fromLocalDateTime(rawTo, zone);
    if (from !== undefined && to !== undefined && to.getTime() > from.getTime()) {
      preset = undefined;
      window = { from, to };
    } else invalid = true;
  } else if (rawPreset !== null) {
    const named = presets.get(rawPreset);
    if (named === undefined) invalid = true;
    else {
      preset = named.id;
      window = presetWindow(named, now);
    }
  }

  // `listUrl` owns "every other parameter kept, every cursor dropped"; this only adds its own.
  const base = new URL(listUrl(parsed, { sorts: [], ns: options.ns }).href({}), BASE);
  for (const param of Object.values(names)) base.searchParams.delete(param);
  const write = (edit: (next: URLSearchParams) => void): string => {
    const next = new URLSearchParams(base.searchParams);
    edit(next);
    const search = next.toString();
    return search === '' ? base.pathname : `${base.pathname}?${search}`;
  };

  return {
    preset,
    from: window.from,
    to: window.to,
    invalid,
    local: { from: toLocalDateTime(window.from, zone), to: toLocalDateTime(window.to, zone) },
    names,
    hidden: [...base.searchParams.entries()],
    action: base.pathname,
    presets: options.presets,
    timeZone: zone,
    href: (change) =>
      write((next) => {
        if ('preset' in change) {
          if (!presets.has(change.preset)) {
            throw invalidValueError(
              'timeRangeUrl href preset',
              change.preset,
              'the id of one of presets',
            );
          }
          if (change.preset !== fallback.id) next.set(names.preset, change.preset);
          return;
        }
        next.set(names.from, toLocalDateTime(instant(change.from), zone));
        next.set(names.to, toLocalDateTime(instant(change.to), zone));
      }),
  };
}
