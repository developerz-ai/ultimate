// The other direction of the one grammar: what a `<form>` submits, shaped the way the action's
// input schema declares it — so a rejection's path is the same string the control was named with.

import { describe, expect, test } from 'bun:test';
import { UI_ERROR_CODES } from '../errors';
import { valuesOfForm } from './form-values';

const formData = (entries: readonly (readonly [string, string])[]): FormData => {
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
  return data;
};

const refusal = expect.objectContaining({ code: UI_ERROR_CODES.formPathInvalid });

describe('valuesOfForm', () => {
  test('builds the nested shape the control names describe', () => {
    const values = valuesOfForm(
      formData([
        ['title', 'Hello'],
        ['author.name', 'Ada'],
        ['items[0].price', '300'],
        ['items[1].price', '450'],
      ]),
    );
    expect(values).toEqual({
      title: 'Hello',
      author: { name: 'Ada' },
      items: [{ price: '300' }, { price: '450' }],
    });
  });

  test('repeated names collect in document order — a multi-select has one name and many values', () => {
    expect(
      valuesOfForm(
        formData([
          ['tags', 'a'],
          ['tags', 'b'],
        ]),
      ),
    ).toEqual({ tags: ['a', 'b'] });
  });

  test('a control named __proto__ is refused, never assigned through', () => {
    expect(() => valuesOfForm(formData([['__proto__.polluted', 'yes']]))).toThrow(refusal);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  test('a name the grammar cannot read is refused rather than guessed at', () => {
    expect(() => valuesOfForm(formData([['items.0.price', '1']]))).toThrow(refusal);
    expect(() => valuesOfForm(formData([['', 'x']]))).toThrow(refusal);
  });

  test('two controls describing different shapes for one path are refused', () => {
    expect(() =>
      valuesOfForm(
        formData([
          ['user', 'ada'],
          ['user.name', 'Ada'],
        ]),
      ),
    ).toThrow(refusal);
    // The cause names the path where the two DISAGREE — the shared prefix, not the second control's
    // own path: `user` is the segment one name calls an array and the other an object.
    expect(() =>
      valuesOfForm(
        formData([
          ['user[0]', 'ada'],
          ['user.name', 'Ada'],
        ]),
      ),
    ).toThrow(
      expect.objectContaining({
        code: UI_ERROR_CODES.formPathInvalid,
        cause:
          'form control "user.name" cannot be read: "user" already holds a value of another shape',
      }),
    );
  });

  /** The same collision the other way round: the container is built first, then a leaf claims it. */
  test('a name that lands on a path another name already filled is refused', () => {
    expect(() =>
      valuesOfForm(
        formData([
          ['user.name', 'Ada'],
          ['user', 'ada'],
        ]),
      ),
    ).toThrow(refusal);
  });

  test('an empty form is an empty object, not a refusal', () => {
    expect(valuesOfForm(new FormData())).toEqual({});
  });
});
