// The one pin edit every ratchet's `over` finding prints — the file, the row, old → new and a
// `// why:` placeholder line — and the text `--write-pin` drafts from it (`pin-edit-main.ts`). Each
// ratchet used to say "raise <pkg> in X_PINS" in its own words, and every sweep a person re-derived
// the count and the row shape by hand. The placeholder is refused in a pins file by `placeholderFindings`.

import { renderFixShellArg } from '../../packages/core/src/error-render';
import type { Finding } from './log';
import { PIN_GLOB } from './pin-tables';
import { ScriptError } from './script-error';

/** Where a ratchet's pins live: the script that reads them, the file, and the table's export name. */
export interface PinTarget {
  /** Repo-relative, as `bun run` takes it: `scripts/node-imports.ts`. */
  readonly script: string;
  /** Repo-relative pins file: `scripts/lib/node-import-pins.ts`. */
  readonly file: string;
  /** The exported table: `NODE_IMPORT_PINS`. */
  readonly table: string;
  /**
   * The `--write-pin` name a row key answers to. Absent, the key itself — a package. A table keyed
   * per SITE (`<path>: <expression>`) maps a key to its file, the one word a command line carries.
   */
  readonly nameOf?: (key: string) => string;
}

/** One raise: a target's row, from what it is pinned at to what the tree measures. */
export interface PinRaise extends PinTarget {
  readonly key: string;
  readonly from: number;
  readonly to: number;
  /** What `--write-pin` takes to draft exactly this row. */
  readonly name: string;
}

/**
 * The line `--write-pin` writes above a raised row. It carries `why:` so the row's shape is the one
 * `pin-raises` reads, and the `<PIN-EDIT:` mark so the draft cannot pass for a reason a person wrote.
 */
export const PIN_WHY_MARK = '<PIN-EDIT:';
export const PIN_WHY_PLACEHOLDER = `// why: ${PIN_WHY_MARK} say why these sites cannot be fixed yet>`;

/** The raise an `over` gap stands for. */
export const pinRaiseOf = (
  target: PinTarget,
  gap: { readonly pkg: string; readonly found: number; readonly pinned: number },
): PinRaise => ({
  ...target,
  key: gap.pkg,
  from: gap.pinned,
  to: gap.found,
  name: target.nameOf === undefined ? gap.pkg : target.nameOf(gap.pkg),
});

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const quoted = (key: string): string => `'${key.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
/** The key as a TypeScript object literal spells it: bare when it can be, single-quoted else. */
const keySource = (key: string): string => (IDENTIFIER.test(key) ? key : quoted(key));
/** The row as a reader looks it up: `TABLE.key`, or `TABLE['key']`. */
const rowName = (raise: PinRaise): string =>
  IDENTIFIER.test(raise.key)
    ? `${raise.table}.${raise.key}`
    : `${raise.table}[${quoted(raise.key)}]`;

/**
 * The edit, as one `fix:` clause: file, row, old → new, the placeholder line, and the command that
 * drafts it. The name goes through `renderFixShellArg`: a row key is tree text, and a pasted command
 * must not run what it says.
 */
export const pinRaiseFix = (raise: PinRaise): string =>
  `raise the pin: ${raise.file} ${rowName(raise)} ${String(raise.from)} → ${String(raise.to)}, with the line ${PIN_WHY_PLACEHOLDER} above it rewritten as the reason — drafted by: bun run ${raise.script} --write-pin ${renderFixShellArg(raise.name, '<the row key>')}`;

const unplaced = (raise: PinRaise, why: string): ScriptError =>
  new ScriptError({
    code: 'X_PIN_EDIT_UNPLACED',
    cause: `${raise.file} ${why}, so the raise of ${rowName(raise)} to ${String(raise.to)} has no place to go and nothing was written`,
    fix: `grep -n 'export const ${raise.table}' ${raise.file}   # then make the row ${String(raise.to)} by hand, with ${PIN_WHY_PLACEHOLDER} above it`,
  });

/** The table's literal in `source`: where its body opens and where its closing `}` sits. */
function tableSpan(source: string, raise: PinRaise) {
  const declaration = new RegExp(
    `^export const ${RegExp.escape(raise.table)}\\b[^=\\n]*=\\s*\\{`,
    'm',
  ).exec(source);
  if (declaration === null) throw unplaced(raise, `declares no \`export const ${raise.table}\``);
  const open = declaration.index + declaration[0].length;
  const inline = source.startsWith('};', open);
  const close = inline ? open : source.indexOf('\n};', open) + 1;
  if (close <= 0) throw unplaced(raise, `never closes \`${raise.table}\` with a \`};\` line`);
  // `Record<string, number>` holds bare counts; any other value type is `{ count, reason }`.
  const counted = /Record<string,\s*number>/.test(declaration[0]);
  return { open, close, inline, counted };
}

/**
 * `source` with the raise drafted: an existing row's count set to `to` with the placeholder on the
 * line above the count, or — no row — a new one at the end of the table in the shape its type
 * declares, an object row with a blank `reason` the ratchet reports until a person writes it.
 * The key is matched literally (`RegExp.escape`): `a.b` must never raise `axb`.
 */
