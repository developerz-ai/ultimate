// One generated block inside a hand-written markdown page: the `<!-- generated: <name> — <fix> -->`
// … `<!-- end generated -->` pair `llms.txt` already uses, read and rewritten by name. Text in,
// text out — the guard that owns a block decides what goes in it and what drift costs.

export const GENERATED_CLOSE = '<!-- end generated -->';

/** The opening marker: the block's name and the command that rewrites it, so a reader can. */
export const generatedOpen = (name: string, fix: string): string =>
  `<!-- generated: ${name} — ${fix} -->`;

/** The lines between the two markers, or `undefined` when either marker is missing. */
export function readGenerated(
  text: string,
  name: string,
  fix: string,
): readonly string[] | undefined {
  const lines = text.split('\n');
  const start = lines.indexOf(generatedOpen(name, fix));
  if (start === -1) return undefined;
  const end = lines.indexOf(GENERATED_CLOSE, start + 1);
  if (end === -1) return undefined;
  return lines.slice(start + 1, end);
}

/** The text with the block's body replaced, or `undefined` when there is no block to fill. */
export function fillGenerated(
  text: string,
  name: string,
  fix: string,
  body: readonly string[],
): string | undefined {
  const lines = text.split('\n');
  const start = lines.indexOf(generatedOpen(name, fix));
  if (start === -1) return undefined;
  const end = lines.indexOf(GENERATED_CLOSE, start + 1);
  if (end === -1) return undefined;
  return [...lines.slice(0, start + 1), ...body, ...lines.slice(end)].join('\n');
}
