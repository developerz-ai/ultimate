// Row value → widget props. This is where the two money/time axioms are actually enforced:
// a money value that arrived as a float and a timestamp with no IANA zone both fail here,
// loudly, instead of rendering a number that is wrong for somebody. Views render the props
// this returns and make no decisions of their own.

import type { Money } from '@ultimat3/money';
import { isCurrencyCode } from '@ultimat3/schema';
import { AdminFieldUnsupportedError } from './errors';
import type { AdminField } from './fields';

export interface WidgetContext {
  /** IANA zone. Required — there is no "server local time" in Ultimate. */
  readonly timeZone: string;
  /** BCP-47, for the number/date/money formatters the widgets call. */
  readonly locale: string;
  /**
   * Where a foreign-key value links to, or `null` for "do not link it". Absent renders the id as
   * plain text.
   *
   * WHY a seam and not a derivation: the widget used to build `/${entity}s/${value}`, which is
   * English pluralisation by string concatenation and drops the admin's own `basePath` — a link
   * that is wrong on every admin not mounted at `/` and on every entity whose plural is not a
   * trailing `s`. The route table is `AdminApp`'s (`basePath` + `AdminResource.path`, which is
   * already pluralised once, in `resource.ts`), and a widget three layers down cannot see it. The
   * caller that builds this context can. A wrong link is worse than no link.
   */
  readonly hrefFor?: (entity: string, id: string) => string | null;
}

export interface SelectOption {
  readonly value: string;
  readonly labelKey: string;
}

export type WidgetProps =
  | { readonly widget: 'text-input'; readonly field: string; readonly value: string }
  | { readonly widget: 'textarea'; readonly field: string; readonly value: string }
  | { readonly widget: 'number-input'; readonly field: string; readonly value: number | null }
  | { readonly widget: 'money'; readonly field: string; readonly value: Money | null }
  | { readonly widget: 'checkbox'; readonly field: string; readonly value: boolean }
  | {
      readonly widget: 'select';
      readonly field: string;
      readonly value: string | null;
      readonly options: readonly SelectOption[];
    }
  | {
      readonly widget: 'datetime';
      readonly field: string;
      /** Always UTC ISO-8601. The widget formats it into `timeZone`. */
      readonly value: string | null;
      readonly timeZone: string;
      readonly precision: 'date' | 'instant';
    }
  | { readonly widget: 'timezone-picker'; readonly field: string; readonly value: string | null }
  | { readonly widget: 'locale-picker'; readonly field: string; readonly value: string | null }
  | { readonly widget: 'json-editor'; readonly field: string; readonly value: string }
  | {
      readonly widget: 'reference';
      readonly field: string;
      readonly value: string | null;
      readonly entity: string;
      readonly labelField: string;
    }
  | {
      readonly widget: 'upload';
      readonly field: string;
      readonly value: { readonly url: string; readonly name: string } | null;
    };

const fail = (field: AdminField, cause: string, fix: string): never => {
  throw new AdminFieldUnsupportedError({ entity: field.entity, field: field.name, cause, fix });
};

/**
 * `money()` puts a `bigint` on the row — Postgres `bigint` minor units — where `Money` is a
 * number. This is the one place that widening happens, and it refuses rather than round: a
 * value past the safe integer range would render as a different amount than it is.
 */
const minorUnits = (value: unknown): number | null => {
  if (typeof value === 'bigint') {
    const widened = Number(value);
    return Number.isSafeInteger(widened) ? widened : null;
  }
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
};

