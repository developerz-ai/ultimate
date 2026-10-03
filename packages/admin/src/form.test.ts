// The create/edit form. Three things it must get right beyond rendering inputs: it is a NATIVE
// post at the URL that rendered it (an admin screen never hydrates), an issue lands on the field
// it NAMES (and the summary deep-links to it), and a sealed column is an input nothing prefills.
// Asserted on the markup the framework's own server renderer emits — the form a browser submits.

import { describe, expect, test } from 'bun:test';
import { registerCatalog } from '@ultimat3/i18n';
import type { AdminField } from './fields';
import type { AdminResource } from './resource';
import type { ValidationIssue } from './validate';

const { renderComponent } = await import('@ultimat3/render/server');

import { ROW_CHANGED_REASON, VERSION_FIELD } from './row-version';

const { AdminForm } = await import('./form');

registerCatalog('en', {
  'admin.post.title': 'Post (probe)',
  'admin.form.create': 'New {entity} (probe)',
  'admin.form.edit': 'Edit {entity} (probe)',
  'admin.form.issues': 'Problems (probe)',
  'admin.form.save': 'Save (probe)',
  'admin.form.cancel': 'Cancel (probe)',
  'admin.form.secret-unchanged': 'Empty keeps it (probe)',
  'admin.error.secret-required': 'Secret needed (probe)',
  'admin.post.field.title': 'Title (probe)',
  'admin.post.field.body': 'Body (probe)',
  'admin.post.field.token': 'Token (probe)',
});

const field = (over: Partial<AdminField>): AdminField => ({
  entity: 'post',
  name: 'title',
  type: 'text',
  widget: 'text-input',
  labelKey: 'admin.post.field.title',
  required: true,
  readOnly: false,
  sensitive: false,
  inList: true,
  filterable: false,
  sortable: true,
  searchable: true,
  ...over,
});

const TITLE = field({});
const BODY = field({
  name: 'body',
  labelKey: 'admin.post.field.body',
  widget: 'textarea',
  type: 'textarea',
  required: false,
});
const TOKEN = field({
  name: 'token',
  labelKey: 'admin.post.field.token',
  widget: 'secret-input',
  type: 'secret',
  sensitive: true,
});

const resourceWith = (secretFields: readonly AdminField[]): AdminResource =>
  ({
    name: 'post',
    titleKey: 'admin.post.title',
    formFields: [TITLE, BODY],
    secretFields,
    // One untitled group holding every input — what a resource that declares no `formGroups` has.
    formGroups: [{ titleKey: null, fields: [TITLE, BODY, ...secretFields], default: true }],
  }) as unknown as AdminResource;

const render = (over: Record<string, unknown> = {}): Promise<string> =>
  renderComponent(
    () =>
      AdminForm({
        resource: resourceWith([]),
        mode: 'create',
        values: {},
        issues: [],
        error: null,
        ctx: { timeZone: 'UTC', locale: 'en-US' },
        action: '/admin/posts/new',
        cancelHref: '/admin/posts',
        version: null,
        ...over,
      } as never),
    {},
    'apps/admin/app/admin/page.tsx',
  );

/** The wrapper `<div id="x-admin-field-<name>">…` of one field, up to the next field or the end. */
const fieldBlock = (html: string, name: string): string => {
  const from = html.indexOf(`id="x-admin-field-${name}"`);
  if (from < 0) return '';
  const next = html.indexOf('id="x-admin-field-', from + 1);
  return html.slice(from, next < 0 ? undefined : next);
};

describe('the frame', () => {
  test('an error replaces the whole form — there is nothing to fill in', async () => {
    const html = await render({
      error: { code: 'X_ADMIN_DENIED', cause: 'no grant', fix: 'ask an owner' },
    });
    expect(html).toContain('ask an owner');
    expect(html).not.toContain('<form');
  });

  test('the heading names the mode AND the entity, interpolated', async () => {
    expect(await render()).toContain('New Post (probe) (probe)');
    expect(await render({ mode: 'edit' })).toContain('Edit Post (probe) (probe)');
  });
});

describe('a native form', () => {
  test('it POSTS at the URL that rendered it — there is no handler to intercept a submit', async () => {
    const html = await render();
    expect(html).toContain('method="post" action="/admin/posts/new"');
    expect(html).toContain('type="submit"');
    expect(html).toContain('Save (probe)');
  });

  test('cancel is a LINK back, never a second button', async () => {
    const html = await render();
    const [cancel = ''] = /<a[^>]*href="\/admin\/posts"[^>]*>[\s\S]*?<\/a>/.exec(html) ?? [];
    expect(cancel).toContain('Cancel (probe)');
    expect(html.match(/<button/g) ?? []).toHaveLength(1);
  });
});

