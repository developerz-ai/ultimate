// A list page's state is its query string. One parser and one builder: what `listHref` writes,
// `pageRequestOf` reads back — and a parameter the resource does not derive is REFUSED by name,
// never ignored: a typo that silently listed every row is how an operator acts on the wrong list.

import { afterAll, describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import {
  boolean,
  clearRegistry,
  date,
  entity,
  enumerated,
  integer,
  text,
  timestamp,
  uuid,
} from '@ultimat3/entity';
import { checkedFilter } from './list-filters';
import { CURSOR_PARAM, listHref, pageRequestOf, SCOPE_PARAM, SORT_PARAM } from './list-request';
import { adminResource } from './resource';
import { NO_SCOPE } from './resource-list';

const owners = entity('admin_url_owners', {
  columns: { id: uuid().primaryKey(), name: text({ max: 80 }) },
});

const tickets = entity('admin_url_tickets', {
  columns: {
    id: uuid().primaryKey(),
    ownerId: uuid().references(() => owners.id),
    title: text({ max: 120 }),
    body: text(),
    status: enumerated(['open', 'closed']).default('open'),
    urgent: boolean().default(false),
    weight: integer(),
    token: text({ max: 64 }).sealed().nullable(),
    createdAt: timestamp().defaultNow(),
  },
});

afterAll(clearRegistry);

const resource = adminResource(tickets, {
  path: '/tickets',
  // Not indexed, so not a filter until the app says its list may ask.
  fields: { weight: { filterable: true } },
  scopes: {
    open: { where: [{ field: 'status', op: 'eq', value: 'open' }], default: true },
    urgent: { where: [{ field: 'urgent', op: 'eq', value: true }] },
  },
});

const url = (search: string): URL => new URL(`http://localhost/admin/tickets${search}`);
const ask = (search: string) => pageRequestOf(resource, url(search));

/** The refusal's cause, or a failed test: every refusal here is `X_ADMIN_FILTER_INVALID`. */
const refusal = (search: string): string => {
  try {
    ask(search);
  } catch (error) {
    if (isUltimateError(error) && error.code === 'X_ADMIN_FILTER_INVALID') return error.cause;
    throw error;
  }
  return expect.unreachable(`${search} was accepted`);
};

describe('unit · pageRequestOf', () => {
  test('no parameter is no request — the resource’s own sort, scope and first page', () => {
    expect(ask('')).toEqual({});
    // A GET form submits every input it holds: an empty one is not a parameter.
    expect(ask(`?${CURSOR_PARAM}=&${SORT_PARAM}=&${SCOPE_PARAM}=&f.title=&f.weight.gte=`)).toEqual(
      {},
    );
  });

  test('a cursor, a sort and a scope are read off their own parameters', () => {
    expect(ask('?cursor=abc&sort=weight:asc&scope=urgent')).toEqual({
      cursor: 'abc',
      sort: { field: 'weight', direction: 'asc' },
      scope: 'urgent',
    });
    // A bare field sorts descending — the default everywhere.
    expect(ask('?sort=weight').sort).toEqual({ field: 'weight', direction: 'desc' });
  });

  test('each filter shape reads its default operator and a value of the column’s own type', () => {
    expect(ask('?f.title=leak').filters).toEqual([
      { field: 'title', op: 'contains', value: 'leak' },
    ]);
    expect(ask('?f.status=closed').filters).toEqual([
      { field: 'status', op: 'eq', value: 'closed' },
    ]);
    expect(ask('?f.urgent=true').filters).toEqual([{ field: 'urgent', op: 'eq', value: true }]);
    expect(ask('?f.weight=3').filters).toEqual([{ field: 'weight', op: 'eq', value: 3 }]);
    expect(ask('?f.ownerId=0190a000-0000-7000-8000-000000000001').filters).toEqual([
      { field: 'ownerId', op: 'eq', value: '0190a000-0000-7000-8000-000000000001' },
    ]);
  });

  test('a named operator, a range, a repeated `in` and an is-null', () => {
    expect(ask('?f.weight.gte=2&f.weight.lte=9').filters).toEqual([
      { field: 'weight', op: 'gte', value: 2 },
      { field: 'weight', op: 'lte', value: 9 },
    ]);
    expect(ask('?f.status.in=open&f.status.in=closed').filters).toEqual([
      { field: 'status', op: 'in', value: ['open', 'closed'] },
    ]);
    expect(ask('?f.ownerId.is-null=false').filters).toEqual([
      { field: 'ownerId', op: 'is-null', value: false },
    ]);
  });

  test('an instant is typed in UTC: a datetime-local value and a bare date both become ISO', () => {
    // `createdAt` is not indexed, so it is not a filter until the app says so.
    const dated = adminResource(tickets, { fields: { createdAt: { filterable: true } } });
    const from = pageRequestOf(dated, url('?f.createdAt.gte=2026-03-01T09:30')).filters;
    expect(from).toEqual([{ field: 'createdAt', op: 'gte', value: '2026-03-01T09:30:00.000Z' }]);
    const day = pageRequestOf(dated, url('?f.createdAt.lte=2026-03-02')).filters;
    expect(day).toEqual([{ field: 'createdAt', op: 'lte', value: '2026-03-02T00:00:00.000Z' }]);
    // A local time with no zone is refused: the admin never invents one.
    expect(() => pageRequestOf(dated, url('?f.createdAt.gte=2026-03-01T09:30:00'))).toThrow(
      /takes a UTC instant/,
    );
  });
});

describe('unit · a parameter the resource does not derive is refused, by name', () => {
  test('an unknown filter field names the filters the resource does derive', () => {
    const cause = refusal('?f.colour=red');
    expect(cause).toContain('"f.colour" is not a filter of this resource');
    // The label first — it is the search box — then the derived ones.
    expect(cause).toContain('f.title, ');
    expect(cause).toContain('f.status');
    // Unindexed prose is not offered, and neither is anything inherited from a prototype.
    expect(refusal('?f.body=x')).toContain('is not a filter');
    expect(refusal('?f.constructor=x')).toContain('is not a filter');
  });

  test('a sealed column is never a filter — not even by name', () => {
    expect(refusal('?f.token=abc')).toContain('"f.token" is not a filter of this resource');
    expect(resource.filters.map((field) => field.name)).not.toContain('token');
  });

  test('an operator the field’s shape has no meaning for names the ones it answers', () => {
    const cause = refusal('?f.urgent.contains=tr');
    expect(cause).toContain('names an operator "urgent" does not answer');
    expect(cause).toContain('this list answers: f.urgent)');
    expect(refusal('?f.title.gt=a')).toContain('f.title, f.title.eq, f.title.neq');
  });

  test('a value that is not the column’s type is refused, with what it takes', () => {
    expect(refusal('?f.weight=heavy')).toContain('takes a number, got "heavy"');
    expect(refusal('?f.urgent=maybe')).toContain('takes true or false');
    expect(refusal('?f.status=archived')).toContain('takes one of open, closed');
  });

  test('an unknown sort names the sortable fields; a bad direction is not read as desc', () => {
    const cause = refusal('?sort=body:asc');
    expect(cause).toContain('names a field this resource cannot sort by');
    expect(cause).toContain('sort=weight');
    expect(refusal('?sort=constructor:asc')).toContain('cannot sort by');
    expect(refusal('?sort=weight:sideways')).toContain('neither asc nor desc');
  });

  test('an unknown scope names the declared ones', () => {
    const cause = refusal('?scope=mine');
    expect(cause).toContain('"scope=mine" is not a scope of this resource');
    expect(cause).toContain('scope=open, scope=urgent');
  });

  test('a parameter that is none of them is refused too', () => {
    const cause = refusal('?page=4');
    expect(cause).toContain('"page" is not a parameter a list reads');
    expect(cause).toContain('cursor, sort, scope, f.title');
  });
});

// The MCP list tool hands the SAME validator typed values — a number, a boolean, a list — where
// a URL hands it text. One rule either way: the column's own type, or a refusal naming it.
describe('unit · checkedFilter, for a caller that sends typed values', () => {
  const ask = (field: string, value: unknown, op?: string) =>
    checkedFilter(resource, { field, value, ...(op === undefined ? {} : { op }) });
  const refused = (field: string, value: unknown, op?: string): string => {
    try {
      ask(field, value, op);
    } catch (error) {
      if (isUltimateError(error)) return error.cause;
      throw error;
    }
    return expect.unreachable(`${field} was accepted`);
  };

  test('a number, a boolean and a list are read as themselves', () => {
    expect(ask('weight', 3)).toEqual({ field: 'weight', op: 'eq', value: 3 });
    expect(ask('urgent', false)).toEqual({ field: 'urgent', op: 'eq', value: false });
    expect(ask('status', ['open', 'closed'], 'in')).toEqual({
      field: 'status',
      op: 'in',
      value: ['open', 'closed'],
    });
    expect(ask('ownerId', true, 'is-null')).toEqual({
      field: 'ownerId',
      op: 'is-null',
      value: true,
    });
    // A number where text is owed is its digits; a text filter never receives an object.
    expect(ask('title', 42)).toEqual({ field: 'title', op: 'contains', value: '42' });
  });

  test('a value of the wrong type is refused by its type, never rendered', () => {
    expect(refused('title', { nested: true })).toContain('takes text, got a object');
    expect(refused('status', 7)).toContain('takes one of its values, got a number');
    expect(refused('weight', null)).toContain('takes a number, got a null');
    expect(refused('status', ['open', 'gone'], 'in')).toContain('takes one of open, closed');
    expect(refused('ownerId', 'maybe', 'is-null')).toContain('takes true or false');
    expect(refused('', 'x')).toContain('"f." is not a filter of this resource');
  });
});

describe('unit · a typed filter value is a value of its type, strictly', () => {
  const due = entity('admin_url_due', {
    columns: { id: uuid().primaryKey(), dueOn: date(), at: timestamp() },
  });
  const dated = adminResource(due, {
    fields: { dueOn: { filterable: true }, at: { filterable: true } },
  });
  const causeOf = (target: typeof resource, search: string): string => {
    try {
      pageRequestOf(target, new URL(`http://localhost/admin/x${search}`));
    } catch (error) {
      if (isUltimateError(error) && error.code === 'X_ADMIN_FILTER_INVALID') return error.cause;
      throw error;
    }
    return expect.unreachable(`${search} was accepted`);
  };

  test('a number is decimal digits — not a blank, not hex, not an exponent', () => {
    for (const typed of ['%20', '0x10', '1e3', '0b1', '1_000', 'Infinity']) {
      expect(causeOf(resource, `?f.weight=${typed}`)).toContain('takes a number');
    }
    expect(ask('?f.weight=-2.5').filters).toEqual([{ field: 'weight', op: 'eq', value: -2.5 }]);
  });

  test('a date that is not on the calendar never reaches the driver', () => {
    expect(causeOf(dated, '?f.dueOn=2026-02-30')).toContain('YYYY-MM-DD');
    expect(causeOf(dated, '?f.dueOn=2026-13-01')).toContain('YYYY-MM-DD');
    expect(causeOf(dated, '?f.at.gte=2026-02-30')).toContain('UTC instant');
    expect(causeOf(dated, '?f.at.gte=2026-02-29T10:00')).toContain('UTC instant');
    expect(causeOf(dated, '?f.at.gte=2026-04-31T10:00:00Z')).toContain('UTC instant');
    expect(pageRequestOf(dated, url('?f.dueOn=2028-02-29')).filters).toEqual([
      { field: 'dueOn', op: 'eq', value: '2028-02-29' },
    ]);
  });
});

describe('unit · listHref', () => {
  test('the bare list is base path + resource path, with no dangling `?`', () => {
    expect(listHref('/admin', resource)).toBe('/admin/tickets');
    expect(listHref('/admin', resource, { cursor: null })).toBe('/admin/tickets');
  });

  test('`scope: null` is NO scope — not even the default — and the URL says so and reads back', () => {
    // A related card reads the related list unscoped; its "all" link has to open THAT list, not
    // the target's default tab with fewer rows than the card it came from.
    const href = listHref('/admin', resource, { scope: null });
    expect(href).toBe(`/admin/tickets?${SCOPE_PARAM}=${NO_SCOPE}`);
    expect(pageRequestOf(resource, new URL(`http://localhost${href}`))).toEqual({ scope: null });
    // Absent stays the default scope.
    expect(pageRequestOf(resource, new URL('http://localhost/admin/tickets'))).toEqual({});
  });

  test('a scope may not be DECLARED under the reserved no-scope name', () => {
    expect(() => adminResource(tickets, { scopes: { [NO_SCOPE]: { where: [] } } })).toThrow(
      'X_ADMIN_FILTER_INVALID',
    );
  });

  test('round trip: the URL it builds is the request that built it', () => {
    const asked = {
      cursor: 'a b/c',
      scope: 'urgent',
      sort: { field: 'weight', direction: 'asc' },
      filters: [
        { field: 'title', op: 'contains', value: 'leak & co' },
        { field: 'status', op: 'in', value: ['open', 'closed'] },
        { field: 'weight', op: 'gte', value: 2 },
        { field: 'urgent', op: 'eq', value: true },
        { field: 'ownerId', op: 'is-null', value: false },
      ],
    } as const;
    const href = listHref('/back-office', resource, asked);
    expect(href.startsWith('/back-office/tickets?')).toBe(true);
    // The default operator is left off; a named one rides the parameter's own name.
    expect(href).toContain('f.title=leak+%26+co');
    expect(href).toContain('f.status.in=open&f.status.in=closed');
    expect(pageRequestOf(resource, new URL(`http://localhost${href}`))).toEqual(asked);
  });
});
