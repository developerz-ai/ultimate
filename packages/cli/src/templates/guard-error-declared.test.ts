// The `error-declared` guard as `x new` emits it, run through the gate's own seam: a handwritten
// subclass and a literal-coded construction are refused, a re-raise and a `defineError` pass. The
// rule's own cases ship beside it, in the app.

import { describe, expect, test } from 'bun:test';
import { guardCode } from './guard';
import { shippedGuardFindings } from './shipped-guard-fixture';

const ERRORS = 'apps/web/app/post/errors.ts';
const CODE = guardCode('error-declared');

const findingsFor = (source: string, path: string = ERRORS) =>
  shippedGuardFindings('error-declared', { [path]: source });

describe('unit · shipped guard · error-declared', () => {
  test('a class extending UltimateError is refused at its line, with defineError as the fix', async () => {
    const findings = await findingsFor(
      "import { UltimateError } from '@ultimat3/core';\n\n" +
        'export class PostNotFound extends UltimateError {\n' +
        "  constructor() { super({ code: 'X_POST_NOT_FOUND', cause: 'c', fix: 'x' }); }\n}\n",
    );
    expect(findings.map((finding) => finding.code)).toEqual([CODE]);
    expect(findings[0]?.cause).toContain(`${ERRORS}:3`);
    expect(findings[0]?.fix).toContain('defineError({ code, title, status, cause, fix })');
    expect(findings[0]?.at).toBe(ERRORS);
  });

  test('a literal code handed to new UltimateError is refused, wherever the key sits', async () => {
    const findings = await findingsFor(
      "throw new UltimateError({ code: 'X_POST_NOT_FOUND', cause: 'c', fix: 'x' });\n" +
        'throw new UltimateError({\n  cause: `no ' +
        '$' +
        '{ref}`,\n  code: "X_POST_GONE",\n  fix: "x",\n});\n',
    );
    expect(findings).toHaveLength(2);
    expect(findings[1]?.cause).toContain(`${ERRORS}:2`);
  });

  test('a re-raise passing err.code, a defineError and a comment are silent', async () => {
    const findings = await findingsFor(
      "import { defineError, UltimateError } from '@ultimat3/core';\n" +
        "export const Gone = defineError({ code: 'X_POST_GONE', title: 't', status: 410, cause: 'c', fix: 'x' });\n" +
        'export const wrap = (err: UltimateError) =>\n' +
        "  new UltimateError({ code: err.code, cause: err.cause, fix: 'x verify', sourceError: err });\n" +
        '// class Old extends UltimateError {}\n' +
        "/* new UltimateError({ code: 'X_OLD' }) */\n",
    );
    expect(findings).toEqual([]);
  });

  test('a test file and a declaration file are out of scope', async () => {
    const source = 'class Fixture extends UltimateError {}\n';
    expect(await findingsFor(source, 'apps/web/app/post/errors.test.ts')).toEqual([]);
    expect(await findingsFor(source, 'packages/domain/src/errors.d.ts')).toEqual([]);
    expect(await findingsFor(source, 'packages/domain/src/errors.ts')).toHaveLength(1);
  });
  test('an aliased or namespaced UltimateError is the same class, and is refused', async () => {
    const findings = await findingsFor(
      "import { UltimateError as Base } from '@ultimat3/core';\n" +
        "import * as core from '@ultimat3/core';\n" +
        'export class A extends Base {}\n' +
        'export class B extends core.UltimateError {}\n' +
        "throw new Base({ code: 'X_A', cause: 'c', fix: 'x' });\n" +
        "throw new core.UltimateError({ code: 'X_B', cause: 'c', fix: 'x' });\n",
    );
    expect(findings.map((finding) => finding.cause.split(' ')[0])).toEqual([
      `${ERRORS}:3`,
      `${ERRORS}:4`,
      `${ERRORS}:5`,
      `${ERRORS}:6`,
    ]);
  });

  test('a literal code spread in from a nested object, or behind a value the guard cannot read, is refused', async () => {
    const findings = await findingsFor(
      "throw new UltimateError({ ...{ code: 'X_A' }, cause: 'c', fix: 'x' });\n" +
        "throw new UltimateError(Object.assign({ code: 'X_B' }, { cause: 'c', fix: 'x' }));\n" +
        'throw new UltimateError(init);\n',
    );
    expect(findings).toHaveLength(3);
  });

  test('a literal code in a NESTED value is not the error’s code, and a re-raise keeps passing', async () => {
    const findings = await findingsFor(
      "throw new UltimateError({ code: err.code, cause: err.cause, fix: 'x', meta: { code: 'X_UPSTREAM' } });\n",
    );
    expect(findings).toEqual([]);
  });
  test('an alias imported from the page subpath, and a quoted code key, are refused', async () => {
    const findings = await findingsFor(
      "import { UltimateError as PageError } from '@ultimat3/core/page';\n" +
        "throw new PageError({ code: 'X_A', cause: 'c', fix: 'x' });\n" +
        "throw new UltimateError({ 'code': 'X_B', cause: 'c', fix: 'x' });\n" +
        'throw new UltimateError({ "code": "X_C", cause: "c", fix: "x" });\n',
    );
    expect(findings).toHaveLength(3);
  });
});
