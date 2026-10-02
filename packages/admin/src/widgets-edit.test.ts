// Edit mode: the control a form renders, and — the half a snapshot cannot see — what it emits
// back. `onInput`/`onChange` are called with the event shape the browser would hand them, so the
// assertion is on the VALUE the admin would save, not on the string that was typed.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { registerCatalog, registeredLocales } from '@ultimat3/i18n';
import type { AdminField } from './fields';
import {
  byComponent,
  byTag,
  fire,
  installFactory,
  nodesOf,
  one,
  restoreFactory,
  withAttr,
} from './inert-jsx';
import type { WidgetContext } from './widget-value';

// `widgets.tsx` is JSX: loaded after `@ultimat3/render/server` installs its `.tsx` loader, never
// statically — a static import compiles it to the classic factory first, and every screen a later
// file in this process renders through it dies with `React is not defined`.
await import('@ultimat3/render/server');
const { Widget } = await import('./widgets');

registerCatalog('en', { 'admin.invoice.field.total': 'Total (probe)' });
// A locale the framework's bundled list never named. The locale picker must offer it — and must
// not offer the five this app did not register, which it would render as `⟦key⟧` for.
registerCatalog('it', { 'admin.invoice.field.total': 'Totale (probe)' });

beforeAll(installFactory);
afterAll(restoreFactory);

const field = (over: Partial<AdminField>): AdminField => ({
  entity: 'invoice',
  name: 'total',
  type: 'money',
  widget: 'money',
  labelKey: 'admin.invoice.field.total',
  required: true,
  readOnly: false,
  sensitive: false,
  inList: true,
  filterable: false,
  sortable: true,
  searchable: false,
  ...over,
});

const ctx: WidgetContext = { timeZone: 'Europe/Madrid', locale: 'es-ES' };

interface Edited {
  readonly control: ReturnType<typeof nodesOf>;
  readonly emitted: readonly (readonly [string, unknown])[];
}

/** Render one control in edit mode and keep everything it emitted, in order. */
function edit(
  over: Partial<AdminField>,
  value: unknown,
  control?: Record<string, unknown>,
): Edited {
  const emitted: [string, unknown][] = [];
  const nodes = nodesOf(
    Widget({
      field: field(over),
      value,
      ctx,
      mode: 'edit',
      ...(control === undefined ? {} : { control: control as never }),
      onInput: (name, next) => emitted.push([name, next]),
    }),
  );
  return { control: nodes, emitted };
}

/** The control itself. A money field also posts its currency beside it — that is `currencyOf`. */
const input = (edited: Edited): ReturnType<typeof one> =>
  one(
    byComponent(edited.control, 'Input').filter(
      (node) => !String(node.props['name'] ?? '').endsWith('.currency'),
    ),
    '<Input>',
  );

const typed = (text: string): unknown => ({ currentTarget: { value: text } });

describe('the field wiring from the surrounding <Field> reaches the control', () => {
  test('id, description, invalid and required are forwarded, not dropped', () => {
    const edited = edit({ widget: 'text-input', type: 'text', name: 'title' }, 'x', {
      id: 'f_title',
      'aria-describedby': 'f_title_err',
      'aria-invalid': true,
      required: true,
    });
    const node = input(edited);
    expect(node.props['id']).toBe('f_title');
    expect(node.props['aria-describedby']).toBe('f_title_err');
    expect(node.props['aria-invalid']).toBe(true);
    expect(node.props['required']).toBe(true);
  });

  test('a bare control carries none of them rather than undefined-valued attributes', () => {
    const node = input(edit({ widget: 'text-input', type: 'text', name: 'title' }, 'x'));
    expect('id' in node.props).toBe(false);
    expect('required' in node.props).toBe(false);
  });
});

