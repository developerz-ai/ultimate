// What an operator's screens show for an entity with sealed columns. Two different reads, and they
// are held by two different things:
//
//  - a row serialised WHOLE — the detail read an MCP tool answers, a job's stored input as
//    `x jobs show` and the dev panel render it — carries no sealed property, because the
//    repository answers it server-only (`packages/entity/src/sealed.ts`);
//  - a screen that reads a row BY COLUMN NAME — the list, the detail, the form, the tool schema —
//    is derived from the entity's columns, so the derivation must not name a sealed one.
//
// And the one direction a sealed column DOES travel: in. A form writes it through
// `resource.secretFields` — a list no reader iterates — so a row with a required sealed column can
// still be created from the admin, and an edit that leaves the box empty leaves the secret alone.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { inspectJob, memoryJobDriver } from '@ultimat3/jobs';
import { memoryAuditLog } from './audit';
import { type AdminActor, staticAuthz } from './authz';
import type { CrudCtx } from './crud';
import { adminCreate, adminDetail, adminList, adminUpdate } from './crud';
import type { AdminRepo, AdminRow } from './registry';
import { adminRepoFor } from './repo-entity';
import { adminResource } from './resource';

const CANARY = 'PLAINTEXT-CANARY-7f3a';
const LOOKUP_CANARY = 'LOOKUP-CANARY-91be';
const SEALED = /x1\.[0-9a-f]{16}\./;

const accounts = entity('admin_sealed_accounts', {
  columns: {
    id: uuid().primaryKey(),
    name: text({ max: 80 }),
    credential: text({ max: 200 }).sealed(),
    contact: text({ max: 200 }).sealed({ lookup: true }),
  },
});

const table = database({ accounts }, { driver: memoryDriver() }).accounts;

/** The adapter a host binds over the entity's table: the rows are the repository's own. */
const repo: AdminRepo<AdminRow> = {
  list: async () => (await table.all()) as readonly AdminRow[],
  find: async (id) => ((await table.where({ id }).one()) as AdminRow | null) ?? null,
  create: () => expect.unreachable('no write in this file'),
  update: () => expect.unreachable('no write in this file'),
  destroy: () => expect.unreachable('no write in this file'),
};

const actor: AdminActor = { id: 'u_1', roles: ['admin'], orgId: 'org_1' };
const ctx = (
  granted: readonly string[] = ['admin:read', 'admin_sealed_accounts:read'],
): CrudCtx => ({
  actor,
  authz: staticAuthz(granted),
  audit: memoryAuditLog(),
  requestId: 'req_1',
});

const WRITER = ['admin:write', 'admin_sealed_accounts:read', 'admin_sealed_accounts:write'];

let id = '';

beforeAll(async () => {
  id = (await table.insert({ name: 'Ada', credential: CANARY, contact: LOOKUP_CANARY })).id;
});

afterAll(() => {
  clearRegistry();
});

const clean = (bytes: string): void => {
  expect(bytes).toContain('Ada');
  expect(bytes).not.toContain(CANARY);
  expect(bytes).not.toContain(LOOKUP_CANARY);
  expect(bytes).not.toMatch(SEALED);
};

describe('unit · a sealed column on an operator surface', () => {
  test('a list and a detail read answer rows that serialise without it', async () => {
    const resource = adminResource(accounts, { repo });
    const listed = await adminList(resource, ctx(), {});
    const found = await adminDetail(resource, ctx(), id);
    expect(listed.ok && found.ok).toBe(true);
    // What an MCP `read`/`list` tool result and an audit `row` are built from.
    clean(JSON.stringify(listed));
    clean(JSON.stringify(found));
  });

  test("a job's stored input, as `x jobs show` and the dev panel render it", async () => {
    const [row] = await table.all();
    expect(row?.credential).toBe(CANARY);
    const driver = memoryJobDriver();
    const { id: jobId } = await driver.enqueue({
      name: 'rotateCredential',
      queue: 'default',
      // The mistake this pins: the ROW as a payload, where the id was meant.
      input: { account: row, accounts: [row] },
      idempotencyKey: 'rotate:1',
      maxAttempts: 1,
    });
    const trace = await inspectJob(driver, jobId);
    clean(JSON.stringify(trace));
    // …and the bytes the Postgres driver writes to `x_jobs.input` (`driver-pg.ts`).
    clean(JSON.stringify({ account: row, accounts: [row] }));
  });

  // The screens read a row BY NAME — `row[field.name]` — so a derived field for a sealed column
  // would be the plaintext in the list, the detail and the form: a server-only property does
  // nothing about a read that names it. `adminColumnsOf()` skips the column instead.
  test('no derived field names it — list, detail, form, filter, search', () => {
    const resource = adminResource(accounts, { repo });
    const named = [
      ...resource.fields,
      ...resource.listFields,
      ...resource.formFields,
      ...resource.filters,
      ...resource.searchFields,
    ].map((field) => field.name);
    expect(named).toContain('name');
    expect(named).not.toContain('credential');
    expect(named).not.toContain('contact');
  });

  test('it is a WRITE-ONLY field of its own list — an input, and nothing a reader iterates', () => {
    const resource = adminResource(accounts, { repo });
    expect(
      resource.secretFields.map((field) => [field.name, field.widget, field.required]),
    ).toEqual([
      ['credential', 'secret-input', true],
      ['contact', 'secret-input', true],
    ]);
    for (const field of resource.secretFields) {
      expect([field.inList, field.filterable, field.sortable, field.searchable]).toEqual([
        false,
        false,
        false,
        false,
      ]);
    }
  });
});

