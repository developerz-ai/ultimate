// A receiver error's `fix:` is a call to paste into a test: it must parse as TypeScript, the
// explanation a `//` comment after it — prose spliced onto the call is a syntax error once pasted.

import { describe, expect, test } from 'bun:test';
import {
  TestNumberExpectedError,
  TestOpenApiExpectedError,
  TestPolicyExpectedError,
} from './matcher-receiver-errors';

const transpiler = new Bun.Transpiler({ loader: 'ts' });

describe('unit · matcher receiver fixes', () => {
  test.each([
    ['policy', new TestPolicyExpectedError(1)],
    ['openapi', new TestOpenApiExpectedError(1)],
    ['budget measurement', new TestNumberExpectedError('1')],
    ['budget limit', new TestNumberExpectedError(undefined, 'limit')],
  ])('the %s fix parses as a call with a comment', (_name, error) => {
    expect(() => transpiler.transformSync(`async () => { ${error.fix}\n }`)).not.toThrow();
    expect(error.fix).toContain(')   // ');
  });
});