describe('a read-only field renders a disabled control on every branch', () => {
  const READ_ONLY_CASES: readonly (readonly [string, Partial<AdminField>, unknown])[] = [
    ['text-input', { widget: 'text-input', type: 'text' }, 'x'],
    ['textarea', { widget: 'textarea', type: 'textarea' }, 'x'],
    ['number-input', { widget: 'number-input', type: 'number' }, 1],
    ['money', { widget: 'money', type: 'money' }, { minor: 1, currency: 'EUR' }],
    ['checkbox', { widget: 'checkbox', type: 'boolean' }, true],
    ['select', { widget: 'select', type: 'enum', values: ['a'] }, 'a'],
    ['datetime', { widget: 'datetime', type: 'timestamptz' }, '2026-08-18T10:00:00.000Z'],
    ['timezone-picker', { widget: 'timezone-picker', type: 'timezone' }, 'UTC'],
    ['locale-picker', { widget: 'locale-picker', type: 'locale' }, 'en'],
    ['json-editor', { widget: 'json-editor', type: 'json' }, { a: 1 }],
  ];

  for (const [name, over, value] of READ_ONLY_CASES) {
    test(`${name} is disabled when the column is generated`, () => {
      const { control } = edit({ ...over, readOnly: true }, value);
      expect(withAttr(control, 'disabled', true).length).toBeGreaterThan(0);
      const enabled = edit(over, value);
      expect(withAttr(enabled.control, 'disabled', true)).toHaveLength(0);
    });
  }
});

describe('number-input', () => {
  test('a locale decimal separator survives, so it is never type="number"', () => {
    const node = input(edit({ widget: 'number-input', type: 'number', name: 'qty' }, 7));
    expect(node.props['inputmode']).toBe('decimal');
    expect(node.props['type']).toBeUndefined();
    expect(node.props['value']).toBe('7');
  });

  test('zero renders as "0", not as the empty box that saves the blank back', () => {
    expect(input(edit({ widget: 'number-input', type: 'number' }, 0)).props['value']).toBe('0');
  });

  test('typing digits emits a number and clearing the box emits null', () => {
    const edited = edit({ widget: 'number-input', type: 'number', name: 'qty' }, 7);
    fire(input(edited), 'onInput', typed('42'));
    fire(input(edited), 'onInput', typed(''));
    expect(edited.emitted).toEqual([
      ['qty', 42],
      ['qty', null],
    ]);
  });
});

describe('money', () => {
  test('the box holds MINOR units and the currency rides beside it as a suffix', () => {
    const node = input(edit({}, { minor: 1999, currency: 'EUR' }));
    expect(node.props['value']).toBe('1999');
    expect(node.props['suffix']).toBe('EUR');
    expect(node.props['inputmode']).toBe('numeric');
  });

  test('an empty row falls back to the field currency, never to a blank one', () => {
    // The row carries no money at all: without the declared currency the operator types minor
    // units into a box that cannot say what they are.
    expect(input(edit({ currency: 'JPY' }, null)).props['suffix']).toBe('JPY');
    expect(input(edit({}, null)).props['value']).toBe('');
  });

  test('typing emits { minor, currency } — never a float and never a bare number', () => {
    const edited = edit({ currency: 'JPY' }, null);
    fire(input(edited), 'onInput', typed('500'));
    fire(input(edited), 'onInput', typed(''));
    expect(edited.emitted).toEqual([
      ['total', { minor: 500, currency: 'JPY' }],
      ['total', null],
    ]);
  });
});

describe('money posts BOTH halves — a native form has no handler to assemble them', () => {
  test('a known currency rides hidden beside the amount, under <field>.currency', () => {
    const edited = edit({}, { minor: 1999, currency: 'EUR' });
    const hidden = one(
      byTag(edited.control, 'input').filter((node) => node.props['type'] === 'hidden'),
      'the hidden currency',
    );
    expect(hidden.props['name']).toBe('total.currency');
    expect(hidden.props['value']).toBe('EUR');
  });

  test('an unknown currency is ASKED for, never posted blank', () => {
    const edited = edit({}, null);
    const asked = one(
      byComponent(edited.control, 'Input').filter(
        (node) => node.props['name'] === 'total.currency',
      ),
      'the currency box',
    );
    expect(asked.props['maxlength']).toBe(3);
    expect(
      byTag(edited.control, 'input').filter((node) => node.props['type'] === 'hidden'),
    ).toHaveLength(0);
  });
});

describe('secret-input — a sealed column is written, never shown', () => {
  test('a password box with no value, whatever the row holds', () => {
    const edited = edit({ widget: 'secret-input', type: 'secret', name: 'token' }, 'PLAINTEXT');
    const node = input(edited);
    expect(node.props['type']).toBe('password');
    expect(node.props['name']).toBe('token');
    expect('value' in node.props).toBe(false);
    expect(node.props['autocomplete']).toBe('new-password');
    expect(JSON.stringify(edited.control.map((entry) => entry.props))).not.toContain('PLAINTEXT');
  });
});

