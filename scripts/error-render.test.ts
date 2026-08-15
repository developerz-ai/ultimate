import { describe, expect, test } from 'bun:test';
import { checkFile, maskToCode, topLevelSegments, unsafeRenderFindingFor } from './error-render';

const scan = (source: string) => checkFile({ path: 'packages/x/src/errors.ts', source });

describe('checkErrorRendering catches the shape that shipped three times', () => {
  test('JSON.stringify of an unknown parameter in a cause', () => {
    // The real one: packages/ui/src/errors.ts, verbatim shape.
    const found = scan(`
      export function invalidValueError(kind: string, value: unknown, expected: string): UiError {
        return new UiError({
          code: UI_ERROR_CODES.invalidValue,
          cause: \`<\${kind}> received \${JSON.stringify(value)}, which is not \${expected}\`,
          fix: 'pass a value the component can render',
        });
      }
    `);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe('stringify');
    expect(found[0]?.binding).toBe('value');
    expect(found[0]?.field).toBe('cause');
  });

  test('a bare unknown interpolated into a cause or a fix', () => {
    const found = scan(`
      export const flagExpiryInvalid = (key: string, given: unknown): E =>
        new E({
          cause: \`\${key} has expiresAt \${given}, which is not a date\`,
          fix: \`set expiresAt to \${given} in defineFlag()\`,
        });
    `);
    expect(found.map((one) => one.kind)).toEqual(['interpolation', 'interpolation']);
    expect(found.map((one) => one.field)).toEqual(['cause', 'fix']);
  });

  test('String() of an unknown, and a cause built by assignment rather than as a property', () => {
    const found = scan(`
      export function toUltimateError(value: unknown): UltimateError {
        const cause = \`non-error value thrown: \${String(value)}\`;
        return new InternalError({ cause, fix: 'fix the underlying failure' });
      }
    `);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe('conversion');
  });

  test('the finding names the file, the line and the call to paste', () => {
    const finding = unsafeRenderFindingFor({
      file: 'packages/ui/src/errors.ts',
      line: 127,
      field: 'cause',
      binding: 'value',
      kind: 'stringify',
    });
    expect(finding.code).toBe('X_ERROR_RENDER_UNSAFE');
    expect(finding.at).toBe('packages/ui/src/errors.ts:127');
    expect(finding.fix).toContain('renderCauseValue(value)');
    expect(finding.cause).toContain('packages/ui/src/errors.ts:127');
  });
});

describe('what it deliberately lets through', () => {
  test('a value already routed through a total renderer', () => {
    expect(
      scan(`
        export const tenancyMismatch = (given: unknown): E =>
          new E({
            cause: \`the row named \${renderCauseValue(given)}\`,
            fix: \`scope the call to \${renderFixLiteral(given, '<org>')}\`,
          });
      `),
    ).toEqual([]);
  });

  test('a property of an unknown, which TypeScript has already typed', () => {
    // `error.message` is a string or the file does not compile. Reporting it would report
    // every narrowed `unknown` in the framework, and a check like that gets ignored.
    expect(
      scan(`
        export const finalizeFailed = (stage: string, error: unknown): E =>
          new E({
            cause: \`the "\${stage}" stage threw: \${error instanceof Error ? error.message : 'unknown'}\`,
            fix: 'return a Response built here',
          });
      `),
    ).toEqual([]);
  });

  test('a binding of the same name declared as a type field, not a parameter', () => {
    // `@ultimat3/ai`'s describeFailure: the cast declares `cause?: unknown`, the const that
    // reaches the message is a narrowed string.
    expect(
      scan(`
        function describeFailure(error: unknown): string {
          const e = error as { code?: unknown; cause?: unknown };
          const cause = typeof e.cause === 'string' ? e.cause : 'unknown';
          return \`\${e.code}: \${cause}\`;
        }
      `),
    ).toEqual([]);
  });

  test('the word cause inside a string literal is not a declaration', () => {
    expect(
      scan(`
        export const bad = (version: unknown): E =>
          new E({ fix: 'set a semver "version" in package.json, then: bun run verify' });
      `),
    ).toEqual([]);
  });

  test('a cause in a doc comment', () => {
    expect(
      scan(`
        /** Renders \`cause: \${value}\` for the reader. */
        export const doc = (value: unknown): string => 'x';
      `),
    ).toEqual([]);
  });
});

describe('the mask and the scope', () => {
  test('a template substitution stays code while the text around it does not', () => {
    const { code, substitutions } = maskToCode(`const a = \`left \${value} right\`;`);
    expect(code).toContain('value');
    expect(code).not.toContain('left');
    expect(substitutions).toHaveLength(1);
  });

  test('a parameter list does not close a segment, so a factory keeps its parameters', () => {
    const source = `export const f = (value: unknown): E => new E({ cause: \`\${value}\` });`;
    expect(topLevelSegments(maskToCode(source).code).length).toBeGreaterThan(0);
    expect(scan(source)).toHaveLength(1);
  });

  test('a later declaration does not leak into an earlier segment', () => {
    // @ultimat3/query shipped exactly this: an interface below the class that uses the name.
    expect(
      scan(`
        export class QueryInputInvalidError extends UltimateError {
          constructor(name: string, detail: string) {
            super({ cause: \`input for "\${name}" failed: \${detail}\`, fix: 'x queries describe' });
          }
        }
        interface Shape { readonly detail?: unknown }
      `),
    ).toEqual([]);
  });
});
