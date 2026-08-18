/**
 * Cron expression parsing: field grammar (lists, ranges, steps, names, macros) into the
 * normalized `CronExpression` shape the occurrence and description modules consume.
 */

import { cronInvalid } from './errors';

export interface CronExpression {
  /** The normalized source text. */
  source: string;
  seconds: readonly number[];
  minutes: readonly number[];
  hours: readonly number[];
  daysOfMonth: readonly number[];
  months: readonly number[];
  /** ISO weekdays, 1 = Monday … 7 = Sunday (cron's 0 and 7 both mean Sunday). */
  daysOfWeek: readonly number[];
  /** Vixie semantics: when both day fields are restricted, either one matching is a hit. */
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}

const MACROS: Readonly<Record<string, string>> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const MONTH_NAMES = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Parse 5 fields (`m h dom mon dow`) or 6 with a leading seconds field. */
export function parseCron(expression: string): CronExpression {
  const trimmed = expression.trim().toLowerCase();
  const expanded = MACROS[trimmed] ?? trimmed;
  const fields = expanded.split(/\s+/).filter((field) => field !== '');

  if (fields.length !== 5 && fields.length !== 6) {
    throw cronInvalid(expression, `expected 5 or 6 fields, got ${fields.length}`);
  }
  const withSeconds = fields.length === 6;
  const [secondField, minuteField, hourField, domField, monthField, dowField] = withSeconds
    ? fields
    : ['0', ...fields];

  const seconds = parseField(expression, secondField ?? '0', 0, 59);
  const minutes = parseField(expression, minuteField ?? '*', 0, 59);
  const hours = parseField(expression, hourField ?? '*', 0, 23);
  const daysOfMonth = parseField(expression, domField ?? '*', 1, 31);
  const months = parseField(expression, monthField ?? '*', 1, 12, MONTH_NAMES, 1);
  // Span 7, not `max - min + 1` = 8: the dow field accepts 0-7 because Sunday has two spellings,
  // so the modulus a wrap strides over is a week with a phantom day in it unless it is stated.
  const rawDow = parseField(expression, dowField ?? '*', 0, 7, DAY_NAMES, 0, 7);

  // 0 and 7 are both Sunday in cron; ISO calls Sunday 7.
  const daysOfWeek = [...new Set(rawDow.map((day) => (day === 0 ? 7 : day)))].sort((a, b) => a - b);

  return {
    source: expanded,
    seconds,
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    dayOfMonthRestricted: isRestricted(domField ?? '*'),
    dayOfWeekRestricted: isRestricted(dowField ?? '*'),
  };
}

export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

export function parseCronOnce(expression: string | CronExpression): CronExpression {
  return typeof expression === 'string' ? parseCron(expression) : expression;
}

/** True when both day-of-month and day-of-week fields matter and either matching is a hit. */
export function matchesDay(cron: CronExpression, day: number, weekday: number): boolean {
  const domHit = cron.daysOfMonth.includes(day);
  const dowHit = cron.daysOfWeek.includes(weekday);
  if (cron.dayOfMonthRestricted && cron.dayOfWeekRestricted) return domHit || dowHit;
  if (cron.dayOfMonthRestricted) return domHit;
  if (cron.dayOfWeekRestricted) return dowHit;
  return true;
}

function parseField(
  expression: string,
  field: string,
  min: number,
  max: number,
  names: readonly string[] = [],
  nameOffset = 0,
  /**
   * How many distinct values one full turn of this field has — `max - min + 1` for every field
   * whose spelling is one-to-one. Day-of-week is the exception and the reason this is a parameter:
   * it spells Sunday twice (0 and 7), so its 0-7 bounds describe 8 slots over a 7-day week, and a
   * wrapping stride computed from the bounds walked a day that does not exist.
   */
  span = max - min + 1,
): number[] {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    if (part === '') throw cronInvalid(expression, `empty list item in "${field}"`);
    const [rangePart, stepPart] = part.split('/');
    if (rangePart === undefined || (part.includes('/') && stepPart === undefined)) {
      throw cronInvalid(expression, `malformed step in "${part}"`);
    }
    const step = stepPart === undefined ? 1 : parseInteger(stepPart);
    if (step === undefined || step < 1) {
      throw cronInvalid(expression, `step must be a positive integer in "${part}"`);
    }

    let from: number;
    let to: number;
    if (isWildcard(rangePart)) {
      from = min;
      to = max;
    } else if (rangePart.includes('-')) {
      const [left, right] = rangePart.split('-');
      from = toNumber(expression, left, min, max, names, nameOffset);
      to = toNumber(expression, right, min, max, names, nameOffset);
    } else {
      from = toNumber(expression, rangePart, min, max, names, nameOffset);
      to = stepPart === undefined ? from : max;
    }

    if (from > to) {
      // Wrapping ranges (`fri-mon`, `22-2`) are a real cron idiom, and the stride CONTINUES across
      // the wrap: `23-3/2` is 23, 01, 03 — every second hour starting at 23. Restarting at `min`
      // answered 23, 00, 02, an hour off for every occurrence past midnight.
      const length = to - from + span;
      for (let offset = 0; offset <= length; offset += step) {
        values.add(min + ((from - min + offset) % span));
      }
    } else {
      for (let value = from; value <= to; value += step) values.add(value);
    }
  }
  if (values.size === 0) throw cronInvalid(expression, `field "${field}" matches nothing`);
  return [...values].sort((a, b) => a - b);
}

function toNumber(
  expression: string,
  token: string | undefined,
  min: number,
  max: number,
  names: readonly string[],
  nameOffset: number,
): number {
  if (token === undefined || token === '') throw cronInvalid(expression, 'missing value');
  // Names match on their first three letters, so `mon` and `monday` both work — but a token
  // carrying anything that is not a letter is a typo, not a name, and falls through to digits.
  const named = /^[a-z]+$/.test(token) ? names.indexOf(token.slice(0, 3)) : -1;
  const value = named === -1 ? parseInteger(token) : named + nameOffset;
  if (value === undefined) {
    throw cronInvalid(expression, `"${token}" is not a number or a name`);
  }
  if (value < min || value > max) {
    throw cronInvalid(expression, `"${token}" is out of range ${min}-${max}`);
  }
  return value;
}

/**
 * Digits only. `Number.parseInt('5x')` is 5, which would let `* * * * 5x` validate — a
 * validator that accepts what the scheduler cannot mean hides the typo until it misfires.
 */
function parseInteger(token: string): number | undefined {
  return /^\d+$/.test(token) ? Number.parseInt(token, 10) : undefined;
}

function isWildcard(field: string): boolean {
  const [head] = field.split('/');
  return head === '*' || head === '?';
}

/** `*` and `?` are "any"; a step like every-2nd-day restricts, and Vixie's OR rule sees that. */
function isRestricted(field: string): boolean {
  return field !== '*' && field !== '?';
}
