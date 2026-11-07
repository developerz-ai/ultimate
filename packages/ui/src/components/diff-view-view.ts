// The pure half of `DiffView`: rows from either input, folded at `maxLines`; the side-by-side
// pairing; a row's text cut into marked and unmarked segments; and where each change run starts.

import { finiteCount } from '@ultimat3/core';
import { type DiffRow, foldRows, lineDiff } from '../content/line-diff';
import { parseUnifiedPatch } from '../content/unified-patch';

export const DIFF_VIEW_MAX_LINES = 2_000;

export interface DiffInput {
  readonly old?: string | undefined;
  readonly new?: string | undefined;
  readonly patch?: string | undefined;
  readonly maxLines?: number | undefined;
}

export function diffViewRows(input: DiffInput): readonly DiffRow[] {
  const max = finiteCount('DiffView', 'maxLines', input.maxLines ?? DIFF_VIEW_MAX_LINES, 1);
  const rows =
    input.patch === undefined
      ? lineDiff(input.old ?? '', input.new ?? '')
      : parseUnifiedPatch(input.patch);
  return foldRows(rows, max);
}

export type SidePair =
  | { readonly kind: 'pair'; readonly left: DiffRow | null; readonly right: DiffRow | null }
  | { readonly kind: 'whole'; readonly row: DiffRow };

/** Context on both sides; a removed run beside the added run after it; headers and folds across. */
export function sidePairs(rows: readonly DiffRow[]): SidePair[] {
  const out: SidePair[] = [];
  for (let r = 0; r < rows.length; ) {
    const row = rows[r];
    if (row === undefined) break;
    if (row.kind === 'context') {
      out.push({ kind: 'pair', left: row, right: row });
      r += 1;
      continue;
    }
    if (row.kind !== 'del' && row.kind !== 'add') {
      out.push({ kind: 'whole', row });
      r += 1;
      continue;
    }
    let dels = r;
    while (rows[dels]?.kind === 'del') dels += 1;
    let adds = dels;
    while (rows[adds]?.kind === 'add') adds += 1;
    const span = Math.max(dels - r, adds - dels);
    for (let p = 0; p < span; p += 1) {
      out.push({
        kind: 'pair',
        left: p < dels - r ? (rows[r + p] ?? null) : null,
        right: p < adds - dels ? (rows[dels + p] ?? null) : null,
      });
    }
    r = adds;
  }
  return out;
}

/** `text` cut at the marks: `[segment, marked]` in order, covering the text exactly. */
export function markedSegments(
  text: string,
  marks: readonly (readonly [number, number])[] | undefined,
): readonly (readonly [string, boolean])[] {
  if (marks === undefined || marks.length === 0) return [[text, false]];
  const out: [string, boolean][] = [];
  let at = 0;
  for (const [from, to] of marks) {
    if (from > at) out.push([text.slice(at, from), false]);
    if (to > from) out.push([text.slice(from, to), true]);
    at = Math.max(at, to);
  }
  if (at < text.length) out.push([text.slice(at), false]);
  return out;
}

/** True for a changed row whose previous row is not a change: where "Next change" stops. */
export function startsChange(rows: readonly DiffRow[], index: number): boolean {
  const kind = rows[index]?.kind;
  const before = rows[index - 1]?.kind;
  return (kind === 'add' || kind === 'del') && before !== 'add' && before !== 'del';
}
