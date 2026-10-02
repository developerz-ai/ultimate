// What a resource's filters ARE. Per filter shape: the operators a caller may name and the
// control the filter bar draws. One validator — the URL parser, the MCP list tool and a `scopes:`
// or `rows:` declaration all pass through it — so a predicate the admin sends a repo is one the
// resource derived, on a column that is not sealed, with a value of the column's own type.

import { adminColumnsOf, adminSealedColumnsOf } from './entity-columns';
import { AdminFilterInvalidError } from './errors';
import type { AdminField, AdminFilterKind } from './fields';
import { type AdminFilter, FILTER_OPS, type FilterOp } from './registry';
import type { AdminResource } from './resource';

/** The URL prefix of a filter parameter: `f.<field>` or `f.<field>.<op>`. */
export const FILTER_PREFIX = 'f.';

/** Per shape, the operators it answers. The FIRST is what a bare `f.<field>=` means. */
const OPS_BY_KIND: Readonly<Record<AdminFilterKind, readonly FilterOp[]>> = {
  text: ['contains', 'eq', 'neq', 'is-null'],
  exact: ['eq', 'neq', 'in', 'is-null'],
  choice: ['eq', 'neq', 'in', 'is-null'],
  boolean: ['eq'],
  range: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is-null'],
  reference: ['eq', 'neq', 'in', 'is-null'],
};

/** The same table as a Map: a shape that is not one of the six has no operators, not a prototype's. */
const OPS: ReadonlyMap<string, readonly FilterOp[]> = new Map(Object.entries(OPS_BY_KIND));

/** The operators one field's filter answers; empty for a field with no filter shape. */
export function filterOpsOf(field: AdminField): readonly FilterOp[] {
  return field.filterKind === undefined ? [] : (OPS.get(field.filterKind) ?? []);
}

/** The parameter one filter is spelled as: the default operator is left off. */
export function filterParam(field: AdminField, op: FilterOp): string {
  return op === filterOpsOf(field)[0]
    ? `${FILTER_PREFIX}${field.name}`
    : `${FILTER_PREFIX}${field.name}.${op}`;
}

/** Every parameter spelling a resource answers — what a refusal names. */
export function knownFilterParams(resource: AdminResource): readonly string[] {
  return resource.filters.map((field) => `${FILTER_PREFIX}${field.name}`);
}

const isOp = (value: string): value is FilterOp =>
  (FILTER_OPS as readonly string[]).includes(value);

/** A value for a cause line: what was typed when it is text, its type when it is not. */
const shown = (value: unknown): string =>
  typeof value === 'string' ? `"${value}"` : `a ${value === null ? 'null' : typeof value}`;

