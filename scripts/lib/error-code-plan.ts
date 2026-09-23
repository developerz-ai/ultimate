// The two edits a new error code is: its REGISTRATION in the owning package's `errors.ts` and its
// ROW in `wiki/Error-Codes.md`, planned together from one input so they can never land apart. Pure
// text in, text out — `scripts/new-error-code.ts` does the reading and the writing. A package whose
// `errors.ts` is written in a shape this planner does not recognise is refused by name rather than
// edited by guess.

// The leaf, not core's barrel: a generator must run while a package is mid-edit (DX ledger #10).
import { renderFixShellArg } from '../../packages/core/src/error-render';
import { ScriptError } from './script-error';

export interface NewErrorCode {
  readonly code: string;
  readonly pkg: string;
  /** The registered title: one line, what `x errors explain` prints first. */
  readonly title: string;
  /** The wiki row's fix: runnable or editable as written. */
  readonly fix: string;
  /** The wiki row's "Typical cause". The title stands in when it is not given. */
  readonly meaning?: string | undefined;
  /** A `## ` heading of the page, overriding the package's default section. */
  readonly section?: string | undefined;
}

/**
 * Which `## ` section a package's codes go under. The one hand table here, held to the real page by
 * `scripts/new-error-code.test.ts`: a heading renamed on the page reds that test, not a later run.
 */
export const PACKAGE_SECTIONS: ReadonlyMap<string, string> = new Map([
  ['core', 'Core and runtime'],
  ['schema', 'Schema and validation'],
  ['http', 'HTTP'],
  ['policy', 'Policy and authz'],
  ['auth', 'Auth and sessions'],
  ['entity', 'Entity and database'],
  ['db', 'Entity and database'],
  ['action', 'Actions'],
  ['query', 'Queries and live queries'],
  ['jobs', 'Jobs'],
  ['realtime', 'Realtime'],
  ['cache', 'Cache'],
  ['storage', 'Storage'],
  ['flags', 'Flags'],
  ['render', 'Routes, render and budgets'],
  ['seo', 'SEO'],
  ['pwa', 'PWA and build skew'],
  ['i18n', 'i18n, money, time'],
  ['money', 'i18n, money, time'],
  ['time', 'i18n, money, time'],
  ['mail', 'Mail'],
  ['notify', 'Notifications'],
  ['mcp', 'MCP and AI'],
  ['ai', 'MCP and AI'],
  ['scraping', 'Scraping'],
  ['admin', 'Admin and manifest'],
  ['manifest', 'Admin and manifest'],
  ['testing', 'Testing'],
  ['ui', 'UI'],
  ['cli', 'CLI and verify'],
]);

const CODE = /^X_[A-Z0-9]+(?:_[A-Z0-9]+)*$/;
const RERUN = "bun run scripts/new-error-code.ts <CODE> --package <pkg> --title '…' --fix '…'";

const invalid = (cause: string, fix: string): ScriptError =>
  new ScriptError({ code: 'X_NEW_ERROR_CODE_INVALID', cause, fix });

export function validateNewCode(input: NewErrorCode): void {
  if (!CODE.test(input.code)) {
    throw invalid(
      `"${input.code}" is not an X_SCREAMING_SNAKE code`,
      `rerun with a code like X_${input.pkg.toUpperCase()}_WHAT_FAILED: ${RERUN}`,
    );
  }
  for (const [name, value] of [
    ['title', input.title],
    ['fix', input.fix],
  ] as const) {
    if (value.trim().length === 0 || value.includes('\n')) {
      throw invalid(
        `--${name} is empty or spans lines, and it is printed as one line`,
        `rerun with a one-line --${name}: ${RERUN}`,
      );
    }
  }
}

