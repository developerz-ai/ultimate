// The `repo-await-in-loop` guard `x new` ships, REPORT ONLY: an `await` inside a loop body or an
// element callback in a `repo.ts` is one round trip per element. The statement ledger sees it only
// on a path something calls; this reads every repo. A loop under `expectedQueryLoop` is declared.

import { guardCode } from './guard';
import { repoAwaitInLoopTest } from './guard-repo-await-in-loop-test';
import type { GeneratedFile } from './naming';

/** Derived from the guard's name, never a literal: an `X_*` literal here is a FRAMEWORK code. */
const NAME = 'repo-await-in-loop';
const CODE = guardCode(NAME);

const source =
  (): string => `// repo-await-in-loop: a repo.ts sends one statement for a set, never one per turn of a loop.
// \`x verify\` discovers every file in \`guards/\` and runs its \`guard\` inside the \`boundaries\`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
//
// Why: an \`await\` inside a \`for\`/\`while\`/\`do\` body or a \`.forEach\`/\`.map\` callback is one round
// trip per element. The statement ledger catches it only on a path a test or \`x exercise\` happens
// to call; this reads every repo.ts. Read: \`{apps,packages}/**/repo{,-*}.ts\`, never a test.
// Admitted: a loop written inside \`expectedQueryLoop('<why>', fn)\` from \`@ultimat3/db\`, the same
// declaration the ledger honours. REPORT ONLY (\`severity: 'warning'\`): listed, never red.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = '${CODE}';

export interface RepoFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly source: string;
}

const isWordChar = (char: string | undefined): boolean => char !== undefined && /[\\w$]/.test(char);
const isSpace = (char: string | undefined): boolean => char !== undefined && /\\s/.test(char);

/**
 * Comments, strings and template text blanked IN PLACE, newlines kept, so a line number still
 * points at the source. A scan by index, never a backtracking pattern.
 */
export function blank(source: string): string {
  const out = source.split('');
  const clear = (from: number, to: number): void => {
    for (let index = from; index < to && index < out.length; index += 1) {
      if (out[index] !== '\\n') out[index] = ' ';
    }
  };
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    const pair = source.slice(index, index + 2);
    let end = index + 1;
    if (pair === '//') {
      const eol = source.indexOf('\\n', index);
      end = eol === -1 ? source.length : eol;
      clear(index, end);
    } else if (pair === '/*') {
      const close = source.indexOf('*/', index + 2);
      end = close === -1 ? source.length : close + 2;
      clear(index, end);
    } else if (char === "'" || char === '"' || char === '\`') {
      end = index + 1;
      while (end < source.length && source[end] !== char) end += source[end] === '\\\\' ? 2 : 1;
      end += 1;
      clear(index, end);
    }
    index = end;
  }
  return out.join('');
}

const OPENERS = '([{';
const CLOSERS = ')]}';

/** The index of the bracket closing the one at \`open\`; the text's end when it never closes. */
const closing = (text: string, open: number): number => {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (OPENERS.includes(text[index] ?? '')) depth += 1;
    else if (CLOSERS.includes(text[index] ?? '')) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return text.length;
};

const skip = (text: string, from: number): number => {
  let index = from;
  while (isSpace(text[index])) index += 1;
  return index;
};

const before = (text: string, from: number): string | undefined => {
  let index = from - 1;
  while (isSpace(text[index])) index -= 1;
  return text[index];
};

/** Where a brace-less loop body ends: its \`;\`, or the line break, at depth 0. */
const statementEnd = (text: string, from: number): number => {
  let depth = 0;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index] ?? '';
    if (OPENERS.includes(char)) depth += 1;
    else if (CLOSERS.includes(char)) depth -= 1;
    if (depth < 0 || (depth === 0 && (char === ';' || char === '\\n'))) return index;
  }
  return text.length;
};

interface Span {
  readonly start: number;
  readonly end: number;
  /** Where the loop's keyword or method name stands: what the finding names. */
  readonly at: number;
  readonly kind: string;
}

/** A loop body (and a \`while\` condition, run every turn) or an element callback. */
function loopAt(text: string, word: string, start: number, end: number): Span | undefined {
  const next = skip(text, end);
  if (word === 'forEach' || word === 'map') {
    if (before(text, start) !== '.' || text[next] !== '(') return undefined;
    return { start: next, end: closing(text, next), at: start, kind: \`.\${word}\` };
  }
  if (before(text, start) === '.') return undefined;
  if (word === 'do') {
    return text[next] === '{'
      ? { start: next, end: closing(text, next), at: start, kind: 'do' }
      : undefined;
  }
  if (word !== 'for' && word !== 'while') return undefined;
  let open = next;
  if (word === 'for' && text.startsWith('await', open)) open = skip(text, open + 5);
  if (text[open] !== '(') return undefined;
  const header = closing(text, open);
  const body = skip(text, header + 1);
  const close = text[body] === '{' ? closing(text, body) : statementEnd(text, body);
  // A \`for\` header runs its iterable once; a \`while\` condition runs every turn.
  return { start: word === 'for' ? header : open, end: close, at: start, kind: word };
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split('\\n').length;

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function awaitsInLoops(files: readonly RepoFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const text = blank(file.source);
    const loops: Span[] = [];
    const declared: Span[] = [];
    const awaits: number[] = [];
    let index = 0;
    while (index < text.length) {
      if (!isWordChar(text[index]) || isWordChar(text[index - 1])) {
        index += 1;
        continue;
      }
      let end = index;
      while (isWordChar(text[end])) end += 1;
      const word = text.slice(index, end);
      if (word === 'await' && before(text, index) !== '.') awaits.push(index);
      else if (word === 'expectedQueryLoop' && text[skip(text, end)] === '(') {
        const open = skip(text, end);
        declared.push({ start: open, end: closing(text, open), at: index, kind: word });
      } else {
        const loop = loopAt(text, word, index, end);
        if (loop !== undefined) loops.push(loop);
      }
      index = end;
    }
    const counted = loops.filter(
      (loop) => !declared.some((span) => span.start < loop.at && loop.at < span.end),
    );
    const reported = new Set<Span>();
    for (const at of awaits) {
      const inner = counted
        .filter((loop) => loop.start < at && at < loop.end)
        .sort((a, b) => b.start - a.start)[0];
      if (inner === undefined || reported.has(inner)) continue;
      reported.add(inner);
      const where = \`\${file.path}:\${lineOf(text, at)}\`;
      const loopLine = \`\${file.path}:\${lineOf(text, inner.at)}\`;
      findings.push({
        code: CODE,
        cause: \`\${where} awaits inside the \${inner.kind} at \${loopLine} — one round trip per element, so the statements a call sends grow with the rows it is handed\`,
        fix: \`db.<table>.andWhere('id', 'in', ids).limit(ids.length).all() (or insertAll / updateWhere / deleteWhere) — one statement for the set in place of the \${inner.kind} at \${loopLine}, or expectedQueryLoop('<why one per element is optimal>', fn) from @ultimat3/db around it — then: x verify\`,
        at: where,
      });
    }
  }
  return findings;
}

export const guard: Guard = {
  summary: 'a repo.ts sends one statement for a set, never an await per turn of a loop',
  // REPORT ONLY: findings are warnings on the \`boundaries\` step. Delete this line to enforce it.
  severity: 'warning',
  async check(_root, sources) {
    // The run's ONE read of these files: \`repo-raw-sql\` asks for the same glob, so they share it.
    const repos = await sources.files('{apps,packages}/**/repo{,-*}.ts');
    const read = repos.filter((file) => !file.path.endsWith('.test.ts'));
    return awaitsInLoops(read.map((file) => ({ path: file.path, source: file.text })));
  },
};
`;

/** `guards/repo-await-in-loop.ts` and its test. No index, no registry — the directory registers it. */
export const repoAwaitInLoopGuardFiles = (): readonly GeneratedFile[] => [
  { path: `guards/${NAME}.ts`, contents: source() },
  { path: `guards/${NAME}.test.ts`, contents: repoAwaitInLoopTest(CODE) },
];
