// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the fixtures below are SOURCE TEXT — a
// `${…}` in one is the code under test, never an interpolation that went missing.
// The floor under `x verify`'s errors step: the three shapes that shipped must be reported, a value
// already routed through a total renderer must not be, and the mask must survive an escaped
// delimiter — a template whose end is read wrong is a `${…}` nobody checks. A false positive here
// is a rule an agent learns to skip; a miss is the bug that shipped three times.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun ships no `Bun.*` equivalent — `mkdtemp`/`rm` own a fixture root the scan reads.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import {
  checkFile,
  errorRendering,
  maskToCode,
  mayRenderUnknown,
  topLevelSegments,
  unsafeRenderFindingFor,
} from './error-render';

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

  test('a bare unknown under a cast, a non-null assertion, parentheses or a ??/|| fallback', () => {
    // Each renders the value itself: the cast and `!` are erased at runtime, the parentheses are
    // grouping, and a fallback renders its left operand whenever that is an object.
    for (const shape of [
      'given as string',
      'given!',
      '(given)',
      '((given as string))',
      "given ?? 'none'",
      "given || 'none'",
      'label ?? given',
      'label as string || given',
      'label as A | B || given',
    ]) {
      const found = scan(`
        export const bad = (label: string, given: unknown): E =>
          new E({ cause: \`got \${${shape}}\`, fix: 'x doctor' });
      `);
      expect({ shape, kinds: found.map((one) => one.kind) }).toEqual({
        shape,
        kinds: ['interpolation'],
      });
    }
  });

  test('a fallback, cast or group around a read OF the value is still not the value', () => {
    for (const shape of [
      "(given as Error).message ?? 'none'",
      'typeof given',
      "given instanceof Error ? given.message : 'other'",
    ]) {
      const found = scan(`
        export const fine = (given: unknown): E =>
          new E({ cause: \`got \${${shape}}\`, fix: 'x doctor' });
      `);
      expect({ shape, found }).toEqual({ shape, found: [] });
    }
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

describe('a value laundered through a file-local duck-type helper', () => {
  test('an arrow helper whose whole body is the duck-type is a render', () => {
    // The shape that shipped SIX times and the gate could not see, because it followed a direct
    // interpolation and not a value handed to a local name first.
    const found = scan(`
      const describe = (error: unknown): string =>
        error instanceof Error ? error.message : String(error);

      export function prerenderFailed(file: string, error: unknown): RenderError {
        return new RenderError({
          code: 'X_PRERENDER_FAILED',
          cause: \`\${file} threw while rendering: \${describe(error)}\`,
          fix: 'run bun test against the component',
        });
      }
    `);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe('conversion');
    expect(found[0]?.binding).toBe('error');
  });

  test('a function-declaration helper of the same shape counts too', () => {
    const found = scan(`
      function describe(error: unknown) {
        return error instanceof Error ? error.message : String(error);
      }

      export function loadFailed(error: unknown): RenderError {
        return new RenderError({
          code: 'X_ROUTE_LOAD_FAILED',
          cause: \`load threw: \${describe(error)}\`,
          fix: 'return a value from load()',
        });
      }
    `);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe('conversion');
  });

  test('a helper whose `instanceof` and `Error` sit on two lines is still found', () => {
    // The scan returns early from a file with no `instanceof` in it — 16% of the step's CPU was
    // this one regex. The early return may not be narrower than the regex: `\s+` spans a newline.
    const found = scan(`
      const describe = (error: unknown): string =>
        error instanceof
          Error ? error.message : String(error);

      export function loadFailed(error: unknown): RenderError {
        return new RenderError({
          code: 'X_ROUTE_LOAD_FAILED',
          cause: \`load threw: \${describe(error)}\`,
          fix: 'return a value from load()',
        });
      }
    `);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe('conversion');
  });

  test('a helper that does real work is NOT a duck-type and is left alone', () => {
    // Deliberately narrow: a false finding here is a rule an agent learns to skip, which is the
    // failure this file's header names.
    const found = scan(`
      const summarise = (error: unknown): string => renderThrowable(error).slice(0, 80);

      export function loadFailed(error: unknown): RenderError {
        return new RenderError({
          code: 'X_ROUTE_LOAD_FAILED',
          cause: \`load threw: \${summarise(error)}\`,
          fix: 'return a value from load()',
        });
      }
    `);
    expect(found).toEqual([]);
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
    // The whole factory is the first segment: cutting at the `)` that ends the parameter list
    // would put `value: unknown` in a different scope from the `cause:` that renders it. Asserting
    // a count instead would assert nothing — a trailing segment is pushed for every input.
    expect(topLevelSegments(maskToCode(source).code)[0]).toEqual({ start: 0, end: source.length });
    expect(scan(source)).toHaveLength(1);
  });

  test('an escaped backtick does not close a template, so a later substitution is still read', () => {
    const source = `
      export const f = (value: unknown): E =>
        new E({ cause: \`a \\\` tick, then \${value}\`, fix: 'x' });
    `;
    const found = scan(source);
    expect(found).toHaveLength(1);
    expect(found[0]?.kind).toBe('interpolation');
    expect(found[0]?.binding).toBe('value');
  });

  test('a backtick inside a substitution string does not close the template around it', () => {
    const found = scan(`
      export const f = (value: unknown): E =>
        new E({ cause: \`\${tick('\\\`')} then \${value}\`, fix: 'x' });
    `);
    expect(found.map((one) => one.kind)).toEqual(['interpolation']);
  });

  test('an escaped quote inside a substitution does not swallow the substitutions after it', () => {
    const found = scan(`
      export const f = (value: unknown): E =>
        new E({ cause: \`\${label('a\\'b')} then \${value}\`, fix: 'x' });
    `);
    expect(found.map((one) => one.binding)).toEqual(['value']);
  });

  test('a later declaration does not leak into an earlier segment', () => {
    // @ultimat3/query shipped exactly this: an interface below the class that uses the name.
    expect(
      scan(`
        export class QueryInputInvalidError extends UltimateError {
          constructor(name: string, detail: string) {
            super({ cause: \`input for "\${name}" failed: \${detail}\`, fix: 'x queries show' });
          }
        }
        interface Shape { readonly detail?: unknown }
      `),
    ).toEqual([]);
  });
});

describe('the entry point sees a catch binding', () => {
  let root = '';

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ultimate-error-render-'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const write = async (source: string): Promise<void> => {
    await Bun.write(join(root, 'packages/x/src/thing.ts'), source);
  };

  // The catch half of the rule, through the entry point the command and the gate step both call.
  // `error-render.ts` reads PARAMETERS typed `unknown`, and a catch binding is neither — so the
  // half that sees one is `catch-render.ts`, and this is the composition of the two.
  test('a catch binding rendered into a cause is reported', async () => {
    await write(
      [
        'export function readPayload(raw: string): string {',
        '  try {',
        '    return JSON.parse(raw) as string;',
        '  } catch (error) {',
        '    throw new Error({',
        '      cause: `unreadable payload: ${error instanceof Error ? error.message : String(error)}`,',
        '    });',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    const findings = await errorRendering(root);
    expect(findings.map((one) => one.code)).toContain('X_CATCH_RENDER_UNSAFE');
  });

  test('the same value routed through renderThrowable is not', async () => {
    await write(
      [
        'export function readPayload(raw: string): string {',
        '  try {',
        '    return JSON.parse(raw) as string;',
        '  } catch (error) {',
        '    throw new Error({',
        '      cause: `unreadable payload: ${renderThrowable(error)}`,',
        '    });',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    const findings = await errorRendering(root);
    expect(findings.map((one) => one.code)).not.toContain('X_CATCH_RENDER_UNSAFE');
  });
});

// The pre-filter that skips the mask on most files: it must still see an annotation with a comment
// between its `:` and the type, and it must answer in linear time on any text a file can hold.
describe('the pre-filter: an `unknown` annotation and a `cause`/`fix` key', () => {
  test('a block or line comment between the `:` and the type is still an annotation', () => {
    for (const annotation of [
      ': unknown',
      ':/* x */unknown',
      ': /** a ** b */ any',
      ':// c\n unknown',
    ])
      expect(mayRenderUnknown(`(e${annotation}) => ({ cause: e })`), annotation).toBe(true);
    expect(mayRenderUnknown('(e: unknownish) => ({ cause: e })')).toBe(false);
    expect(mayRenderUnknown('(e: unknown) => ({ reason: e })')).toBe(false);
    // A comment ends at its first `*/`: what follows it is code, not more comment.
    expect(mayRenderUnknown('(e:/* a */ x /* b */unknown) => ({ cause: e })')).toBe(false);
  });

  test('linear on `:/*` and many `*//*`, where a lazy comment body backtracks exponentially', () => {
    const started = performance.now();
    expect(mayRenderUnknown(`cause:/*${'*//*'.repeat(40)}`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