/** `Money = { minor: number; currency: string }` or nothing. A float is a bug, not a value. */
export function assertMoney(field: AdminField, value: unknown): Money | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return fail(
      field,
      `money value arrived as the number ${value}; money is integer minor units + an ISO currency`,
      `store ${field.name} as { minor, currency } — x g migration "money ${field.entity}.${field.name}"`,
    );
  }
  if (typeof value !== 'object') {
    return fail(
      field,
      `money value is a ${typeof value}`,
      'return { minor, currency } from the repo',
    );
  }
  const bag = value as { minor?: unknown; currency?: unknown };
  const minor = minorUnits(bag.minor);
  if (minor === null) {
    return fail(
      field,
      `money.minor is ${String(bag.minor)}; minor units are integers`,
      'multiply by the currency exponent before storing, never round at render time',
    );
  }
  const currency = typeof bag.currency === 'string' ? bag.currency : field.currency;
  // `isCurrencyCode` is `@ultimat3/schema`'s (tier 0), never a local regex: this widget refuses
  // exactly what `t.money`, the published OpenAPI `pattern` and the Postgres CHECK refuse, so a
  // row the app wrote can never be one the admin declines to render. It takes `unknown`, which is
  // what makes the `undefined` case — no row currency and no declared `field.currency` — the same
  // branch as a malformed one.
  if (!isCurrencyCode(currency)) {
    return fail(
      field,
      `money has no ISO-4217 currency (got ${String(bag.currency)})`,
      `declare the currency with fields: { ${field.name}: { currency: 'EUR' } }`,
    );
  }
  return { minor, currency };
}

/** No zone, no render. A timestamp shown in an implicit zone is a wrong timestamp. */
export function assertZone(field: AdminField, timeZone: string | undefined): string {
  if (timeZone === undefined || timeZone.trim() === '') {
    return fail(
      field,
      'timestamp has no IANA time zone; the admin never formats a date in an implicit zone',
      "pass ctx.timeZone (actor.timeZone ?? 'UTC') into the admin view",
    );
  }
  return timeZone;
}

function isoOf(field: AdminField, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return new Date(value).toISOString();
  return fail(field, `timestamp value is a ${typeof value}`, 'return an ISO string or a Date');
}

const optionsFor = (field: AdminField): readonly SelectOption[] =>
  (field.values ?? []).map((value) => ({
    value,
    labelKey: `admin.${field.entity}.field.${field.name}.option.${value}`,
  }));

const asText = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value);

/** The single dispatch from a field + a raw row value to renderable props. */
export function widgetProps(field: AdminField, value: unknown, ctx: WidgetContext): WidgetProps {
  switch (field.widget) {
    case 'text-input':
      return { widget: 'text-input', field: field.name, value: asText(value) };
    case 'textarea':
      return { widget: 'textarea', field: field.name, value: asText(value) };
    case 'number-input':
      return {
        widget: 'number-input',
        field: field.name,
        value: typeof value === 'number' ? value : null,
      };
    case 'money':
      return { widget: 'money', field: field.name, value: assertMoney(field, value) };
    case 'checkbox':
      return { widget: 'checkbox', field: field.name, value: value === true };
    case 'select':
      return {
        widget: 'select',
        field: field.name,
        value: value === null || value === undefined ? null : String(value),
        options: optionsFor(field),
      };
    case 'datetime':
      return {
        widget: 'datetime',
        field: field.name,
        value: isoOf(field, value),
        timeZone: assertZone(field, ctx.timeZone),
        precision: field.type === 'date' ? 'date' : 'instant',
      };
    case 'timezone-picker':
      return {
        widget: 'timezone-picker',
        field: field.name,
        value: typeof value === 'string' ? value : null,
      };
    case 'locale-picker':
      return {
        widget: 'locale-picker',
        field: field.name,
        value: typeof value === 'string' ? value : null,
      };
    case 'json-editor':
      return {
        widget: 'json-editor',
        field: field.name,
        value: value === undefined ? '' : JSON.stringify(value, null, 2),
      };
    case 'reference':
      return {
        widget: 'reference',
        field: field.name,
        value: value === null || value === undefined ? null : String(value),
        entity: field.relation?.entity ?? field.name,
        labelField: field.relation?.labelField ?? 'id',
      };
    case 'upload':
      return { widget: 'upload', field: field.name, value: uploadValue(field, value) };
  }
}

function uploadValue(
  field: AdminField,
  value: unknown,
): { readonly url: string; readonly name: string } | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return { url: value, name: value.split('/').pop() ?? field.name };
  const bag = value as { url?: unknown; name?: unknown };
  if (typeof bag.url !== 'string') {
    return fail(field, 'file value has no url', 'return { url, name } from the repo');
  }
  return { url: bag.url, name: typeof bag.name === 'string' ? bag.name : field.name };
}
