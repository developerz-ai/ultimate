// The `x jobs ls` terminal table, and nothing else. Split out of `jobs-report.ts` so that
// deciding how a value LOOKS lives apart from deciding what the queue DOES: a rendering rule
// (column order, padding, the run-at unit) is reviewed here, once, with no queue logic around it.

import type { JobRecord } from '@ultimat3/jobs';

const HEADER = ['id', 'name', 'queue', 'state', 'attempt', 'run-at-ms'] as const;

/**
 * Fixed-width columns, same padding idiom as `renderRouteTable` in `cmd-routes.ts`.
 *
 * `run-at-ms` is the raw epoch, deliberately NOT a formatted date. The repo forbids formatting a
 * date without an explicit IANA `timeZone`, and not formatting at all is the one rendering with
 * no zone to get wrong. Formatting it properly would mean `@ultimat3/time`, which is not a
 * declared dependency of this package and whose formatters need a locale the CLI has no concept
 * of — and its output would no longer sort. `--json` already emits `runAt` as this same number,
 * so the two renders of one command stay comparable; `x jobs show <id>` is the readable view.
 */
export function renderJobTable(rows: readonly JobRecord[]): readonly string[] {
  const body = rows.map((row) => [
    row.id,
    row.name,
    row.queue,
    row.state,
    String(row.attempt),
    String(row.runAt),
  ]);
  const widths = HEADER.map((title, index) =>
    Math.max(title.length, ...body.map((row) => (row[index] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((value, index) => value.padEnd(widths[index] ?? 0)).join('  ');
  return [line(HEADER), ...body.map(line)];
}
