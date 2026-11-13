// repo-unbounded: a repo.ts read says how many rows it wants, never a bare `.all()`.
// `x verify` discovers every file in `guards/` and runs its `guard` inside the `boundaries`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
//
// Why: `.all()` with no `.limit(n)` answers ONE page — the handle's default, 50 rows — and drops
// the cursor to the rest. The caller holds neither every row nor a page it chose, and learns so
// only from a missing row. Read: a `db.<table>…all()` or `tx.<table>…all()` chain with no
// `.limit(`, `.page(`, `.keyset(` or `.one(` in it, in `{apps,packages}/**/repo{,-*}.ts`, never a
// test. Admitted: a `// why:` on the chain's first line or the line above it, naming the bound.
// REPORT ONLY (`severity: 'warning'`): its findings list on `boundaries`, never fail it.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = 'X_REPO_UNBOUNDED';

export interface RepoFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly source: string;
}

/** The handle's names: the app's `db` and the `tx` a transaction hands its callback. */
const HANDLES = new Set(['db', 'tx']);
/** A call anywhere in the chain that bounds what `.all()` answers. */
const BOUNDS = new Set(['limit', 'page', 'keyset', 'one']);
const WHY = /\/\/\s*why:/;

const isWordChar = (char: string | undefined): boolean => char !== undefined && /[\w$]/.test(char);
const isSpace = (char: string | undefined): boolean => char !== undefined && /\s/.test(char);

/**
 * Comments, strings and template text blanked IN PLACE, newlines kept, so a line number still
 * points at the source. A scan by index, never a backtracking pattern.
 */
export function blank(source: string): string {
  const out = source.split('');
  const clear = (from: number, to: number): void => {
    for (let index = from; index < to && index < out.length; index += 1) {
      if (out[index] !== '\n') out[index] = ' ';
    }
  };
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const pair = source.slice(index, index + 2);
    let end = index + 1;
    if (pair === '//') {
      const eol = source.indexOf('\n', index);
      end = eol === -1 ? source.length : eol;
      clear(index, end);
    } else if (pair === '/*') {
      const close = source.indexOf('*/', index + 2);
      end = close === -1 ? source.length : close + 2;
      clear(index, end);
    } else if (char === "'" || char === '"' || char === '`') {
      end = index + 1;
      while (end < source.length && source[end] !== char) end += source[end] === '\\' ? 2 : 1;
      end += 1;
      clear(index, end);
    }
    index = end;
  }
  return out.join('');
}

const skip = (text: string, from: number): number => {
  let index = from;
  while (isSpace(text[index])) index += 1;
  return index;
};

const back = (text: string, from: number): number => {
  let index = from;
  while (isSpace(text[index])) index -= 1;
  return index;
};

/** The `(` opening the `)` at `close`, read backwards; -1 when it never opens. */
const opening = (text: string, close: number): number => {
  let depth = 0;
  for (let index = close; index >= 0; index -= 1) {
    const char = text[index] ?? '';
    if (')]}'.includes(char)) depth += 1;
    else if ('([{'.includes(char)) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
};

interface Link {
  readonly name: string;
  readonly call: boolean;
  readonly start: number;
}

/**
 * The chain `.all` hangs off, read backwards from the `.` before it to its first name:
 * `db.posts.where({ … }).orderBy('id')` is `orderBy()`, `where()`, `posts`, `db`. Stops at
 * anything that is not a name or a call — `(await x).all()` has no chain to read.
 */
function chainBefore(text: string, dot: number): readonly Link[] {
  const links: Link[] = [];
  // `?.` is the same link as `.`: step over the `?` too.
  const past = (at: number): number => back(text, text[at - 1] === '?' ? at - 2 : at - 1);
  let index = past(dot);
  while (index >= 0) {
    let call = false;
    if (text[index] === ')') {
      const open = opening(text, index);
      if (open < 0) break;
      call = true;
      index = back(text, open - 1);
    }
    if (!isWordChar(text[index])) break;
    let start = index;
    while (isWordChar(text[start - 1])) start -= 1;
    links.push({ name: text.slice(start, index + 1), call, start });
    const prior = back(text, start - 1);
    if (text[prior] !== '.') break;
    index = past(prior);
  }
  return links;
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\n').length;

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function unboundedReads(files: readonly RepoFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const text = blank(file.source);
    const lines = file.source.split('\n');
    let from = text.indexOf('all', 0);
    while (from !== -1) {
      const at = from;
      from = text.indexOf('all', at + 3);
      if (isWordChar(text[at - 1]) || isWordChar(text[at + 3])) continue;
      const dot = back(text, at - 1);
      if (text[dot] !== '.') continue;
      // Only the terminal, argument-less `.all()`: `Promise.all(…)` and `.all(x)` are other calls.
      const open = skip(text, at + 3);
      if (text[open] !== '(' || text[skip(text, open + 1)] !== ')') continue;
      const links = chainBefore(text, dot);
      const handle = links.findIndex((link) => !link.call && HANDLES.has(link.name));
      const root = links[handle];
      const table = links[handle - 1];
      if (root === undefined || table === undefined || table.call) continue;
      if (links.some((link) => link.call && BOUNDS.has(link.name))) continue;
      const line = lineOf(text, root.start);
      if (WHY.test(lines[line - 1] ?? '') || WHY.test(lines[line - 2] ?? '')) continue;
      const where = `${file.path}:${line}`;
      const read = `${root.name}.${table.name}`;
      findings.push({
        code: CODE,
        cause: `${where} reads ${read} with .all() and no .limit(n) — .all() answers its first page, 50 rows, and drops the cursor to the rest, so the caller holds neither every row nor a page it chose`,
        fix: `${read}….limit(<the most rows this caller needs>).all() at ${where} — or .inBatches(size) to walk every row, .page() to hand a cursor on, or a // why: comment on that line naming the bound — then: x verify`,
        at: where,
      });
    }
  }
  return findings;
}

export const guard: Guard = {
  summary: 'a repo.ts read says how many rows it wants: no .all() without a .limit(n)',
  // REPORT ONLY: findings are warnings on the `boundaries` step. Delete this line to enforce it.
  severity: 'warning',
  async check(_root, sources) {
    // The run's ONE read of these files: `repo-raw-sql` asks for the same glob, so they share it.
    const repos = await sources.files('{apps,packages}/**/repo{,-*}.ts');
    const read = repos.filter((file) => !file.path.endsWith('.test.ts'));
    return unboundedReads(read.map((file) => ({ path: file.path, source: file.text })));
  },
};
