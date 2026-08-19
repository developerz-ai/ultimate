// Edit mode: the control a form renders, and — the half a snapshot cannot see — what it emits
// back. `onInput`/`onChange` are called with the event shape the browser would hand them, so the
// assertion is on the VALUE the admin would save, not on the string that was typed.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { registerCatalog } from '@ultimat3/i18n';
import type { AdminField } from './fields';
import {
  byComponent,
  fire,
  installFactory,
  nodesOf,
  one,
  restoreFactory,
  withAttr,
} from './inert-jsx';
import type { WidgetContext } from './widget-value';
import { Widget } from './widgets';

registerCatalog('en', { 'admin.invoice.field.total': 'Total (probe)' });

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

const input = (edited: Edited): ReturnType<typeof one> =>
  one(byComponent(edited.control, 'Input'), '<Input>');

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

  test('the locale picker offers the framework locales', () => {
    const edited = edit({ widget: 'locale-picker', type: 'locale', name: 'locale' }, 'es');
    const select = one(byComponent(edited.control, 'Select'), '<Select>');
    expect((select.props['options'] as { value: string }[]).map((o) => o.value)).toEqual([
      'en',
      'es',
      'de',
      'fr',
      'pt',
      'ja',
    ]);
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

  test('a reference is edited as its raw id — the admin has no row picker', () => {
    const edited = edit({ widget: 'reference', type: 'relation', name: 'customerId' }, 'c_9');
    expect(input(edited).props['value']).toBe('c_9');
  });
});
