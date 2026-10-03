// Every referenced id gets its label, however many a page holds: a list of 200 rows with two
// columns pointing at one target names up to 400 ids, and the label read is CHUNKED under the
// `in` ceiling rather than truncated at it — 300 ids are 300 labels, never 200 and 100 raw ids.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { knownPermissions, permissionDeclarationSites, restorePermissions } from '@ultimat3/policy';
import type { AdminApp } from './admin';
import { staticAuthz } from './authz';
import { relationsFor } from './relations';

const { defineAdmin } = await import('./admin');

const authors = entity('admin_labels_authors', {
  columns: { id: uuid().primaryKey(), name: text({ max: 40 }) },
});

const previousPermissions = knownPermissions();
const previousPermissionSites = permissionDeclarationSites();
let admin: AdminApp;
const ids: string[] = [];

beforeAll(async () => {
  const db = database({ authors }, { driver: memoryDriver() });
  admin = defineAdmin({
    basePath: '/labels',
    entities: [authors],
    db,
    auth: { authz: staticAuthz(['admin:read', 'admin_labels_authors:read']) },
  });
  for (let at = 0; at < 300; at += 1) {
    ids.push(String((await db.authors.insert({ name: `author-${String(at)}` })).id));
  }
});

afterAll(() => {
  restorePermissions(previousPermissions, previousPermissionSites);
  clearRegistry();
});

describe('unit · a page’s labels', () => {
  test('300 referenced ids are 300 labels — the `in` read is chunked, never truncated', async () => {
    const ctx = admin.ctx({ actor: { id: 'u' }, requestId: 'labels' });
    const read = await relationsFor(
      admin.resources,
      ctx,
      new Map([['admin_labels_authors', { ids: new Set(ids), pick: false }]]),
    );
    const labels = read.get('admin_labels_authors')?.labels;
    expect(labels?.size).toBe(300);
    expect(labels?.get(ids[299] ?? '')).toBe('author-299');
  });
});