describe('checkbox', () => {
  test('the label comes from the field key and the change emits a boolean', () => {
    const edited = edit({ widget: 'checkbox', type: 'boolean', name: 'paid' }, true);
    const box = one(byComponent(edited.control, 'Checkbox'), '<Checkbox>');
    expect(box.props['label']).toBe('Total (probe)');
    expect(box.props['checked']).toBe(true);

    fire(box, 'onChange', { currentTarget: { checked: false } });
    expect(edited.emitted).toEqual([['paid', false]]);
  });
});

describe('select', () => {
  test('every declared value becomes an option, labelled by its own key', () => {
    const edited = edit(
      { widget: 'select', type: 'enum', name: 'state', values: ['draft', 'live'] },
      'live',
    );
    const select = one(byComponent(edited.control, 'Select'), '<Select>');
    expect(select.props['value']).toBe('live');
    // Keyed off the entity and the FIELD NAME (`widget-value.ts`'s `optionsFor`), which is the
    // derived `labelKey` spelled out — see the sibling assertion in `widgets-read.test.ts`.
    expect(select.props['options']).toEqual([
      { value: 'draft', label: '⟦admin.invoice.field.state.option.draft⟧' },
      { value: 'live', label: '⟦admin.invoice.field.state.option.live⟧' },
    ]);

    fire(select, 'onChange', typed('draft'));
    expect(edited.emitted).toEqual([['state', 'draft']]);
  });

  test('a null value renders as the empty option rather than as the string "null"', () => {
    const edited = edit({ widget: 'select', type: 'enum', values: ['draft'] }, null);
    expect(one(byComponent(edited.control, 'Select'), '<Select>').props['value']).toBe('');
  });
});

describe('datetime', () => {
  test('an instant edits in UTC and says so beside the box', () => {
    const edited = edit(
      { widget: 'datetime', type: 'timestamptz', name: 'sentAt' },
      '2026-08-18T23:30:00.000Z',
    );
    const node = input(edited);
    expect(node.props['type']).toBe('datetime-local');
    // `datetime-local` takes `YYYY-MM-DDTHH:mm` and nothing else; the seconds would be rejected.
    expect(node.props['value']).toBe('2026-08-18T23:30');
    expect(node.props['suffix']).toBe('UTC');
  });

  test('a calendar date edits as a date, with no zone label to mislead the operator', () => {
    const node = input(edit({ widget: 'datetime', type: 'date', name: 'due' }, '2026-08-18'));
    expect(node.props['type']).toBe('date');
    expect(node.props['value']).toBe('2026-08-18');
    expect(node.props['suffix']).toBeUndefined();
  });

  test('an empty timestamp renders an empty box rather than the epoch', () => {
    expect(input(edit({ widget: 'datetime', type: 'timestamptz' }, null)).props['value']).toBe('');
  });
});

describe('the pickers read the runtime, not a bundled copy', () => {
  test('the timezone picker offers the runtime IANA list and always contains UTC', () => {
    const edited = edit({ widget: 'timezone-picker', type: 'timezone', name: 'tz' }, 'UTC');
    const select = one(byComponent(edited.control, 'Select'), '<Select>');
    const options = select.props['options'] as { value: string; label: string }[];
    expect(options.length).toBeGreaterThan(1);
    expect(options.map((option) => option.value)).toContain('Europe/Madrid');
    // Zone names are not translated: the label IS the IANA id an operator must recognise.
    expect(options.every((option) => option.value === option.label)).toBe(true);

    fire(select, 'onChange', typed('Asia/Tokyo'));
    expect(edited.emitted).toEqual([['tz', 'Asia/Tokyo']]);
  });

  /**
   * `return ['en','es','de','fr','pt','ja']` — a bundled six-locale list, one line under a comment
   * forbidding exactly that for IANA zones. An app registering `it` could not pick it; an app with
   * only `en` was offered five locales every string of which renders `⟦key⟧`. The registry is the
   * runtime's own answer, and `@ultimat3/i18n` is tier 1 — downward from here, already imported
   * for `t`.
   */
  test('the locale picker offers the locales this app registered, and only those', () => {
    const edited = edit({ widget: 'locale-picker', type: 'locale', name: 'locale' }, 'it');
    const select = one(byComponent(edited.control, 'Select'), '<Select>');
    const values = (select.props['options'] as { value: string }[]).map((option) => option.value);

    // Compared to the REGISTRY, never to a literal: a list written out here would be the same
    // defect one file over, and would go stale the first time this suite registered a locale.
    expect(values).toEqual([...registeredLocales()]);
    expect(values).toContain('it');
    // A locale code is an identifier an operator must recognise, so it is not translated — the
    // same rule the zone picker above states.
    const options = select.props['options'] as { value: string; label: string }[];
    expect(options.every((option) => option.value === option.label)).toBe(true);
  });
});

