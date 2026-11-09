// The JSON value `null` in a NOT NULL `json()` column, through the admin's whole write path: the
// form posts the text `null`, the entity's own schema judges it, the repository stores it, and the
// edit form draws it back as `null`. The admin keeps no second NOT NULL rule of its own.

import { afterAll, describe, expect, test } from 'bun:test';
import { clearRegistry, database, entity, json, memoryDriver, uuid } from '@ultimat3/entity';
import { t } from '@ultimat3/schema';
import { memoryAuditLog } from './audit';
import { staticAuthz } from './authz';
import { adminCreate, adminUpdate, type CrudCtx } from './crud';
import { adminColumnsOf } from './entity-columns';
import { decodeForm } from './form-decode';
import { adminRepoFor } from './repo-entity';
import { adminResource } from './resource';
import { widgetProps } from './widget-value';

const shape = t.object({ a: t.number });

const settings = entity('admin_json_null_settings', {
  columns: {
    id: uuid().primaryKey(),
    /** NOT NULL in the table; `null` is a value its schema admits. */
    payload: json(t.nullable(shape)),
    /** NOT NULL, and the schema refuses `null`. */
    strict: json(shape),
  },
});

afterAll(clearRegistry);

const ctx = (): CrudCtx => ({
  actor: { id: 'u_1', roles: ['admin'] },
  authz: staticAuthz(['admin:write', 'admin_json_null_settings:write']),
  audit: memoryAuditLog(),
  requestId: 'req_json_null',
});

const bound = () => {
  const db = database({ settings }, { driver: memoryDriver() });
  return { db, resource: adminResource(settings, { repo: adminRepoFor(settings, db.settings) }) };
};

const fieldOf = (name: string) => {
  const found = bound().resource.formFields.find((field) => field.name === name);
  if (found === undefined) return expect.unreachable(`no form field ${name}`);
  return found;
};

describe('a NOT NULL json column whose schema admits null', () => {
  test('the column is not nullable — null is a value the operator types, so it is required', () => {
    const facts = adminColumnsOf(settings).find((column) => column.name === 'payload');
    expect(facts?.nullable).toBe(false);
    expect(fieldOf('payload').required).toBe(true);
  });

  test('a create posting `null` stores the JSON null', async () => {
    const { db, resource } = bound();
    const input = decodeForm(resource, { payload: 'null', strict: '{"a":1}' });
    expect(input['payload']).toBeNull();
    const result = await adminCreate(resource, ctx(), input);
    expect(result.ok).toBe(true);
    const [row] = await db.settings.all();
    expect(row?.payload).toBeNull();
  });

  test('an edit to `null` stores it, and the edit form draws it back as `null`', async () => {
    const { db, resource } = bound();
    const made = await db.settings.insert({ payload: { a: 1 }, strict: { a: 2 } });
    const result = await adminUpdate(resource, ctx(), made.id, { payload: null });
    expect(result.ok).toBe(true);
    const stored = await db.settings.where({ id: made.id }).one();
    expect(stored?.payload).toBeNull();
    const drawn = widgetProps(fieldOf('payload'), stored?.payload, {
      timeZone: 'UTC',
      locale: 'en',
    });
    expect(drawn).toEqual({ widget: 'json-editor', field: 'payload', value: 'null' });
  });

  test('a schema that refuses null answers as a field issue, in its own words', async () => {
    const { resource } = bound();
    const result = await adminCreate(resource, ctx(), { payload: null, strict: null });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain('is required');
  });
});
