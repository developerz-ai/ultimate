// An admin as plain data — what the manifest records. Deterministic and JSON-safe: resources by
// entity, routes by URL, and inside a resource the order the bar and the tabs are drawn in.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  clearRegistry,
  database,
  entity,
  enumerated,
  integer,
  memoryDriver,
  text,
  uuid,
} from '@ultimat3/entity';
import type { AdminApp } from './admin';
import type { AdminDescription } from './describe';

const { defineAdmin } = await import('./admin');

const zebras = entity('admin_desc_zebras', {
  columns: {
    id: uuid().primaryKey(),
    name: text({ max: 80 }),
    stripes: integer(),
    mood: enumerated(['calm', 'wild']).default('calm'),
  },
});
const ants = entity('admin_desc_ants', {
  columns: {
    id: uuid().primaryKey(),
    name: text({ max: 80 }),
    zebraId: uuid()
      .references(() => zebras.id)
      .nullable(),
  },
});

afterAll(clearRegistry);

let admin: AdminApp;
beforeAll(() => {
  admin = defineAdmin({
    basePath: '/desc-admin',
    // Declared zebras-first: the description is sorted, so this order must not survive.
    entities: [zebras, ants],
    db: database({ zebras, ants }, { driver: memoryDriver() }),
    resources: {
      admin_desc_zebras: {
        path: '/zebras',
        scopes: {
          wild: { where: [{ field: 'mood', op: 'eq', value: 'wild' }], count: true },
          calm: { where: [{ field: 'mood', op: 'eq', value: 'calm' }], default: true },
        },
        rows: () => [],
        sections: [{ titleKey: 'admin.zebras.section.look', fields: ['stripes'] }],
        related: ['admin_desc_ants'],
      },
    },
    actions: [
      {
        name: 'zebra.tame',
        permission: 'admin_desc_zebras:write',
        entity: 'admin_desc_zebras',
        when: (row) => row['mood'] === 'wild',
        batch: { threshold: 50 },
        handle: async () => {},
      },
    ],
  });
});

describe('unit · AdminApp.describe()', () => {
  let described: AdminDescription;
  beforeAll(() => {
    described = admin.describe();
  });

  test('each resource: its filters, sorts and scopes in drawing order, and whether rows are scoped', () => {
    expect(described.basePath).toBe('/desc-admin');
    expect(described.audit).toBe('memory');
    // Sorted by name, so the jobs dashboard's four follow the app's own.
    expect(described.resources.map((one) => one.entity).slice(2)).toEqual([
      'x_job_queues',
      'x_job_tasks',
      'x_job_workers',
      'x_jobs',
    ]);
    expect(described.resources.slice(0, 2)).toMatchObject([
      {
        entity: 'admin_desc_ants',
        path: '/admin_desc_ants',
        filters: ['name', 'id', 'zebraId'],
        sorts: ['id'],
        scopes: [],
        rowScoped: false,
        related: [],
        actions: [],
      },
      {
        entity: 'admin_desc_zebras',
        path: '/zebras',
        filters: ['name', 'id', 'mood'],
        sorts: ['id', 'stripes'],
        scopes: [
          { name: 'wild', default: false, count: true },
          { name: 'calm', default: true, count: false },
        ],
        rowScoped: true,
      },
    ]);
  });

  test('how a detail and a form are arranged, what is related, and each action’s when and batch', () => {
    const zebra = described.resources.find((one) => one.entity === 'admin_desc_zebras');
    expect(zebra?.sections).toEqual([
      { title: 'admin.zebras.section.look', fields: ['stripes'] },
      { title: 'admin.section.other', fields: ['id', 'name', 'mood'] },
    ]);
    expect(zebra?.formGroups).toEqual([{ title: null, fields: ['name', 'stripes', 'mood'] }]);
    expect(zebra?.related).toEqual(['admin_desc_ants']);
    expect(zebra?.actions).toEqual([
      {
        name: 'zebra.tame',
        permission: 'admin_desc_zebras:write',
        destructive: false,
        input: false,
        when: true,
        batch: true,
        threshold: 50,
      },
    ]);
  });

  test('each route: its view, its entity and every permission that gates it, sorted by URL', () => {
    const urls = described.routes.map((route) => route.url);
    expect(urls).toEqual([...urls].sort());
    expect(described.routes.find((route) => route.url === '/desc-admin/zebras/lookup')).toEqual({
      url: '/desc-admin/zebras/lookup',
      view: 'lookup',
      entity: 'admin_desc_zebras',
      permissions: ['admin:read', 'admin_desc_zebras:read'],
    });
    expect(described.routes.find((route) => route.url === '/desc-admin/audit')?.entity).toBeNull();
  });

  test('plain data: it survives JSON unchanged, and two calls are equal', () => {
    expect(JSON.parse(JSON.stringify(described))).toEqual(described);
    expect(admin.describe()).toEqual(described);
  });
});
