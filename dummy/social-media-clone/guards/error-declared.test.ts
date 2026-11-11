// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { undeclaredErrors } from './error-declared';

const file = (source: string) => [{ path: 'apps/web/app/post/errors.ts', source }];

/** Spelled from parts, so a grep of the app for a handwritten subclass finds only real ones. */
const EXTENDS = ['extends', 'UltimateError'].join(' ');

unitTest('a handwritten subclass is refused, and the finding names the line', () => {
  const findings = undeclaredErrors(file(`const x = 1;\nexport class PostNotFound ${EXTENDS} {}`));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('X_ERROR_DECLARED');
  expect(findings[0]?.cause).toContain(':2');
});

unitTest('a literal code handed to new UltimateError is refused', () => {
  expect(
    undeclaredErrors(
      file("throw new UltimateError({ code: 'X_NOT_FOUND', cause: 'c', fix: 'x' });"),
    ),
  ).toHaveLength(1);
  expect(
    undeclaredErrors(file("new UltimateError({ cause: 'c', code: \"X_NOT_FOUND\", fix: 'x' });")),
  ).toHaveLength(1);
});

unitTest('a re-raise passing err.code is not a declaration', () => {
  expect(
    undeclaredErrors(
      file("new UltimateError({ code: err.code, cause: err.cause, fix: 'x verify' });"),
    ),
  ).toEqual([]);
});

unitTest('defineError is what the rule asks for, and a comment is not code', () => {
  expect(
    undeclaredErrors(
      file(
        "export const Gone = defineError({ code: 'X_FORBIDDEN', title: 't', status: 410, cause: 'c', fix: 'x' });",
      ),
    ),
  ).toEqual([]);
  expect(undeclaredErrors(file(`// class Old ${EXTENDS} {}`))).toEqual([]);
});

unitTest('an aliased or namespaced UltimateError is the same class', () => {
  const aliased = "import { UltimateError as Base } from '@ultimat3/core';\n";
  expect(
    undeclaredErrors(
      file(`${aliased}export class A ${EXTENDS.replace('UltimateError', 'Base')} {}`),
    ),
  ).toHaveLength(1);
  const namespaced = "import * as core from '@ultimat3/core';\n";
  expect(
    undeclaredErrors(
      file(
        `${namespaced}throw new core.UltimateError({ code: 'X_NOT_FOUND', cause: 'c', fix: 'x' });`,
      ),
    ),
  ).toHaveLength(1);
});

unitTest(
  'a code spread in, or behind a value, is refused; one nested in meta is not the code',
  () => {
    expect(
      undeclaredErrors(
        file("throw new UltimateError({ ...{ code: 'X_NOT_FOUND' }, cause: 'c', fix: 'x' });"),
      ),
    ).toHaveLength(1);
    expect(undeclaredErrors(file('throw new UltimateError(init);'))).toHaveLength(1);
    expect(
      undeclaredErrors(
        file(
          "new UltimateError({ code: err.code, cause: 'c', fix: 'x', meta: { code: 'X_TIMEOUT' } });",
        ),
      ),
    ).toEqual([]);
  },
);

unitTest('defineError from the barrel is refused; from the page subpath it is the rule', () => {
  const declared =
    "defineError({ code: 'X_NOT_FOUND', title: 't', status: 404, cause: 'c', fix: 'x' });";
  expect(
    undeclaredErrors(file(`import { defineError } from '@ultimat3/core';\n${declared}`)),
  ).toHaveLength(1);
  expect(
    undeclaredErrors(file(`import { defineError } from '@ultimat3/core/page';\n${declared}`)),
  ).toEqual([]);
});

unitTest('an alias from the page subpath and a quoted code key are the same rule', () => {
  const paged = "import { UltimateError as PageError } from '@ultimat3/core/page';\n";
  expect(
    undeclaredErrors(
      file(`${paged}throw new PageError({ code: 'X_NOT_FOUND', cause: 'c', fix: 'x' });`),
    ),
  ).toHaveLength(1);
  expect(
    undeclaredErrors(
      file("throw new UltimateError({ 'code': 'X_INTERNAL', cause: 'c', fix: 'x' });"),
    ),
  ).toHaveLength(1);
});
