// The `bare-error` guard as `x new` emits it, run through the gate's own seam. The slipping forms
// (K19) are here: `throw Error(…)` with no `new`, and the builtin classes the rule did not list.
// Every throw is spelled inside a string: `scripts/test-bare-error.ts` reads one outside a string
// as this test stating its own verdict. The rule's own cases ship beside it, in the app.

import { describe, expect, test } from 'bun:test';
import { shippedGuardFindings } from './shipped-guard-fixture';

const REPO = 'apps/web/app/post/repo.ts';

const findingsFor = (statement: string) =>
  shippedGuardFindings('bare-error', {
    [REPO]: `export const byId = () => {\n  ${statement}\n};\n`,
  });

const BUILTINS = [
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'EvalError',
  'URIError',
  'AggregateError',
];

describe('unit · shipped guard · bare-error', () => {
  test('every builtin class is refused, with and without `new`', async () => {
    const files: Record<string, string> = {};
    for (const [index, name] of BUILTINS.entries()) {
      files[`apps/web/app/a${index}/repo.ts`] =
        `export const a = () => {\n  throw new ${name}('x');\n};\n`;
      files[`apps/web/app/b${index}/repo.ts`] =
        `export const b = () => {\n  throw ${name}('x');\n};\n`;
    }
    const findings = await shippedGuardFindings('bare-error', files);
    expect(findings.map((finding) => finding.code)).toEqual(
      Array.from({ length: BUILTINS.length * 2 }, () => 'X_BARE_ERROR'),
    );
  });

  test('the finding names the class actually thrown', async () => {
    const findings = await findingsFor("throw URIError('bad link');");
    expect(findings[0]?.cause).toContain('throws a bare URIError');
  });

  test('a subclass, a lookalike name and an Error that is input stay silent', async () => {
    for (const statement of [
      'throw new PostError(missingPost(id));',
      "throw new MyTypeError('x');",
      "throw ErrorLike('x');",
      "controller.abort(new TypeError('cancelled'));",
    ]) {
      expect(await findingsFor(statement)).toEqual([]);
    }
  });
});
