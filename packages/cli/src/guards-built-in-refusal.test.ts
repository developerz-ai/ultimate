// `x g guard <shipped name>` is refused with the row that changes how the guard reports; any other
// name is the app's own convention and passes.

import { describe, expect, test } from 'bun:test';
import { fixProblem } from './error-contract';
import { GUARD_BUILT_IN_CODE, refuseShippedGuardName } from './guards-built-in-refusal';

const refusal = (name: string): unknown => {
  try {
    refuseShippedGuardName(name);
    return undefined;
  } catch (error) {
    return error;
  }
};

describe('unit · x g guard · a shipped name is refused: it already runs', () => {
  test('a shipped name throws the code, with a fix the errors step accepts', () => {
    const error = refusal('raw-fetch');
    expect(error).toMatchObject({ code: GUARD_BUILT_IN_CODE });
    const fix = (error as { readonly fix: string }).fix;
    expect(fix).toStartWith('x verify --only boundaries --json');
    expect(fix).toContain('guards/shipped.json');
    expect(fixProblem(fix)).toBeUndefined();
  });

  test("an app's own name passes", () => {
    expect(refusal('migration-safety')).toBeUndefined();
  });
});
