// The form controls, asserted through the props their elements actually carry. Two of these are
// the classes of bug the package has already shipped once: an ARIA enumerated attribute collapsed
// to `false` when it should be absent, and a control whose current value is text content rather
// than an attribute.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { byTag, one, probe, renderNodes, unprobe, withAttr } from '../jsx-probe';
import { Input } from './Input';
import { Radio } from './Radio';
import { Textarea } from './Textarea';

const OPTIONS = [
  { value: 'card', label: 'Card' },
  { value: 'sepa', label: 'Direct debit', description: 'Two working days' },
  { value: 'cash', label: 'Cash', disabled: true },
];

describe('the form controls', () => {
  beforeAll(probe);
  afterAll(unprobe);

  test('they compile to a JSX factory this file understands', () => {
    expect(renderNodes(Input, {}).length).toBeGreaterThan(0);
  });

  describe('Radio', () => {
    const group = (props: Record<string, unknown> = {}) =>
      renderNodes(Radio, { legend: 'Payment', name: 'pay', options: OPTIONS, ...props });

    test('is a fieldset with a legend, so the group itself has a name', () => {
      const nodes = group();
      expect(nodes[0]?.type).toBe('fieldset');
      expect(one(byTag(nodes, 'legend'), 'legend').props['children']).toBe('Payment');
    });

    test('exactly the matching option is checked', () => {
      const inputs = byTag(group({ value: 'sepa' }), 'input');
      expect(inputs.map((node) => node.props['value'])).toEqual(['card', 'sepa', 'cash']);
      expect(inputs.map((node) => node.props['checked'])).toEqual([false, true, false]);
    });

    test('with no value nothing is pre-checked', () => {
      expect(byTag(group(), 'input').map((node) => node.props['checked'])).toEqual([
        false,
        false,
        false,
      ]);
    });

    test('every label points at the input beside it, and the ids are distinct', () => {
      const nodes = group();
      const ids = byTag(nodes, 'input').map((node) => node.props['id']);
      const fors = byTag(nodes, 'label').map((node) => node.props['for']);

      expect(fors).toEqual(ids);
      expect(new Set(ids).size).toBe(3);
      expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    });

    test('a per-option disabled does not disable the group, and vice versa', () => {
      expect(byTag(group(), 'input').map((node) => node.props['disabled'])).toEqual([
        false,
        false,
        true,
      ]);
      expect(group()[0]?.props['disabled']).toBe(false);
      expect(group({ disabled: true })[0]?.props['disabled']).toBe(true);
    });

    test('required lands on every radio, which is how the group becomes required', () => {
      expect(
        byTag(group({ required: true }), 'input').map((node) => node.props['required']),
      ).toEqual([true, true, true]);
      expect(byTag(group(), 'input').map((node) => node.props['required'])).toEqual([
        false,
        false,
        false,
      ]);
    });

    test('an option description renders beside its label, and only where given', () => {
      expect(byTag(group(), 'span').map((node) => node.props['children'])).toContain(
        'Two working days',
      );

      const bare = renderNodes(Radio, {
        legend: 'Payment',
        name: 'pay',
        options: [{ value: 'card', label: 'Card' }],
      });
      // The dot, the text wrapper and the label — no empty description element behind them.
      expect(byTag(bare, 'span')).toHaveLength(3);
    });

    test('the change handler is the caller’s, on every radio', () => {
      const seen: string[] = [];
      const nodes = group({ onChange: () => seen.push('changed') });
      for (const input of byTag(nodes, 'input')) {
        (input.props['onChange'] as () => void)();
      }
      expect(seen).toHaveLength(3);
    });
  });

  describe('Input', () => {
    test('defaults to a text control with an empty, always-present value', () => {
      const node = one(byTag(renderNodes(Input, {}), 'input'), 'input');
      expect(node.props['type']).toBe('text');
      expect(node.props['value']).toBe('');
      expect(node.props['required']).toBe(false);
      expect(node.props['disabled']).toBe(false);
    });

    test('aria-invalid is absent until asked, then the literal string form', () => {
      // Absent, "false" and "true" are three different states in the accessibility tree.
      expect(byTag(renderNodes(Input, {}), 'input')[0]?.props['aria-invalid']).toBeUndefined();
      expect(
        byTag(renderNodes(Input, { 'aria-invalid': false }), 'input')[0]?.props['aria-invalid'],
      ).toBe('false');
      expect(
        byTag(renderNodes(Input, { 'aria-invalid': true }), 'input')[0]?.props['aria-invalid'],
      ).toBe('true');
    });

    test('adornments are hidden from assistive tech, and absent when not given', () => {
      expect(renderNodes(Input, {})).toHaveLength(2);

      const nodes = renderNodes(Input, { prefix: '€', suffix: 'per month' });
      const hidden = withAttr(nodes, 'aria-hidden', 'true');
      expect(hidden.map((node) => node.props['children'])).toEqual(['€', 'per month']);
    });

    test('the disabled state is on the wrapper too, so the box can be styled', () => {
      expect(renderNodes(Input, {})[0]?.props['data-disabled']).toBeUndefined();
      expect(renderNodes(Input, { disabled: true })[0]?.props['data-disabled']).toBe('true');
    });

    test('numeric input is inputmode over type=number, so decimal separators survive', () => {
      const node = one(
        byTag(renderNodes(Input, { inputmode: 'decimal', type: 'text' }), 'input'),
        'input',
      );
      expect(node.props['type']).toBe('text');
      expect(node.props['inputmode']).toBe('decimal');
    });
  });

  describe('Textarea', () => {
    test('the value is text content, never a value attribute the parser would drop', () => {
      const node = one(byTag(renderNodes(Textarea, { value: 'hello' }), 'textarea'), 'textarea');
      expect(node.props['value']).toBeUndefined();
      // The leading newline is the serializer's: the parser strips exactly one after the tag, so
      // emitting it unconditionally is what lets a value starting with a newline round-trip.
      expect(node.props['children']).toBe('\nhello');
    });

    test('a value that itself starts with a newline survives the round trip', () => {
      const node = one(byTag(renderNodes(Textarea, { value: '\nkeep' }), 'textarea'), 'textarea');
      expect(node.props['children']).toBe('\n\nkeep');
    });

    test('an unset value is still text content, so the control is never undefined', () => {
      expect(byTag(renderNodes(Textarea, {}), 'textarea')[0]?.props['children']).toBe('\n');
    });

    test('rows is the floor for the natively growing box', () => {
      expect(byTag(renderNodes(Textarea, {}), 'textarea')[0]?.props['rows']).toBe(3);
      expect(byTag(renderNodes(Textarea, { rows: 8 }), 'textarea')[0]?.props['rows']).toBe(8);
    });

    test('aria-invalid follows the same three-state rule as Input', () => {
      expect(
        byTag(renderNodes(Textarea, {}), 'textarea')[0]?.props['aria-invalid'],
      ).toBeUndefined();
      expect(
        byTag(renderNodes(Textarea, { 'aria-invalid': false }), 'textarea')[0]?.props[
          'aria-invalid'
        ],
      ).toBe('false');
    });
  });
});
