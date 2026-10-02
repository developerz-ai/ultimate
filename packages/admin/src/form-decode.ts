// A posted form → the typed input the entity's schema judges. A browser sends strings and omits
// an unchecked box; the row holds a number, a boolean, a Date, a `{ minor, currency }`. This is
// the one place that gap is closed, per WIDGET — the same table that rendered the control.
//
// It converts and never validates: a value that will not convert is passed through as the string
// that was typed, so the schema refuses it in its own words against the field that carried it.

import type { AdminField } from './fields';
import type { AdminResource } from './resource';

/** The posted name of a money field's currency, beside the minor-unit amount under the field's own. */
export const currencyFieldOf = (field: string): string => `${field}.currency`;

type Posted = Readonly<Record<string, unknown>>;

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

const numberOf = (raw: string): unknown => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : raw;
};

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
 */
export function decodeForm(
  resource: AdminResource,
  form: Posted,
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const field of resource.formFields) out[field.name] = decodeField(field, form);
  for (const field of resource.secretFields) out[field.name] = posted(form, field.name) ?? '';
  return out;
}