describe('the version an edit is drawn against', () => {
  test('an edit carries it as a hidden field; a create carries none', async () => {
    const edit = await render({ mode: 'edit', version: 'h1:abc:def' });
    expect(edit).toContain(`name="${VERSION_FIELD}"`);
    expect(edit).toContain('value="h1:abc:def"');
    expect(await render()).not.toContain(VERSION_FIELD);
  });

  test('the row-changed issue names no control, so it links to none', async () => {
    const html = await render({
      mode: 'edit',
      version: 'v',
      issues: [{ path: VERSION_FIELD, message: 'changed', messageKey: ROW_CHANGED_REASON }],
    });
    expect(html).not.toContain(`href="#x-admin-field-${VERSION_FIELD}"`);
    // The key resolves in the framework catalog: a missing entry renders the raw key instead.
    expect(html).not.toContain(ROW_CHANGED_REASON);
    expect(html).toContain('Someone changed this row after you opened it.');
  });
});

describe('one input per form field', () => {
  test('each is labelled by its own key, named for its column, in its own anchor', async () => {
    const html = await render();
    expect(fieldBlock(html, 'title')).toContain('Title (probe)');
    expect(fieldBlock(html, 'title')).toContain('name="title"');
    expect(fieldBlock(html, 'body')).toContain('Body (probe)');
    expect(fieldBlock(html, 'body')).toContain('name="body"');
  });

  test("the required flag is the field's own", async () => {
    const html = await render();
    expect(fieldBlock(html, 'title')).toMatch(/<input[^>]*required/);
    expect(fieldBlock(html, 'body')).not.toMatch(/<textarea[^>]*required/);
  });

  test('the control holds the current value — the stored row, or what a refused post typed', async () => {
    const html = await render({ mode: 'edit', values: { title: 'Kept', body: 'Prose' } });
    expect(fieldBlock(html, 'title')).toContain('value="Kept"');
    expect(fieldBlock(html, 'body')).toContain('Prose');
  });
});

describe('validation issues land on the field they name', () => {
  const ISSUES: readonly ValidationIssue[] = [
    { path: 'title', message: 'too short' },
    { path: 'title', message: 'no emoji' },
    { path: 'body', message: 'too long' },
  ];

  test('no issues means no summary at all, not an empty alert', async () => {
    expect(await render()).not.toContain('x-admin-issues');
  });

  test('the summary is a focusable alert listing every issue, each deep-linked', async () => {
    const html = await render({ issues: ISSUES });
    const [summary = ''] = /<div class="x-admin-issues"[\s\S]*?<\/ul>/.exec(html) ?? [];
    expect(summary).toContain('role="alert"');
    expect(summary).toContain('tabindex="-1"');
    expect(summary.match(/href="#x-admin-field-title"/g) ?? []).toHaveLength(2);
    expect(summary).toContain('href="#x-admin-field-body"');
    expect(summary).toContain('too long');
  });

  test('a field’s own issues are joined onto it, and no other field’s are', async () => {
    const html = await render({ issues: ISSUES });
    expect(fieldBlock(html, 'title')).toContain('too short no emoji');
    expect(fieldBlock(html, 'title')).not.toContain('too long');
    expect(fieldBlock(html, 'body')).toContain('too long');
    expect(fieldBlock(html, 'title')).toContain('aria-invalid="true"');
  });

  test('an issue naming a field this form does not render is not attached to a neighbour', async () => {
    const html = await render({ issues: [{ path: 'ghost', message: 'haunted' }] });
    expect(fieldBlock(html, 'title')).not.toContain('haunted');
    expect(fieldBlock(html, 'body')).not.toContain('haunted');
    expect(html).toContain('haunted');
  });

  test('an issue the admin raised renders its KEY through t(), not the literal an agent reads', async () => {
    const html = await render({
      resource: resourceWith([TOKEN]),
      issues: [
        {
          path: 'token',
          message: 'literal for an agent',
          messageKey: 'admin.error.secret-required',
        },
      ],
    });
    expect(fieldBlock(html, 'token')).toContain('Secret needed (probe)');
    expect(html).not.toContain('literal for an agent');
  });
});

describe('a sealed column is a write-only input', () => {
  test('a password box with NO value, even when the values object carries one', async () => {
    const html = await render({
      resource: resourceWith([TOKEN]),
      mode: 'edit',
      values: { title: 'Kept', token: 'PLAINTEXT-CANARY' },
    });
    const block = fieldBlock(html, 'token');
    expect(block).toContain('type="password"');
    expect(block).toContain('name="token"');
    expect(html).not.toContain('PLAINTEXT-CANARY');
  });

  test('required to CREATE a row; on an edit it is optional and says an empty box keeps it', async () => {
    const creating = fieldBlock(await render({ resource: resourceWith([TOKEN]) }), 'token');
    expect(creating).toMatch(/<input[^>]*required/);
    expect(creating).not.toContain('Empty keeps it (probe)');

    const editing = fieldBlock(
      await render({ resource: resourceWith([TOKEN]), mode: 'edit' }),
      'token',
    );
    expect(editing).not.toMatch(/<input[^>]*required/);
    expect(editing).toContain('Empty keeps it (probe)');
  });
});
