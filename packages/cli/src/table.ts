// The one fixed-width table renderer the introspection commands share. Column widths come from
// the content, so output diffs cleanly between runs — and every `list` subcommand lines up the
// same way, which is the whole reason it is one function and not one per command.

/** Header row plus body rows, each padded to the widest cell in its column. */
export function renderTable(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): readonly string[] {
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => (row[index] ?? '').length)),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((value, index) => value.padEnd(widths[index] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)];
}