/** A TypeScript single-quoted literal, whatever the title holds. */
const tsString = (value: string): string =>
  `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** One entry line at two-space indent, wrapped the way Biome writes one past 100 columns. */
const entry = (key: string, value: string): string => {
  const flat = `  ${key}: ${value},`;
  return flat.length <= 100 ? flat : `  ${key}:\n    ${value},`;
};

/** Insert `line` before the `close` that ends the literal opening at `open`, or `undefined`. */
function insertBefore(
  source: string,
  open: number,
  close: string,
  line: string,
): string | undefined {
  const end = source.indexOf(close, open);
  return end < 0 ? undefined : `${source.slice(0, end)}\n${line}${source.slice(end)}`;
}

/**
 * The package's OWN codes array, when it is a plain multi-line literal — never a `…BORROWED…` one
 * (`@ultimat3/query`'s names core's code and a new one is not borrowed), never a spread of others.
 */
function ownCodesArray(source: string): number | undefined {
  const found =
    /const\s+\w*_OWNED_ERROR_CODES\s*=\s*\[/.exec(source) ??
    /const\s+(?!\w*BORROWED)\w*_ERROR_CODES\s*=\s*\[/.exec(source);
  if (found === null) return undefined;
  const open = found.index + found[0].length;
  const end = source.indexOf('\n] as const;', open);
  // Comment lines are allowed between entries — `@ultimat3/cli`'s array carries a sentence per
  // code, and reading that as "no array" wrote the title alone: a type error in the package.
  const body = source.slice(open, end).replace(/^\s*\/\/.*$/gm, '');
  if (end < 0 || !/^[\s'A-Z0-9_,]*$/.test(body)) return undefined;
  return found.index;
}

const unknownShape = (path: string, code: string): ScriptError =>
  new ScriptError({
    code: 'X_NEW_ERROR_CODE_PATTERN_UNKNOWN',
    cause: `${path} has no …TITLES object and no literal registerErrorCodes({ … }) this planner can add to, so there is no shape to add ${code} to without guessing`,
    fix: `edit ${path} to register ${code} by hand, and add its row to wiki/Error-Codes.md in the same change`,
  });

/**
 * The registration, in whichever of the two shapes the package uses:
 *   - a `…TITLES` object literal (`X_A: 'title',`), plus the `…OWNED_ERROR_CODES` / `…ERROR_CODES`
 *     literal array beside it when there is one — the titles are typed by that array's union;
 *   - a literal `registerErrorCodes({ X_A: { title: '…' } })` (`@ultimat3/seo`).
 */
export function registerIn(errorsTs: string, path: string, input: NewErrorCode): string {
  if (new RegExp(`\\b${input.code}\\b`).test(errorsTs)) {
    throw new ScriptError({
      code: 'X_NEW_ERROR_CODE_EXISTS',
      cause: `${path} already names ${input.code}, and a code is registered once`,
      fix: `x errors explain ${renderFixShellArg(input.code, '<CODE>')} --json — then pick a new code, or edit the existing registration in ${path}`,
    });
  }
  const titles = /(?:export\s+)?const\s+\w*TITLES\b[^=]*=\s*\{/.exec(errorsTs);
  if (titles !== null) {
    const next = insertBefore(
      errorsTs,
      titles.index,
      '\n};',
      entry(input.code, tsString(input.title)),
    );
    if (next === undefined) throw unknownShape(path, input.code);
    const codes = ownCodesArray(next);
    if (codes === undefined) return next;
    return insertBefore(next, codes, '\n] as const;', `  '${input.code}',`) ?? next;
  }
  const literal = /\bregisterErrorCodes\(\{/.exec(errorsTs);
  const registered =
    literal === null
      ? undefined
      : insertBefore(
          errorsTs,
          literal.index,
          '\n});',
          entry(input.code, `{ title: ${tsString(input.title)} }`),
        );
  if (registered === undefined) throw unknownShape(path, input.code);
  return registered;
}

/** A wiki table cell: a `|` would end it early, a newline would end the row. */
const cell = (value: string): string => value.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

/** The row, appended to the first `| Code | …` table under the section's `## ` heading. */
export function rowIn(wiki: string, input: NewErrorCode): string {
  const section = input.section ?? PACKAGE_SECTIONS.get(input.pkg);
  if (section === undefined) {
    throw invalid(
      `@ultimat3/${input.pkg} has no default section on wiki/Error-Codes.md`,
      `rerun with --section '<a ## heading on wiki/Error-Codes.md>': ${RERUN}`,
    );
  }
  if (wiki.includes(`\`${input.code}\``)) {
    throw new ScriptError({
      code: 'X_NEW_ERROR_CODE_EXISTS',
      cause: `wiki/Error-Codes.md already documents ${input.code}`,
      fix: `x errors explain ${renderFixShellArg(input.code, '<CODE>')} --json — then pick a new code, or edit its existing row in wiki/Error-Codes.md`,
    });
  }
  const lines = wiki.split('\n');
  const heading = lines.indexOf(`## ${section}`);
  if (heading < 0) {
    throw invalid(
      `wiki/Error-Codes.md has no "## ${section}" heading`,
      `rerun with --section '<a ## heading on wiki/Error-Codes.md>': ${RERUN}`,
    );
  }
  // The CODE table: a section can open with another one first — Scraping's retry-override table.
  let last = -1;
  let inCodes = false;
  for (let index = heading + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (/^#{2,3} /.test(line)) break;
    if (/^\|\s*Code\s*\|/.test(line)) inCodes = true;
    else if (inCodes && line.startsWith('|')) last = index;
    else if (inCodes) break;
  }
  if (last < 0) {
    throw invalid(
      `"## ${section}" on wiki/Error-Codes.md carries no | Code | table to add a row to`,
      `rerun with --section '<a ## heading whose table lists codes>': ${RERUN}`,
    );
  }
  const row = `| \`${input.code}\` | ${cell(input.title)} | ${cell(input.meaning ?? input.title)} | ${cell(input.fix)} |`;
  lines.splice(last + 1, 0, row);
  return lines.join('\n');
}