export function applyPinRaise(source: string, raise: PinRaise): string {
  const { open, close, inline, counted } = tableSpan(source, raise);
  const body = source.slice(open, close);
  const key = `(?<q>['"]?)${RegExp.escape(raise.key)}\\k<q>`;
  const to = String(raise.to);
  const flat = new RegExp(`^(?<indent>[ \\t]*)(?<head>${key}:\\s*)\\d+,`, 'm').exec(body);
  if (flat?.groups !== undefined) {
    const { indent = '', head = '' } = flat.groups;
    const row = `${indent}${PIN_WHY_PLACEHOLDER}\n${indent}${head}${to},`;
    return splice(source, open + flat.index, flat[0].length, row);
  }
  const object = objectRow(body, key, to);
  if (object !== undefined) return splice(source, open + object.at, object.length, object.text);
  const added = counted
    ? `  ${PIN_WHY_PLACEHOLDER}\n  ${keySource(raise.key)}: ${to},\n`
    : `  ${keySource(raise.key)}: {\n    ${PIN_WHY_PLACEHOLDER}\n    count: ${to},\n    reason: '',\n  },\n`;
  return inline ? splice(source, open, 0, `\n${added}`) : splice(source, close, 0, added);
}

/**
 * The `}` closing the `{` at `open`, skipping string, template and comment runs: a reason holding
 * `{unit}` must not end the row. -1 when it never closes.
 */
export function braceClose(src: string, open: number): number {
  let depth = 0;
  for (let index = open; index < src.length; index += 1) {
    const char = src[index] as string;
    if (char === "'" || char === '"' || char === '`') {
      for (index += 1; index < src.length && src[index] !== char; index += 1) {
        if (src[index] === '\\') index += 1;
      }
    } else if (char === '/' && src[index + 1] === '/') {
      index = src.indexOf('\n', index);
      if (index === -1) return -1;
    } else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/**
 * An object row `key: { count: N, … }` raised inside its OWN braces — one line or several. The
 * lazy match this replaced ran past a one-line row to the next row's `count:`. A one-line row
 * takes the placeholder on the line above the row; a wrapped one, above its `count:`.
 */
function objectRow(body: string, key: string, to: string) {
  const head = new RegExp(`^(?<indent>[ \\t]*)${key}:\\s*\\{`, 'm').exec(body);
  if (head === null) return undefined;
  const brace = head.index + head[0].length - 1;
  const end = braceClose(body, brace);
  if (end === -1) return undefined;
  const row = body.slice(head.index, end + 1);
  const count = /(?<=[{,\s])count:\s*\d+/.exec(row);
  if (count === null) return undefined;
  const raised = `${row.slice(0, count.index)}count: ${to}${row.slice(count.index + count[0].length)}`;
  const indent = head.groups?.['indent'] ?? '';
  if (!row.includes('\n')) {
    return {
      at: head.index,
      length: row.length,
      text: `${indent}${PIN_WHY_PLACEHOLDER}\n${raised}`,
    };
  }
  const lineStart = row.lastIndexOf('\n', count.index) + 1;
  const inner = row.slice(lineStart, count.index);
  const text = `${raised.slice(0, lineStart)}${inner}${PIN_WHY_PLACEHOLDER}\n${raised.slice(lineStart)}`;
  return { at: head.index, length: row.length, text };
}

const splice = (text: string, at: number, length: number, insert: string): string =>
  `${text.slice(0, at)}${insert}${text.slice(at + length)}`;

/** Every draft line still in a pins file: the reason `--write-pin` left for a person to write. */
export function placeholderFindings(
  files: readonly { readonly path: string; readonly text: string }[],
): readonly Finding[] {
  return files.flatMap((file) =>
    file.text.split('\n').flatMap((line, index): readonly Finding[] => {
      if (!line.includes(PIN_WHY_MARK)) return [];
      const at = `${file.path}:${String(index + 1)}`;
      return [
        {
          code: 'X_PIN_RAISE_UNSTATED',
          cause: `${at} still holds the placeholder --write-pin drafted, so the raise below it states no reason a person wrote`,
          fix: `grep -n '<PIN-EDIT:' ${renderFixShellArg(file.path, '<the pins file>')}   # replace that line with // why: <the reason these sites cannot be fixed yet>, or fix the new sites and lower the row back`,
          at,
        },
      ];
    }),
  );
}

/** `placeholderFindings` over every `scripts/lib/*-pins.ts` in the tree at `root`. */
export async function treePlaceholderFindings(root: string): Promise<readonly Finding[]> {
  const files: { path: string; text: string }[] = [];
  for (const path of new Bun.Glob(PIN_GLOB).scanSync({ cwd: root })) {
    const posix = path.replaceAll('\\', '/');
    files.push({ path: posix, text: await Bun.file(`${root}/${posix}`).text() });
  }
  return placeholderFindings(files.sort((a, b) => a.path.localeCompare(b.path)));
}
