// A `sensitive` field is never read back by oracle: no filter on it, no sort by it, as no list column,
// search or audit diff shows it — whatever index its column carries.
import { afterAll, describe, expect, test } from 'bun:test';
import { clearRegistry, entity, text, uuid } from '@ultimat3/entity';
import { checkedFilter } from './list-filters';
import { adminResource } from './resource';

const person = entity('sensitive_person', {
  columns: { id: uuid().primaryKey(), name: text({ max: 80 }), ssn: text({ max: 20 }).unique() },
});
afterAll(clearRegistry);

describe('unit · a sensitive field', () => {
  const resource = adminResource(person, { fields: { ssn: { sensitive: true } } });
  const ssn = resource.fields.find((field) => field.name === 'ssn');

  test('is no filter and no sort key, though its column is unique', () => {
    expect(ssn?.filterable).toBe(false);
    expect(ssn?.sortable).toBe(false);
    expect(resource.filters.map((filter) => filter.name)).not.toContain('ssn');
  });

  test('a hand-built filter on it is refused', () => {
    expect(() => checkedFilter(resource, { field: 'ssn', op: 'contains', value: '123' })).toThrow();
  });

  test('the same column, not sensitive, stays a filter and a sort key', () => {
    const open = adminResource(person, {}).fields.find((field) => field.name === 'ssn');
    expect(open?.filterable).toBe(true);
    expect(open?.sortable).toBe(true);
  });
});
