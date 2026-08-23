// The create/edit form. Two things it must get right beyond rendering inputs: an issue lands on
// the field it NAMES (and the summary deep-links to it), and a submit is intercepted rather than
// letting the browser navigate away from a controlled form.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { registerCatalog } from '@ultimat3/i18n';
import type { AdminField } from './fields';
import {
  byComponent,
  byTag,
  fire,
  installFactory,
  one,
  renderShallowNodes,
  restoreFactory,
  shallowNodesOf,
  withAttr,
} from './inert-jsx';
import type { AdminResource } from './resource';
import type { ValidationIssue } from './validate';

await import('@ultimat3/render/server');
const { AdminForm } = await import('./form');

registerCatalog('en', {
  'admin.post.title': 'Post (probe)',
  'admin.form.create': 'New {entity} (probe)',
  'admin.form.edit': 'Edit {entity} (probe)',
  'admin.form.issues': 'Problems (probe)',
  'admin.form.save': 'Save (probe)',
  'admin.form.saving': 'Saving (probe)',
  'admin.form.cancel': 'Cancel (probe)',
  'admin.post.field.title': 'Title (probe)',
  'admin.post.field.body': 'Body (probe)',
});

beforeAll(installFactory);
afterAll(restoreFactory);

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

const resource = {
  name: 'post',
  titleKey: 'admin.post.title',
  formFields: [TITLE, BODY],
} as unknown as AdminResource;

interface Rendered {
  readonly nodes: ReturnType<typeof shallowNodesOf>;
  readonly inputs: (readonly [string, unknown])[];
  readonly submits: number[];
  readonly cancels: number[];
}

function render(over: Record<string, unknown> = {}): Rendered {
  const inputs: [string, unknown][] = [];
  const submits: number[] = [];
  const cancels: number[] = [];
  const nodes = renderShallowNodes(AdminForm, {
    resource,
    mode: 'create',
    values: {},
    issues: [],
    submitting: false,
    error: null,
    ctx: { timeZone: 'UTC', locale: 'en-US' },
    onInput: (name: string, value: unknown) => inputs.push([name, value]),
    onSubmit: () => submits.push(1),
    onCancel: () => cancels.push(1),
    ...over,
  });
  return { nodes, inputs, submits, cancels };
}

const fieldsOf = (rendered: Rendered): ReturnType<typeof byComponent> =>
  byComponent(rendered.nodes, 'Field');

describe('the frame', () => {
  test('an error replaces the whole form — there is nothing to fill in', () => {
    const rendered = render({
      error: { code: 'X_ADMIN_DENIED', cause: 'no grant', fix: 'ask an owner' },
    });
    const state = one(byComponent(rendered.nodes, 'ErrorState'), '<ErrorState>');
    expect((state.props['error'] as { fix: string }).fix).toBe('ask an owner');
    expect(byTag(rendered.nodes, 'form')).toHaveLength(0);
  });

  test('the heading names the mode AND the entity, interpolated', () => {
    const header = one(byComponent(render().nodes, 'Card'), '<Card>').props['header'];
    expect(one(shallowNodesOf(header), '<h2>').props['children']).toBe('New Post (probe) (probe)');

    const editing = one(byComponent(render({ mode: 'edit' }).nodes, 'Card'), '<Card>').props[
      'header'
    ];
    expect(one(shallowNodesOf(editing), '<h2>').props['children']).toBe(
      'Edit Post (probe) (probe)',
    );
  });
});

