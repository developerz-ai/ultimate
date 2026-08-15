// Deleting a pin is the edit every landed fix makes, and `X_REFERENCE_APP_PIN_STALE` used to hand
// it over as prose an agent had to perform by hand. This is that edit as a transform: the pins
// file's text in, the same text with the named entries gone out. Pure — reading and writing the
// file belongs to `reference-app-gate.ts --unpin`, which is also the only caller.

export interface UnpinRequest {
  readonly app: string;
  readonly steps: readonly string[];
}

/** `<app>:<step>[,<step>]` — the shape the stale-pin `fix` line emits, parsed back. */
export const parseUnpin = (token: string): UnpinRequest | undefined => {
  const at = token.indexOf(':');
  if (at <= 0) return undefined;
  const app = token.slice(0, at).trim();
  const steps = token
    .slice(at + 1)
    .split(',')
    .map((step) => step.trim())
    .filter((step) => step.length > 0);
  return app.length === 0 || steps.length === 0 ? undefined : { app, steps };
};

interface PinBlock {
  /** The `expectedRed: {` line, and the `}` that closes it. */
  readonly open: number;
  readonly close: number;
  /** The indent an entry KEY sits at. A deeper one is a continuation of a value, never a key. */
  readonly entryIndent: string;
}

interface PinEntry {
  readonly name: string;
  /** Inclusive line range: a value spans as many lines as the formatter gave it. */
  readonly from: number;
  readonly to: number;
}

const OPEN = /^(\s*)expectedRed: \{(\})?/;
const DIR = /^\s*dir: '/;
const KEY = /^([A-Za-z_$][\w$]*|'[^']*')\s*:/;

/**
 * The one app's block, or `undefined` — which is how every unrecognised shape leaves here. The
 * scan stops at the next `dir:` so an app declared without an `expectedRed` cannot silently borrow
 * the next app's table, which is the one way a text edit could delete the wrong line.
 */
const blockOf = (lines: readonly string[], app: string): PinBlock | undefined => {
  const start = lines.findIndex((line) => line.trim() === `dir: '${app}',`);
  if (start === -1) return undefined;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (DIR.test(line)) return undefined;
    const match = OPEN.exec(line);
    if (match === null) continue;
    const indent = match[1] ?? '';
    // `expectedRed: {}` on one line — an app already at 17 of 17. A real block with no entries,
    // not an unreadable file: `close === open` is what makes `entriesOf` walk nothing.
    if (match[2] !== undefined) return { open: index, close: index, entryIndent: `${indent}  ` };
    const close = lines.findIndex((text, after) => after > index && text.startsWith(`${indent}}`));
    return close === -1 ? undefined : { open: index, close, entryIndent: `${indent}  ` };
  }
  return undefined;
};

const entriesOf = (lines: readonly string[], block: PinBlock): readonly PinEntry[] => {
  const entries: PinEntry[] = [];
  for (let index = block.open + 1; index < block.close; index += 1) {
    const line = lines[index] ?? '';
    if (!line.startsWith(block.entryIndent)) continue;
    const rest = line.slice(block.entryIndent.length);
    // Indented past the key column: a wrapped string, not the next entry.
    if (rest.startsWith(' ')) continue;
    const match = KEY.exec(rest);
    if (match === null) continue;
    const previous = entries.at(-1);
    if (previous !== undefined) entries[entries.length - 1] = { ...previous, to: index - 1 };
    entries.push({ name: (match[1] ?? '').replaceAll("'", ''), from: index, to: block.close - 1 });
  }
  return entries;
};

/**
 * The steps an app's `expectedRed` declares, read off the FILE rather than the imported module.
 * The gate compares the two before it edits anything: agreement is what proves this parser is
 * still reading the shape Biome writes, and a disagreement sends the caller back to a hand edit
 * instead of letting a text transform loose on a file it has misread.
 */
export const pinnedSteps = (source: string, app: string): readonly string[] | undefined => {
  const lines = source.split('\n');
  const block = blockOf(lines, app);
  return block === undefined ? undefined : entriesOf(lines, block).map((entry) => entry.name);
};

/**
 * The pins file with `steps` gone from `app`'s table, or `undefined` when the block, or any one of
 * the steps, is not there — a partial removal is never returned. An emptied table collapses to
 * `expectedRed: {}` on one line, because `{\n}` is not what Biome would have written and a gate
 * that leaves the repo unformatted has not finished the edit.
 */
export const removePins = (
  source: string,
  app: string,
  steps: readonly string[],
): string | undefined => {
  const lines = source.split('\n');
  const block = blockOf(lines, app);
  if (block === undefined || steps.length === 0) return undefined;
  const entries = entriesOf(lines, block);
  const doomed = steps.map((step) => entries.find((entry) => entry.name === step));
  if (doomed.some((entry) => entry === undefined)) return undefined;
  const dropped = new Set<number>();
  for (const entry of doomed) {
    for (let line = entry?.from ?? 0; line <= (entry?.to ?? -1); line += 1) dropped.add(line);
  }
  if (entries.some((entry) => !steps.includes(entry.name))) {
    return lines.filter((_line, index) => !dropped.has(index)).join('\n');
  }
  // Nothing left to keep: `expectedRed: {` + `} satisfies …,` collapse onto one line.
  const open = lines[block.open] ?? '';
  const indent = open.slice(0, Math.max(open.search(/\S/), 0));
  return [
    ...lines.slice(0, block.open),
    `${indent}expectedRed: {${(lines[block.close] ?? '').trimStart()}`,
    ...lines.slice(block.close + 1),
  ].join('\n');
};
