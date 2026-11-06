// Which lines of a markdown text are code. A `#` or a link inside a fence is code, never a heading
// or a link, so every other module asks this one before it reads a line as prose.

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** `true` for each line inside a fenced block, the fence lines themselves included. */
export function fencedLines(lines: readonly string[]): readonly boolean[] {
  let open: string | undefined;
  return lines.map((line) => {
    const marker = FENCE.exec(line)?.[1];
    if (open === undefined) {
      if (marker !== undefined) open = marker;
      return marker !== undefined;
    }
    // A fence closes on the same character, at least as long, with nothing after it.
    if (marker !== undefined && marker[0] === open[0] && marker.length >= open.length) {
      if (line.trim() === marker) open = undefined;
    }
    return true;
  });
}

/**
 * HTML comments removed outside fences: the renderer prints raw HTML as text, and a wiki comment
 * is a note to the next editor, never content. A line that held only a comment goes with it.
 */
export function stripComments(markdown: string): string {
  const lines = markdown.split('\n');
  const fenced = fencedLines(lines);
  const out: string[] = [];
  let inComment = false;
  lines.forEach((line, index) => {
    if (fenced[index] === true && !inComment) {
      out.push(line);
      return;
    }
    let rest = line;
    let kept = '';
    const touched = inComment || line.includes('<!--');
    while (rest.length > 0) {
      if (inComment) {
        const end = rest.indexOf('-->');
        if (end === -1) rest = '';
        else {
          rest = rest.slice(end + 3);
          inComment = false;
        }
        continue;
      }
      const start = rest.indexOf('<!--');
      if (start === -1) {
        kept += rest;
        rest = '';
      } else {
        kept += rest.slice(0, start);
        rest = rest.slice(start + 4);
        inComment = true;
      }
    }
    if (!touched) out.push(line);
    else if (kept.trim().length > 0) out.push(kept.trimEnd());
  });
  return out.join('\n');
}
