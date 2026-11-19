// A scheduled brief as the maintainer platform reads it: the row ids its `## Rows` section
// declares and the header line it prepends before counting the brief against its cap. A copy of
// the platform's reader (its `checkup-header.ts`), so the repo's tests refuse what it refuses.

/** A row id, as the platform accepts one: lowercase, digits, `-` or `_`, at most 40 characters. */
const ROW_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const ROWS_HEADING = /^##\s+(?:\d+\.\s+)?rows\s*$/i;
const ANY_HEADING = /^#{1,6}\s/;
const FENCE = /^\s{0,3}(```|~~~)/;
const ROW_ITEM = /^\s{0,3}[-*+]\s+`([^`]+)`/;

/** The row ids `brief` declares under its one `## Rows` section, in order, without repeats. */
export function briefRowsOf(brief: string): string[] {
  const rows: string[] = [];
  let fenced = false;
  let inRows = false;
  for (const line of brief.split(/\r?\n/)) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (ROWS_HEADING.test(line) || ANY_HEADING.test(line)) {
      // One section: the next heading, a second `## Rows` included, ends it.
      if (inRows) break;
      inRows = ROWS_HEADING.test(line);
      continue;
    }
    if (!inRows) continue;
    const id = ROW_ITEM.exec(line)?.[1];
    if (id !== undefined && ROW_ID.test(id) && !rows.includes(id)) rows.push(id);
  }
  return rows;
}

/** The brief as the platform counts it: its header line, a blank line, the brief untouched. */
export function headedBrief(repo: string, briefFile: string, brief: string): string {
  const rows = briefRowsOf(brief).join(',');
  return `dz-checkup v1 repo=${repo} rows=${rows} brief_file=${briefFile}\n\n${brief}`;
}
