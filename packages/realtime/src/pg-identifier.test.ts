// The identifier gate's refusal: an env-named slot or publication gets the variable to export,
// already folded into the charset, so the paste is accepted by the very check that refused it.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { assertIdentifier } from './pg-identifier';

const fixOf = (kind: string, value: string): string => {
  try {
    assertIdentifier(kind, value);
  } catch (error) {
    if (isUltimateError(error)) return error.fix;
  }
  return expect.unreachable(`${kind} "${value}" was accepted`);
};

describe('assertIdentifier', () => {
  test('a slot is refused with the REPLICATION_SLOT the gate accepts', () => {
    const fix = fixOf('slot', 'My-Slot');
    expect(fix).toStartWith('export REPLICATION_SLOT=my_slot   # ');
    expect(assertIdentifier('slot', 'my_slot')).toBe('my_slot');
  });

  test('a digit-led publication is prefixed, never left for the gate to refuse again', () => {
    expect(fixOf('publication', '9pub')).toStartWith('export REPLICATION_PUBLICATION=x_9pub   # ');
  });

  test('an entity is a table name, not a variable: no export is offered', () => {
    expect(fixOf('entity', 'Posts')).not.toContain('export');
  });
});
