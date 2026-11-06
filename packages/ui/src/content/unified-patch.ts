// A unified patch (`git diff`, `diff -u`) read into the same rows `lineDiff` makes: file and hunk
// headers, numbered context, additions and removals, word-marked in pairs. Malformed text is never
// an error — a line the grammar does not know is kept as context, so nothing a tool wrote is lost.

import { type DiffRow, markPairs } from './line-diff';

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseUnifiedPatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const line of patch.replace(/\r\n?/g, '\n').split('\n')) {
    const hunk = HUNK.exec(line);
    if (hunk !== null) {
      oldNo = Number.parseInt(hunk[1] ?? '1', 10) - 1;
      newNo = Number.parseInt(hunk[2] ?? '1', 10) - 1;
      inHunk = true;
      rows.push({ kind: 'hunk', text: line });
      continue;
    }
    if (
      line.startsWith('diff ') ||
      (!inHunk && (line.startsWith('--- ') || line.startsWith('+++ ')))
    ) {
      inHunk = false;
      rows.push({ kind: 'file', text: line });
      continue;
    }
    if (!inHunk) {
      if (line !== '') rows.push({ kind: 'file', text: line });
      continue;
    }
    // `\ No newline at end of file` annotates the line above; it is not a line of either side.
    if (line.startsWith('\\')) continue;
    const added = line.startsWith('+');
    const removed = line.startsWith('-');
    if (!added) oldNo += 1;
    if (!removed) newNo += 1;
    if (added) rows.push({ kind: 'add', new: newNo, text: line.slice(1) });
    else if (removed) rows.push({ kind: 'del', old: oldNo, text: line.slice(1) });
    else {
      const text = line.startsWith(' ') ? line.slice(1) : line;
      rows.push({ kind: 'context', old: oldNo, new: newNo, text });
    }
  }
  // A trailing newline in the patch is not a context line.
  const last = rows[rows.length - 1];
  if (last !== undefined && last.kind === 'context' && last.text === '' && patch.endsWith('\n'))
    rows.pop();
  return markPairs(rows);
}