describe('textarea and json', () => {
  test('a textarea round-trips its text', () => {
    const edited = edit({ widget: 'textarea', type: 'textarea', name: 'body' }, 'hello');
    const area = one(byComponent(edited.control, 'Textarea'), '<Textarea>');
    expect(area.props['value']).toBe('hello');
    fire(area, 'onInput', typed('bye'));
    expect(edited.emitted).toEqual([['body', 'bye']]);
  });

  test('the json editor is a textarea carrying the admin json class and pretty-printed text', () => {
    const edited = edit({ widget: 'json-editor', type: 'json', name: 'meta' }, { a: 1 });
    const area = one(byComponent(edited.control, 'Textarea'), '<Textarea>');
    expect(area.props['class']).toBe('x-admin-json');
    expect(area.props['value']).toBe('{\n  "a": 1\n}');
  });
});

describe('the default branch', () => {
  test('text falls through to a plain Input that emits what was typed', () => {
    const edited = edit({ widget: 'text-input', type: 'text', name: 'title' }, 'Hello');
    const node = input(edited);
    expect(node.props['value']).toBe('Hello');
    fire(node, 'onInput', typed('Goodbye'));
    expect(edited.emitted).toEqual([['title', 'Goodbye']]);
  });

  test('a reference with nothing read of its target is edited as its raw id', () => {
    const edited = edit({ widget: 'reference', type: 'relation', name: 'customerId' }, 'c_9');
    expect(input(edited).props['value']).toBe('c_9');
    expect(byTag(edited.control, 'a')).toHaveLength(0);
  });

  describe('a reference picks from what the PAGE read of its target', () => {
    const customer: Partial<AdminField> = {
      widget: 'reference',
      type: 'relation',
      name: 'customerId',
      relation: { entity: 'customers' },
    };
    const picking = (over: Partial<WidgetContext>, value: unknown = 'c_9') =>
      nodesOf(Widget({ field: field(customer), value, ctx: { ...ctx, ...over }, mode: 'edit' }));

    test('a small target is a <select> of its rows by label, with an empty first option', () => {
      const nodes = picking({
        optionsFor: (entity) =>
          entity === 'customers'
            ? [
                { id: 'c_9', label: 'Acme' },
                { id: 'c_2', label: 'Globex' },
              ]
            : null,
      });
      const select = one(byComponent(nodes, 'Select'), '<Select>');
      expect(select.props['name']).toBe('customerId');
      expect(select.props['value']).toBe('c_9');
      expect((select.props['options'] as { value: string; label: string }[]).slice(1)).toEqual([
        { value: 'c_9', label: 'Acme' },
        { value: 'c_2', label: 'Globex' },
      ]);
      expect((select.props['options'] as { value: string }[])[0]?.value).toBe('');
      expect(byComponent(nodes, 'Input')).toHaveLength(0);
    });

    test('a large target is the id in a text box, its label beside it, and a link to its lookup', () => {
      const nodes = picking({
        optionsFor: () => null,
        labelFor: (_entity, id) => (id === 'c_9' ? 'Acme' : undefined),
        lookupHref: (entity) => `/admin/${entity}/lookup`,
      });
      const box = one(byComponent(nodes, 'Input'), '<Input>');
      expect(box.props['value']).toBe('c_9');
      expect(box.props['suffix']).toBe('Acme');
      const link = one(byTag(nodes, 'a'), 'the lookup link');
      expect(link.props['href']).toBe('/admin/customers/lookup');
      // A new tab: the form the operator is filling in must still be there when they come back.
      expect(link.props['target']).toBe('_blank');
    });

    test('a target that is not an admin resource gets the box and no link', () => {
      const nodes = picking({ lookupHref: () => null }, null);
      expect(one(byComponent(nodes, 'Input'), '<Input>').props['value']).toBe('');
      expect(byTag(nodes, 'a')).toHaveLength(0);
    });
  });
});