describe('unit · a sealed column through the admin write path', () => {
  const resource = () => adminResource(accounts, { repo: adminRepoFor(accounts, table) });

  test('a create carries it around the schema and into the row, and audits THAT it was set', async () => {
    const context = ctx(WRITER);
    const made = await adminCreate(resource(), context, {
      name: 'Grace',
      credential: 'NEW-CANARY-1',
      contact: 'NEW-CANARY-2',
    });
    if (!made.ok) return expect.unreachable(`create was refused: ${made.kind}`);
    const [stored] = await table.where({ id: String(made.row?.['id']) }).all();
    expect(stored?.credential).toBe('NEW-CANARY-1');
    // The result and the log are what an MCP tool answers and what an auditor reads.
    const bytes = JSON.stringify([made, await context.audit.entries()]);
    expect(bytes).not.toContain('NEW-CANARY');
    expect(made.audit.diff.filter((change) => change.field === 'credential')).toEqual([
      { field: 'credential', before: '[redacted]', after: '[redacted]' },
    ]);
  });

  test('a create that leaves a required one out is refused, against the field, with a key', async () => {
    const made = await adminCreate(resource(), ctx(WRITER), { name: 'Hopper', contact: 'c' });
    if (made.ok || made.kind !== 'invalid') return expect.unreachable('expected an invalid result');
    expect(made.issues.map((issue) => [issue.path, issue.messageKey])).toEqual([
      ['credential', 'admin.error.secret-required'],
    ]);
  });

  test('an update with an EMPTY box leaves the stored secret alone; a typed one replaces it', async () => {
    const context = ctx(WRITER);
    const kept = await adminUpdate(resource(), context, id, { name: 'Ada L.', credential: '' });
    expect(kept.ok).toBe(true);
    expect((await table.where({ id }).all())[0]?.credential).toBe(CANARY);
    // Nothing was written to it, so nothing about it is on the log.
    expect(kept.ok ? kept.audit.diff.map((change) => change.field) : []).toEqual(['name']);

    const rotated = await adminUpdate(resource(), context, id, { credential: 'ROTATED-CANARY' });
    expect(rotated.ok).toBe(true);
    expect((await table.where({ id }).all())[0]?.credential).toBe('ROTATED-CANARY');
    expect(JSON.stringify([rotated, await context.audit.entries()])).not.toContain(
      'ROTATED-CANARY',
    );
  });

  test('a hand-written repo that hands rows back WITH the property still leaks nothing to the diff', async () => {
    // The repository hides a sealed property; an override may not. The audit diff is derived from
    // the resource's own sealed list, not from what a row happens to enumerate.
    const leaky: AdminRepo<AdminRow> = {
      ...repo,
      find: async () => ({ id, name: 'Ada', credential: 'LEAKY-BEFORE', contact: 'x' }),
      update: async () => ({ id, name: 'Ada', credential: 'LEAKY-AFTER', contact: 'x' }),
    };
    const context = ctx(WRITER);
    const result = await adminUpdate(adminResource(accounts, { repo: leaky }), context, id, {
      credential: 'LEAKY-AFTER',
    });
    expect(result.ok).toBe(true);
    const logged = JSON.stringify(await context.audit.entries());
    expect(logged).not.toContain('LEAKY-BEFORE');
    expect(logged).not.toContain('LEAKY-AFTER');
  });
});
