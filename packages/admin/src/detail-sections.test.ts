// How a resource ARRANGES its fields: detail sections and form groups. The rule under test is the
// one that makes declaring either safe — a field named in no group still renders, in a default
// group drawn last — plus `hintKey` through `t()` and a field that exists on one side only.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { clearRegistry, database, entity, memoryDriver, text, uuid } from '@ultimat3/entity';
import { registerCatalog } from '@ultimat3/i18n';
import { staticAuthz } from './authz';
import { installFactory, renderHtml, restoreFactory } from './inert-jsx-fixture';
import { DEFAULT_SECTION_KEY } from './resource-layout';

await import('@ultimat3/render/server');
const { defineAdmin } = await import('./admin');
const { adminCreate, adminUpdate } = await import('./crud');
const { AdminDetail } = await import('./detail');
const { AdminForm } = await import('./form');

const notes = entity('admin_layout_notes', {
  columns: {
    id: uuid().primaryKey(),
    title: text({ max: 120 }),
    body: text(),
    email: text({ max: 120 }).nullable(),
    slug: text({ max: 60 }).nullable(),
    reason: text({ max: 120 }).nullable(),
  },
});

const db = database({ notes }, { driver: memoryDriver() });

beforeAll(installFactory);
afterAll(() => {
  restoreFactory();
  clearRegistry();
});

registerCatalog('en', {
  'admin.admin_layout_notes.title': 'Notes',
  'admin.admin_layout_notes.field.title': 'Title',
  'admin.admin_layout_notes.field.body': 'Body',
  'admin.admin_layout_notes.field.slug': 'Slug',
  'admin.admin_layout_notes.field.reason': 'Reason',
  'admin.admin_layout_notes.field.email': 'Email',
  'admin.notes.section.main': 'MAIN-SECTION',
  'admin.notes.hint.slug': 'SLUG-HINT',
  'admin.section.other': 'OTHER-SECTION',
});

let at = 0;
const admin = (resources: NonNullable<Parameters<typeof defineAdmin>[0]['resources']> = {}) => {
  at += 1;
  return defineAdmin({ basePath: `/layout-${String(at)}`, entities: [notes], db, resources });
};

const ROW = {
  id: '019b76da-a800-72d9-b1de-853f778ed158',
  title: 'Alpha',
  body: 'Long text',
  email: 'ops@example.com',
  slug: 'alpha',
  reason: null,
};

const detailHtml = (resource: ReturnType<ReturnType<typeof admin>['resource']>): string =>
  renderHtml(
    AdminDetail({
      resource,
      row: ROW,
      error: null,
      ctx: { timeZone: 'UTC', locale: 'en' },
      actor: { id: 'u' },
      authz: staticAuthz([]),
      audit: [],
      basePath: '/admin',
    }),
  );

describe('unit · detail sections', () => {
  test('a field named in no section still renders, in a default section drawn LAST', () => {
    const app = admin({
      admin_layout_notes: {
        sections: [{ titleKey: 'admin.notes.section.main', fields: ['title'] }],
        fields: { email: { sensitive: true } },
      },
    });
    const resource = app.resource('admin_layout_notes');
    expect(resource.sections.map((section) => section.titleKey)).toEqual([
      'admin.notes.section.main',
      DEFAULT_SECTION_KEY,
    ]);
    // Every field but the sensitive one, and none of them twice.
    expect(resource.sections.flatMap((section) => section.fields.map((f) => f.name))).toEqual([
      'title',
      'id',
      'body',
      'slug',
      'reason',
    ]);
    const html = detailHtml(resource);
    expect(html).toContain('MAIN-SECTION');
    expect(html.indexOf('MAIN-SECTION')).toBeLessThan(html.indexOf('OTHER-SECTION'));
    expect(html).toContain('Long text');
    expect(html).not.toContain('ops@example.com');
  });

  test('no declaration: one untitled section of every readable field', () => {
    const resource = admin({}).resource('admin_layout_notes');
    expect(resource.sections).toHaveLength(1);
    expect(resource.sections[0]?.titleKey).toBeNull();
    expect(detailHtml(resource)).not.toContain('OTHER-SECTION');
  });

  test('a name that is no drawn field, or that two sections claim, is refused where it is written', () => {
    expect(() =>
      admin({
        admin_layout_notes: {
          fields: { email: { sensitive: true } },
          sections: [{ titleKey: 'x', fields: ['email'] }],
        },
      }),
    ).toThrow(/X_ADMIN_FIELD_UNSUPPORTED[\s\S]*named in sections/);
    expect(() =>
      admin({
        admin_layout_notes: {
          sections: [
            { titleKey: 'a', fields: ['title'] },
            { titleKey: 'b', fields: ['title'] },
          ],
        },
      }),
    ).toThrow(/named in two sections groups/);
  });
});

describe('unit · form groups, hints and one-sided fields', () => {
  const app = admin({
    admin_layout_notes: {
      formGroups: [{ titleKey: 'admin.notes.section.main', fields: ['title', 'slug'] }],
      fields: {
        slug: { hintKey: 'admin.notes.hint.slug', on: 'create' },
        reason: { on: 'update' },
      },
    },
  });
  const resource = app.resource('admin_layout_notes');
  const form = (mode: 'create' | 'edit'): string =>
    renderHtml(
      AdminForm({
        resource,
        mode,
        values: ROW,
        issues: [],
        error: null,
        ctx: { timeZone: 'UTC', locale: 'en' },
        action: '/x',
        cancelHref: '/y',
        version: mode === 'edit' ? 'v1' : null,
      }),
    );

  test('declared groups first, a <fieldset> each; undeclared inputs fall into the default group', () => {
    const html = form('create');
    expect(html).toContain('<legend>MAIN-SECTION</legend>');
    expect(html).toContain('<legend>OTHER-SECTION</legend>');
    expect(html).toContain('name="title"');
    expect(html.indexOf('name="title"')).toBeLessThan(html.indexOf('name="body"'));
  });

  test('hintKey renders through t() under its control', () => {
    expect(form('create')).toContain('SLUG-HINT');
  });

  test('`on: create` is drawn on create only, `on: update` on edit only', () => {
    expect(form('create')).toContain('name="slug"');
    expect(form('create')).not.toContain('name="reason"');
    expect(form('edit')).not.toContain('name="slug"');
    expect(form('edit')).toContain('name="reason"');
  });

  test('and the write enforces the same sides, for a caller that is not the form', async () => {
    const ctx = app.ctx({ actor: { id: 'u', roles: [] }, requestId: 'r' });
    const open = { ...ctx, authz: staticAuthz(['admin:write', 'admin_layout_notes:write']) };
    const made = await adminCreate(resource, open, {
      title: 'T',
      body: 'B',
      slug: 'kept',
      reason: 'dropped on create',
    });
    expect(made.ok && made.row?.['slug']).toBe('kept');
    expect(made.ok && made.row?.['reason']).toBeNull();
    const id = String(made.ok ? made.row?.['id'] : '');
    const patched = await adminUpdate(resource, open, id, {
      slug: 'not on update',
      reason: 'kept on update',
    });
    expect(patched.ok && patched.row?.['slug']).toBe('kept');
    expect(patched.ok && patched.row?.['reason']).toBe('kept on update');
  });

  test('a form group naming a read-only field is refused', () => {
    expect(() =>
      admin({ admin_layout_notes: { formGroups: [{ titleKey: 'x', fields: ['id'] }] } }),
    ).toThrow(/named in formGroups[\s\S]*is not a form input/);
  });
});
