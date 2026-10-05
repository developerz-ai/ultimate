// A posted form → the typed input the entity's schema judges. A browser sends strings and omits
// an unchecked box; the row holds a number, a boolean, a Date, a `{ minor, currency }`. This is
// the one place that gap is closed, per WIDGET — the same table that rendered the control.
//
// It converts and never validates: a value that will not convert is passed through as the string
// that was typed, so the schema refuses it in its own words against the field that carried it.

import { numeric } from '@ultimat3/schema';
import type { AdminField } from './fields';
import type { AdminRow } from './registry';
import type { AdminResource } from './resource';

/** The posted name of a money field's currency, beside the minor-unit amount under the field's own. */
export const currencyFieldOf = (field: string): string => `${field}.currency`;

type Posted = Readonly<Record<string, unknown>>;

/**
 * What a date control is RENDERED with: `<input type="date">` wants `YYYY-MM-DD`, `datetime-local`
 * wants `YYYY-MM-DDTHH:mm`. One function for the widget that draws the box and for the decode that
 * reads it back, so "the operator left it as it was" is a comparison of one text with itself.
 */
export const datetimeInputValue = (iso: string, precision: 'date' | 'instant'): string =>
  iso.slice(0, precision === 'date' ? 10 : 16);

const isoOf = (value: unknown): string | undefined =>
  value instanceof Date
    ? Number.isNaN(value.getTime())
      ? undefined
      : value.toISOString()
    : typeof value === 'string'
      ? value
      : undefined;

/**
 * An instant posted back as the box rendered it. `datetime-local` holds minutes, so writing what
 * came back turned `10:20:45.123` into `10:20:00.000` on every edit of ANY field — a change nobody
 * made, recorded in the audit diff as theirs. Such a field is left out of the patch and the stored
 * instant stands. A calendar date carries every digit it has and is never in this position.
 */
const untouchedInstant = (
  field: AdminField,
  raw: string | undefined,
  before: AdminRow,
): boolean => {
  if (field.widget !== 'datetime' || field.type === 'date' || raw === undefined) return false;
  const stored = isoOf(before[field.name]);
  return stored !== undefined && raw === datetimeInputValue(stored, 'instant');
};

/** The last value a posted name carried, as text. A repeated name arrives as a list. */
export const posted = (form: Posted, name: string): string | undefined => {
  if (!Object.hasOwn(form, name)) return undefined;
  const value = form[name];
  const last: unknown = Array.isArray(value) ? value[value.length - 1] : value;
  return typeof last === 'string' ? last : undefined;
};

/** The widgets whose value is not text: an empty box of one is no value, never `''`. */
const TYPED: ReadonlySet<AdminField['widget']> = new Set([
  'money',
  'number-input',
  'datetime',
  'json-editor',
]);

/**
 * Empty is "no value" for a column that may hold none, and the empty string for a required TEXT
 * one — so the schema refuses it in its own words. A typed widget has no empty string: `''` in a
 * money field reached the widget on the 422 re-render and was refused as "money value is a
 * string", a 500 where the form's own issue belonged.
 */
const blank = (field: AdminField): unknown =>
  field.required && !TYPED.has(field.widget) ? '' : null;

/**
 * Schema's own decimal reader, never `Number(raw)`: that reads hex, binary and octal too, so `0x10`
 * in a money box was stored as `minor: 16`. Anything else is handed on as typed for the schema to
 * refuse against the field. Whitespace never reaches here — `decodeField` blanks it first.
 */
const numberOf = (raw: string): unknown => numeric(raw) ?? raw;

/** The widgets that hold a number: a box of only whitespace is as empty as `''` for them. */
const NUMERIC: ReadonlySet<AdminField['widget']> = new Set(['money', 'number-input']);

const jsonOf = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    // Left as typed: the schema names the field, which a thrown SyntaxError would not.
    return raw;
  }
};

function decodeField(field: AdminField, form: Posted): unknown {
  const raw = posted(form, field.name);
  // An unchecked box posts nothing at all, so absence IS the answer for a checkbox.
  if (field.widget === 'checkbox') return raw !== undefined && raw !== 'false';
  if (raw === undefined || raw === '') return blank(field);
  // `Number(' ')` is 0, so a space in an untouched optional number box was a write of 0 over a
  // stored null — a change the audit diff then attributed to the operator.
  if (NUMERIC.has(field.widget) && raw.trim() === '') return blank(field);
  switch (field.widget) {
    case 'number-input':
      return numberOf(raw);
    case 'money':
      return {
        minor: numberOf(raw),
        currency: posted(form, currencyFieldOf(field.name)) ?? field.currency ?? '',
      };
    case 'datetime':
      // `datetime-local` posts `YYYY-MM-DDTHH:mm` and the control says UTC beside the box; a
      // calendar date stays the `YYYY-MM-DD` string its column holds.
      return field.type === 'date' ? raw : new Date(`${raw.slice(0, 16)}:00.000Z`);
    case 'json-editor':
      return jsonOf(raw);
    default:
      return raw;
  }
}

/**
 * Every field the form rendered, decoded. A sealed column rides along as the string that was
 * typed — `crud.ts` drops an empty one, which is what makes an untouched box mean "unchanged".
 *
 * `before` is the row an EDIT form was rendered from: an instant that comes back exactly as it was
 * drawn is left out rather than rewritten at the control's precision. A create has none.
 */
export function decodeForm(
  resource: AdminResource,
  form: Posted,
  before?: AdminRow,
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const field of resource.formFields) {
    if (before !== undefined && untouchedInstant(field, posted(form, field.name), before)) continue;
    out[field.name] = decodeField(field, form);
  }
  for (const field of resource.secretFields) out[field.name] = posted(form, field.name) ?? '';
  return out;
}