const TRUTH: ReadonlyMap<unknown, boolean> = new Map<unknown, boolean>([
  ['true', true],
  ['false', false],
  [true, true],
  [false, false],
]);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_MINUTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
/** An instant names its offset. A bare local time has no zone, and the admin never invents one. */
const ZONED = /(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * A typed instant → the ISO string a driver compares. `datetime-local` posts `YYYY-MM-DDTHH:mm`
 * and the control says UTC beside the box — the same contract the edit form states — and a bare
 * date is that day's first instant in UTC.
 */
const instantOf = (raw: string): string | undefined => {
  const text = DATE.test(raw)
    ? `${raw}T00:00:00.000Z`
    : LOCAL_MINUTE.test(raw)
      ? `${raw}:00.000Z`
      : raw;
  if (!ZONED.test(text)) return undefined;
  const at = new Date(text);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
};

interface Refusal {
  readonly cause: string;
}

type Scalar = string | number | boolean;

/** One value, as the column's own type — or why it is not one. */
function scalarOf(field: AdminField, raw: unknown): Scalar | Refusal {
  switch (field.filterKind) {
    case 'boolean': {
      const truth = TRUTH.get(raw);
      return truth ?? { cause: `takes true or false, got ${shown(raw)}` };
    }
    case 'range': {
      if (field.type === 'number') {
        const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
        return raw !== '' && Number.isFinite(parsed)
          ? parsed
          : { cause: `takes a number, got ${shown(raw)}` };
      }
      if (typeof raw !== 'string') return { cause: `takes a date as text, got ${shown(raw)}` };
      if (field.type === 'date') {
        return DATE.test(raw) ? raw : { cause: `takes a YYYY-MM-DD date, got ${shown(raw)}` };
      }
      return (
        instantOf(raw) ?? {
          cause: `takes a UTC instant (YYYY-MM-DDTHH:mm, or ISO-8601 with an offset), got ${shown(raw)}`,
        }
      );
    }
    case 'choice': {
      if (typeof raw !== 'string') return { cause: `takes one of its values, got ${shown(raw)}` };
      // An enum names its values; a locale or a zone column has no list to hold one against.
      if (field.values !== undefined && !field.values.includes(raw)) {
        return { cause: `takes one of ${field.values.join(', ')} — got ${shown(raw)}` };
      }
      return raw;
    }
    default:
      if (typeof raw === 'string') return raw;
      return typeof raw === 'number' && Number.isFinite(raw)
        ? String(raw)
        : { cause: `takes text, got ${shown(raw)}` };
  }
}

const isRefusal = (value: unknown): value is Refusal =>
  typeof value === 'object' && value !== null && 'cause' in value;

const filterValueOf = (
  field: AdminField,
  op: FilterOp,
  raw: unknown,
): AdminFilter['value'] | Refusal => {
  if (op === 'in') {
    const list: readonly unknown[] = Array.isArray(raw) ? raw : [raw];
    const out: string[] = [];
    for (const one of list) {
      const scalar = scalarOf(field, one);
      if (isRefusal(scalar)) return scalar;
      out.push(String(scalar));
    }
    return out;
  }
  // A scalar operator given a repeated parameter reads the LAST one, as a form field does.
  const last: unknown = Array.isArray(raw) ? raw[raw.length - 1] : raw;
  if (op === 'is-null') {
    return TRUTH.get(last) ?? { cause: `takes true or false, got ${shown(last)}` };
  }
  return scalarOf(field, last);
};

export interface AskedFilter {
  readonly field: string;
  /** Absent is the field's default operator — `contains` for text, `eq` for everything else. */
  readonly op?: string;
  readonly value: unknown;
}

/**
 * One filter a CALLER asked for — a URL parameter, an MCP argument — checked against what the
 * resource derives. Refused by name: the field when it is not a filter, the operator when the
 * field's shape has no meaning for it, the value when it is not the column's type.
 */
export function checkedFilter(resource: AdminResource, asked: AskedFilter): AdminFilter {
  const spelled = `${FILTER_PREFIX}${asked.field}${asked.op === undefined ? '' : `.${asked.op}`}`;
  const refuse = (cause: string, known: readonly string[]): never => {
    throw new AdminFilterInvalidError({ entity: resource.name, asked: spelled, cause, known });
  };
  const field = resource.filters.find((known) => known.name === asked.field);
  if (field === undefined) {
    return refuse('is not a filter of this resource', knownFilterParams(resource));
  }
  const ops = filterOpsOf(field);
  const op = asked.op ?? ops[0];
  if (op === undefined || !isOp(op) || !ops.includes(op)) {
    return refuse(
      `names an operator "${field.name}" does not answer`,
      ops.map((known) => filterParam(field, known)),
    );
  }
  const value = filterValueOf(field, op, asked.value);
  if (isRefusal(value)) return refuse(value.cause, [filterParam(field, op)]);
  return { field: field.name, op, value };
}

/**
 * Predicates the APP declared — a scope's `where`, a resource's `rows` — held to a narrower rule
 * than a caller's: any column of the entity may be named (the app knows which of its columns are
 * indexed), but never one that is not a column and never a sealed one, whose ciphertext no
 * predicate can be written against.
 */
export function declaredFilters(
  resource: Pick<AdminResource, 'name' | 'entity'>,
  where: readonly AdminFilter[],
  declaredAs: string,
): readonly AdminFilter[] {
  // Through the one flattener: it is the only reader of a column's declaration, and its two lists
  // are exactly the two answers this needs — what may be named, and what is sealed.
  const open = adminColumnsOf(resource.entity).map((column) => column.name);
  const sealed = adminSealedColumnsOf(resource.entity).map((column) => column.name);
  for (const filter of where) {
    const refuse = (cause: string, known: readonly string[]): never => {
      throw new AdminFilterInvalidError({
        entity: resource.name,
        asked: `${declaredAs}: ${filter.field} ${filter.op}`,
        cause,
        known,
      });
    };
    if (sealed.includes(filter.field)) {
      refuse('names a sealed column, which no predicate can read', open);
    }
    if (!open.includes(filter.field)) refuse('names a field that is not a column', open);
    if (!isOp(filter.op)) refuse('names an operator the admin does not have', FILTER_OPS);
  }
  return where;
}
