// The unified diff a codemod reports a file it would not overwrite with: what the template change
// wanted, for the author to apply by hand. LCS over the lines between the common ends, bounded:
// past `MAX_CELLS` the middle is a plain replace, still a correct diff, just not a minimal one.

const CONTEXT = 3;
const MAX_CELLS = 4_000_000;

type Op = { readonly kind: ' ' | '-' | '+'; readonly text: string };

const linesOf = (text: string): readonly string[] => {
  if (text === '') return [];
  const lines = text.split('\n');
  return lines.at(-1) === '' ? lines.slice(0, -1) : lines;
};

function middleOps(a: readonly string[], b: readonly string[]): Op[] {
  if (a.length * b.length > MAX_CELLS) {
    return [
      ...a.map((text): Op => ({ kind: '-', text })),
      ...b.map((text): Op => ({ kind: '+', text })),
    ];
  }
  const width = b.length + 1;
  const table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        a[i] === b[j]
          ? (table[(i + 1) * width + j + 1] ?? 0) + 1
          : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ kind: ' ', text: a[i] ?? '' });
      i += 1;
      j += 1;
    } else if (
      i < a.length &&
      (j === b.length || (table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0))
    ) {
      // Removal first on a tie: a replaced line reads `-old` then `+new`, as git prints it.
      ops.push({ kind: '-', text: a[i] ?? '' });
      i += 1;
    } else {
      ops.push({ kind: '+', text: b[j] ?? '' });
      j += 1;
    }
  }
  return ops;
}

function editScript(a: readonly string[], b: readonly string[]): readonly Op[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }
  const same = (text: string): Op => ({ kind: ' ', text });
  return [
    ...a.slice(0, head).map(same),
    ...middleOps(a.slice(head, a.length - tail), b.slice(head, b.length - tail)),
    ...a.slice(a.length - tail).map(same),
  ];
}

/** `path`'s change from `before` (undefined: the file is new) to `after`; '' when they are equal. */
export function unifiedDiff(path: string, before: string | undefined, after: string): string {
  if (before === after) return '';
  const ops = editScript(linesOf(before ?? ''), linesOf(after));
  const out = [before === undefined ? '--- /dev/null' : `--- a/${path}`, `+++ b/${path}`];
  let index = 0;
  while (index < ops.length) {
    const first = ops.findIndex((op, at) => at >= index && op.kind !== ' ');
    if (first === -1) break;
    // A hunk runs while the gap between two changes is at most twice the context.
    let last = first;
    for (let at = first + 1; at < ops.length && at - last <= 2 * CONTEXT; at += 1) {
      if (ops[at]?.kind !== ' ') last = at;
    }
    const start = Math.max(index, first - CONTEXT);
    const end = Math.min(ops.length, last + CONTEXT + 1);
    const prior = ops.slice(0, start);
    const oldStart = prior.filter((op) => op.kind !== '+').length;
    const newStart = prior.filter((op) => op.kind !== '-').length;
    const hunk = ops.slice(start, end);
    const oldCount = hunk.filter((op) => op.kind !== '+').length;
    const newCount = hunk.filter((op) => op.kind !== '-').length;
    const at = (from: number, count: number): string =>
      `${String(count === 0 ? from : from + 1)},${String(count)}`;
    out.push(`@@ -${at(oldStart, oldCount)} +${at(newStart, newCount)} @@`);
    for (const op of hunk) out.push(`${op.kind}${op.text}`);
    index = end;
  }
  return `${out.join('\n')}\n`;
}