describe('one input per form field', () => {
  test('each field is labelled by its own key and carries its required flag', () => {
    const fields = fieldsOf(render());
    expect(fields.map((node) => node.props['label'])).toEqual(['Title (probe)', 'Body (probe)']);
    expect(fields.map((node) => node.props['required'])).toEqual([true, false]);
  });

  test('the widget is in EDIT mode, holds the current value, and reports what was typed', () => {
    const rendered = render({ values: { title: 'Hello', body: 'World' } });
    const control = { id: 'f_title', 'aria-describedby': undefined };
    const titleField = one(
      [fieldsOf(rendered)[0]].filter((node) => node !== undefined),
      '<Field>',
    );
    // `<Field>`'s child is a FUNCTION of the control wiring — that is how ui hands an id and an
    // `aria-describedby` down to whatever renders the input.
    const renderControl = titleField.props['children'] as (c: unknown) => unknown;
    const widget = one(byComponent(shallowNodesOf(renderControl(control)), 'Widget'), '<Widget>');

    expect(widget.props['mode']).toBe('edit');
    expect(widget.props['value']).toBe('Hello');
    // The control wiring from `<Field>` is forwarded, which is what ties the label to the input.
    expect(widget.props['control']).toBe(control);

    (widget.props['onInput'] as (name: string, value: unknown) => void)('title', 'Changed');
    expect(rendered.inputs).toEqual([['title', 'Changed']]);
  });

  test('each field sits in the anchor the issue summary links to', () => {
    const ids = withAttr(render().nodes, 'id').map((node) => node.props['id']);
    expect(ids).toEqual(['x-admin-field-title', 'x-admin-field-body']);
  });
});

describe('validation issues land on the field they name', () => {
  const ISSUES: readonly ValidationIssue[] = [
    { path: 'title', message: 'is required' },
    { path: 'title', message: 'must be under 120 characters' },
    { path: 'body', message: 'is not valid markdown' },
  ];

  test('no issues means no summary at all, not an empty alert', () => {
    expect(withAttr(render().nodes, 'role', 'alert')).toHaveLength(0);
  });

  test('the summary is a focusable alert listing every issue, each deep-linked', () => {
    const rendered = render({ issues: ISSUES });
    const summary = one(withAttr(rendered.nodes, 'role', 'alert'), 'the summary');
    expect(summary.props['class']).toBe('x-admin-issues');
    // `tabindex={-1}` is what lets the route move focus here after a failed submit.
    expect(summary.props['tabindex']).toBe(-1);

    const links = byTag(rendered.nodes, 'a');
    expect(links.map((link) => link.props['href'])).toEqual([
      '#x-admin-field-title',
      '#x-admin-field-title',
      '#x-admin-field-body',
    ]);
  });

  test('a field’s own issues are joined onto it, and no other field’s are', () => {
    const fields = fieldsOf(render({ issues: ISSUES }));
    expect(fields[0]?.props['error']).toBe('is required must be under 120 characters');
    expect(fields[1]?.props['error']).toBe('is not valid markdown');
  });

  test('a field with no issue carries NO error, rather than an empty string', () => {
    const fields = fieldsOf(render({ issues: [{ path: 'body', message: 'nope' }] }));
    // An empty string is a rendered-but-blank error region; `undefined` is no region at all.
    expect(fields[0]?.props['error']).toBeUndefined();
    expect(fields[1]?.props['error']).toBe('nope');
  });

  test('an issue naming a field this form does not render is not attached to a neighbour', () => {
    const fields = fieldsOf(render({ issues: [{ path: 'authorId', message: 'unknown' }] }));
    expect(fields.every((node) => node.props['error'] === undefined)).toBe(true);
  });
});

describe('submitting', () => {
  test('the submit is intercepted — a controlled form must not navigate', () => {
    const rendered = render();
    const prevented: number[] = [];
    fire(one(byTag(rendered.nodes, 'form'), '<form>'), 'onSubmit', {
      preventDefault: () => prevented.push(1),
    });
    expect(prevented).toEqual([1]);
    expect(rendered.submits).toEqual([1]);
  });

  test('the save button is disabled while in flight, and says so', () => {
    const idle = byTag(render().nodes, 'button');
    expect(idle[0]?.props['disabled']).toBe(false);
    expect(idle[0]?.props['children']).toBe('Save (probe)');

    const busy = byTag(render({ submitting: true }).nodes, 'button');
    expect(busy[0]?.props['disabled']).toBe(true);
    expect(busy[0]?.props['children']).toBe('Saving (probe)');
  });

  test('cancel is a plain button, never a second submit', () => {
    const rendered = render();
    const cancel = byTag(rendered.nodes, 'button')[1];
    expect(cancel?.props['type']).toBe('button');
    fire(cancel as never, 'onClick', {});
    expect(rendered.cancels).toEqual([1]);
    expect(rendered.submits).toEqual([]);
  });
});
