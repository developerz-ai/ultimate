// 31.43.0: the workflows `x new` writes run every action by commit SHA (`templates/github/
// actions.ts`), and a checkout drops the job token before `bun install`. Read line by line, not as
// the template's bytes: any tagged major of an action with a pin moves (two of nine adopters held
// `@v5`), a SHA or an action with no pin is never touched, and a tagged line in a shape no line
// edit reads safely (quoted, an inline `with:`) leaves the whole file the author's, with the diff.

import { CACHE, CHECKOUT, DOWNLOAD_ARTIFACT, UPLOAD_ARTIFACT } from '../templates/github/actions';
import { CI_WORKFLOW_PATH } from '../templates/github/ci.yml';
import { IMAGE_WORKFLOW_PATH } from '../templates/github/image.yml';
import type { Codemod, CodemodApp, CodemodResult } from './codemod';
import { unifiedDiff } from './engine-diff';
import { mergeResults, readText } from './engine-edits';

/** Each action this codemod pins, to the pin the template writes today. */
const PINS: Readonly<Record<string, string>> = {
  checkout: CHECKOUT,
  cache: CACHE,
  'upload-artifact': UPLOAD_ARTIFACT,
  'download-artifact': DOWNLOAD_ARTIFACT,
};

const NAMES = Object.keys(PINS).join('|');
/** A step's `uses:` on a tag — `- uses:` or a later key of the step — in the one shape edited. */
const TAGGED = new RegExp(`^( *)(- )?uses: actions/(${NAMES})@v\\d+(?:\\.\\d+){0,2}[ \\t]*$`);
/** Any mention of a pinned action that is not a SHA: what must have read as TAGGED, or be refused. */
const MENTION = new RegExp(`actions/(?:${NAMES})@(?![0-9a-f]{40}(?![\\w-]))`);
const WITH = /^with:(.*)$/;

const NOTHING: CodemodResult = { changed: [], skipped: [] };

/** A line this codemod cannot edit safely, as its 1-based number and text. */
class Unsafe {
  constructor(
    readonly line: number,
    readonly text: string,
  ) {}
}

const indentOf = (line: string): number => line.length - line.trimStart().length;
const isBlank = (line: string): boolean => line.trim() === '';

/** The step's lines around its `uses:` at `at`, as [first, last], keys at `keys` columns. */
const stepRange = (lines: readonly string[], at: number, keys: number, dashed: boolean) => {
  let first = at;
  if (!dashed) {
    while (first > 0) {
      const line = lines[first - 1] ?? '';
      first -= 1;
      if (indentOf(line) === keys - 2 && line.trimStart().startsWith('- ')) break;
      if (!isBlank(line) && indentOf(line) < keys) return undefined;
    }
  }
  let last = at;
  for (let next = at + 1; next < lines.length; next += 1) {
    const line = lines[next] ?? '';
    if (isBlank(line)) continue;
    if (indentOf(line) < keys) break;
    last = next;
  }
  return [first, last] as const;
};

/** The lines a checkout's step needs inserted to drop the token, and where; Unsafe when unreadable. */
const persistInsert = (
  lines: readonly string[],
  at: number,
  keys: number,
  dashed: boolean,
): { readonly after: number; readonly lines: readonly string[] } | Unsafe | undefined => {
  const range = stepRange(lines, at, keys, dashed);
  if (range === undefined) return new Unsafe(at + 1, lines[at] ?? '');
  const [first, last] = range;
  const own = (index: number): string => {
    const line = lines[index] ?? '';
    return indentOf(line) === keys || (index === first && dashed) ? line.trimStart() : '';
  };
  for (let index = first; index <= last; index += 1) {
    const key = own(index).replace(/^- /, '');
    const opened = WITH.exec(key);
    if (opened === null) continue;
    if (!/^\s*(?:#.*)?$/.test(opened[1] ?? '')) return new Unsafe(index + 1, lines[index] ?? '');
    const children = lines.slice(index + 1, last + 1).filter((line) => !isBlank(line));
    if (children.some((line) => line.trimStart().startsWith('persist-credentials:'))) return;
    const inner = children[0] === undefined ? keys + 2 : indentOf(children[0]);
    return { after: index, lines: [`${' '.repeat(inner)}persist-credentials: false`] };
  }
  const pad = ' '.repeat(keys);
  return { after: at, lines: [`${pad}with:`, `${pad}  persist-credentials: false`] };
};

/** `text` with every tagged pin moved and each moved checkout's token dropped, or the first Unsafe. */
function pinActions(text: string): string | Unsafe {
  const lines = text.split('\n');
  // Bottom-up, so an insert never shifts a line still to be read.
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const line = lines[at] ?? '';
    const tagged = TAGGED.exec(line);
    if (tagged === null) {
      if (MENTION.test(line)) return new Unsafe(at + 1, line);
      continue;
    }
    const [, lead = '', dash, name = ''] = tagged;
    const keys = lead.length + (dash === undefined ? 0 : 2);
    if (name === 'checkout') {
      const insert = persistInsert(lines, at, keys, dash !== undefined);
      if (insert instanceof Unsafe) return insert;
      if (insert !== undefined) lines.splice(insert.after + 1, 0, ...insert.lines);
    }
    lines[at] = `${lead}${dash ?? ''}uses: ${PINS[name] ?? ''}`;
  }
  return lines.join('\n');
}

/** The template's own change, for a file it leaves to the author. */
const TEMPLATE_DIFF = (path: string): string =>
  unifiedDiff(
    path,
    `${Object.keys(PINS)
      .map((name) => `      - uses: actions/${name}@v<N>`)
      .join('\n')}\n`,
    `${Object.entries(PINS)
      .map(([name, pin]) =>
        name === 'checkout'
          ? `      - uses: ${pin}\n        with:\n          persist-credentials: false`
          : `      - uses: ${pin}`,
      )
      .join('\n')}\n`,
  );

async function pin(app: CodemodApp, path: string): Promise<CodemodResult> {
  const file = await readText(app, path);
  if (file === undefined) return NOTHING;
  const next = pinActions(file.text);
  if (next instanceof Unsafe) {
    return {
      changed: [],
      skipped: [
        {
          path,
          reason: `${path}:${String(next.line)} runs ${next.text.trim()} in a shape this codemod cannot edit safely (quoted, commented, an inline with:), so the diff below is the template's change, to make by hand`,
          diff: TEMPLATE_DIFF(path),
        },
      ],
    };
  }
  if (next === file.text) return NOTHING;
  await app.write(path, file.restore(next));
  return { changed: [path], skipped: [] };
}

export const codemod: Codemod = {
  id: 'ci-pinned-actions',
  since: '31.43.0',
  summary: `${CI_WORKFLOW_PATH}, ${IMAGE_WORKFLOW_PATH}: every actions/* step pinned by commit SHA, and ci.yml's checkouts keep no git credential`,
  run: async (app) =>
    mergeResults([await pin(app, CI_WORKFLOW_PATH), await pin(app, IMAGE_WORKFLOW_PATH)]),
};
