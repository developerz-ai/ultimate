import { describe, expect, test } from 'bun:test';
import { isReExportManifest } from './reexport-manifest';

/** The real subject: `packages/core/src/index.ts`, which is 514 lines of nothing but re-exports. */
const REPO_ROOT = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');

const MANIFEST = `
// The public API of this package, and nothing else.
import type { Ctx } from './ctx';

export { asCtx, runInCtx } from './ctx';
export type { Ctx } from './ctx';
export * from './errors';
export type { Money } from './money';

/* A block comment, and a blank line, neither of which is a statement. */

export { renderThrowable } from './render';
`;

describe('unit · a pure re-export manifest is exempt from the line ceiling', () => {
  // The failure case first: the ceiling exists for reviewable logic, so ordinary source — however
  // it is shaped — must never be exempt. An exemption that covered this would be the loophole.
  test('an ordinary source file is not a manifest', () => {
    expect(
      isReExportManifest('export function add(a: number, b: number) { return a + b; }\n'),
    ).toBe(false);
    expect(isReExportManifest('const x = 1;\nexport { x };\n')).toBe(false);
  });

  /**
   * The one that makes the carve-out safe rather than a hole: adding a single statement of logic
   * to a manifest re-arms the ceiling on the same save. Nothing has to remember to.
   */
  test('one statement of logic disqualifies the whole file', () => {
    expect(isReExportManifest(MANIFEST)).toBe(true);
    expect(isReExportManifest(`${MANIFEST}\nconsole.log('hi');\n`)).toBe(false);
  });

  /** A declaration is not a re-export, however small — this is the shape a value hides in. */
  test('export const, export function, export type Alias = … are declarations', () => {
    expect(isReExportManifest(`${MANIFEST}\nexport const LIMIT = 1;\n`)).toBe(false);
    expect(isReExportManifest(`${MANIFEST}\nexport function go(): void {}\n`)).toBe(false);
    expect(isReExportManifest(`${MANIFEST}\nexport type Alias = string;\n`)).toBe(false);
    expect(isReExportManifest(`${MANIFEST}\nexport default 1;\n`)).toBe(false);
    expect(isReExportManifest(`${MANIFEST}\nexport interface Shape { a: string }\n`)).toBe(false);
    expect(isReExportManifest(`${MANIFEST}\nexport enum Kind { A }\n`)).toBe(false);
  });

  /** Comments and blank lines are not statements — a manifest is mostly comments by weight. */
  test('comments and blank lines do not disqualify a manifest', () => {
    expect(isReExportManifest('\n\n// only a comment\n\n/* and another */\n')).toBe(false);
    expect(isReExportManifest("// why: a note\nexport { a } from './a';\n\n// and another\n")).toBe(
      true,
    );
  });

  /**
   * A `;` inside a string or a comment is not a statement boundary. Without the mask a specifier
   * holding one would split a re-export in two and the second half would read as a bare statement.
   */
  test('a semicolon inside a literal or a comment is not a boundary', () => {
    expect(isReExportManifest("export { a } from './a;b';\n")).toBe(true);
    expect(isReExportManifest('// const x = 1; a comment\nexport * from "./a";\n')).toBe(true);
  });

  /** A statement with no terminator is source this scan cannot read, so the ceiling stays on. */
  test('an unterminated tail is not a manifest', () => {
    expect(isReExportManifest("export { a } from './a';\nsomethingElse()\n")).toBe(false);
  });

  test("@ultimat3/core's own index is the file this exists for", async () => {
    const source = await Bun.file(`${REPO_ROOT}/packages/core/src/index.ts`).text();
    expect(isReExportManifest(source)).toBe(true);
  });
});
