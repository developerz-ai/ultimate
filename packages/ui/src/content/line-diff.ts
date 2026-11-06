// Myers' diff over lines, then word marks inside each changed pair. Bounded on hostile input: the
// common ends are trimmed first, and past `maxEdits` the middle is reported as removed-then-added
// rather than searched quadratically. The rows are what `DiffView` and a unified patch share.

/** One row of a diff, numbered on the side(s) it exists on. `marks` are changed char ranges. */
export type DiffRow =
  | {
      readonly kind: 'context' | 'add' | 'del';
      readonly old?: number | undefined;
      readonly new?: number | undefined;
      readonly text: string;
      readonly marks?: readonly (readonly [number, number])[] | undefined;
    }
  | { readonly kind: 'hunk' | 'file'; readonly text: string }
  | { readonly kind: 'fold'; readonly count: number };

export type DiffOp = 'equal' | 'add' | 'del';

/** Past this many edits the search stops; the rest is a plain replace, in linear time. */
export const DIFF_MAX_EDITS = 1_000;

/** The edit script turning `a` into `b`, as one op per element, Myers O((N+M)·D) within the cap. */
export function diffOps<T>(a: readonly T[], b: readonly T[], maxEdits = DIFF_MAX_EDITS): DiffOp[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail += 1;
  const x0 = a.slice(head, a.length - tail);
  const y0 = b.slice(head, b.length - tail);
  const middle = myers(x0, y0, maxEdits) ?? [
    ...x0.map((): DiffOp => 'del'),
    ...y0.map((): DiffOp => 'add'),
  ];
  return [
    ...new Array<DiffOp>(head).fill('equal'),
    ...middle,
    ...new Array<DiffOp>(tail).fill('equal'),
  ];
}

function myers<T>(a: readonly T[], b: readonly T[], maxEdits: number): DiffOp[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
      let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, next, n, m, offset);
    }
    v = next;
  }
  return null;
}

function backtrack(
  trace: readonly Int32Array[],
  last: Int32Array,
  n: number,
  m: number,
  offset: number,
): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d -= 1) {
    const v = trace[d] ?? last;
    const k = x - y;
    const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
    const prevK = down ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : (v[offset + prevK] ?? 0);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push('equal');
      x -= 1;
      y -= 1;
    }
    if (d > 0) ops.push(down ? 'add' : 'del');
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

const WORDS = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
/** A changed pair longer than this many words gets no marks: the line itself is the mark. */
const MARK_MAX_WORDS = 400;

/** Changed character ranges in a removed line and its added partner. */
export function wordMarks(
  before: string,
  after: string,
): readonly [readonly (readonly [number, number])[], readonly (readonly [number, number])[]] {
  const a = before.match(WORDS) ?? [];
  const b = after.match(WORDS) ?? [];
  if (a.length > MARK_MAX_WORDS || b.length > MARK_MAX_WORDS) return [[], []];
  const ops = diffOps(a, b, MARK_MAX_WORDS);
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  let i = 0;
  let j = 0;
  let at = 0;
  let bt = 0;
  const mark = (into: [number, number][], from: number, to: number): void => {
    const prev = into[into.length - 1];
    if (prev !== undefined && prev[1] === from) prev[1] = to;
    else into.push([from, to]);
  };
  for (const op of ops) {
    if (op !== 'add') {
      const len = (a[i] ?? '').length;
      if (op === 'del') mark(left, at, at + len);
      at += len;
      i += 1;
    }
    if (op !== 'del') {
      const len = (b[j] ?? '').length;
      if (op === 'add') mark(right, bt, bt + len);
      bt += len;
      j += 1;
    }
  }
  return [left, right];
}

/** Numbered rows from two texts, word-marked where a removed run meets an added one. */
export function lineDiff(before: string, after: string, maxEdits = DIFF_MAX_EDITS): DiffRow[] {
  const a = before === '' ? [] : before.replace(/\r\n?/g, '\n').split('\n');
  const b = after === '' ? [] : after.replace(/\r\n?/g, '\n').split('\n');
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  for (const op of diffOps(a, b, maxEdits)) {
    if (op === 'equal') {
      rows.push({ kind: 'context', old: i + 1, new: j + 1, text: a[i] ?? '' });
      i += 1;
      j += 1;
    } else if (op === 'del') {
      rows.push({ kind: 'del', old: i + 1, text: a[i] ?? '' });
      i += 1;
    } else {
      rows.push({ kind: 'add', new: j + 1, text: b[j] ?? '' });
      j += 1;
    }
  }
  return markPairs(rows);
}

/** Pairs each run of removed rows with the added run after it, index by index, and marks words. */
export function markPairs(rows: readonly DiffRow[]): DiffRow[] {
  const out = [...rows];
  for (let r = 0; r < out.length; ) {
    let dels = r;
    while (out[dels]?.kind === 'del') dels += 1;
    let adds = dels;
    while (out[adds]?.kind === 'add') adds += 1;
    const pairs = Math.min(dels - r, adds - dels);
    for (let p = 0; p < pairs; p += 1) {
      const del = out[r + p];
      const add = out[dels + p];
      if (del === undefined || add === undefined || !('text' in del) || !('text' in add)) continue;
      const [left, right] = wordMarks(del.text, add.text);
      out[r + p] = { ...del, marks: left } as DiffRow;
      out[dels + p] = { ...add, marks: right } as DiffRow;
    }
    r = adds === r ? r + 1 : adds;
  }
  return out;
}

/** At most `maxLines` rows, then one fold saying how many were left out. */
export function foldRows(rows: readonly DiffRow[], maxLines: number): readonly DiffRow[] {
  if (rows.length <= maxLines) return rows;
  return [...rows.slice(0, maxLines), { kind: 'fold', count: rows.length - maxLines }];
}
