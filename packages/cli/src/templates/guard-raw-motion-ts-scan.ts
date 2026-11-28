// The TypeScript scanning helpers of the script motion guards, as source text a guard file carries
// (a guard imports nothing but types, so a helper is embedded, as `LOCAL_BINDING_SOURCE` is).
// `TS_BLANK_SOURCE` is the string-aware comment blanker every script guard embeds;
// `TS_ANIMATE_SCAN_SOURCE` adds the `.animate(` call reader `raw-motion-script` and
// `animated-layout-script` share.

/**
 * Comments blanked IN PLACE (a reported line number still points at the source) by a scan that
 * knows where a string is: `'dist/*'` opens no comment and `'//cdn'` is no line comment.
 * `strings` blanks the string bodies too. A regex literal holding a quote is the one thing it
 * misreads; a quote ends at its line, so the misreading never outlives it.
 */
export const TS_BLANK_SOURCE = `/** Comments blanked in place; string bodies too when \`strings\` — a string is never a comment. */
export const blankScript = (text: string, strings = false): string => {
  const pad = (chunk: string): string => chunk.replaceAll(/[^\\n]/g, ' ');
  const parts: string[] = [];
  let kept = 0;
  let i = 0;
  /** Everything since the last cut is code and is copied as one run, never per character. */
  const cut = (from: number, to: number, replacement: string): void => {
    parts.push(text.slice(kept, from), replacement);
    kept = to;
    i = to;
  };
  while (i < text.length) {
    const ch = text[i] ?? '';
    const next = text[i + 1];
    if (ch === '/' && (next === '/' || next === '*')) {
      const close = next === '/' ? text.indexOf('\\n', i) : text.indexOf('*/', i + 2);
      const end = close === -1 ? text.length : next === '/' ? close : close + 2;
      cut(i, end, pad(text.slice(i, end)));
    } else if (ch === "'" || ch === '"' || ch === '\`') {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) {
        if (text[j] === '\\\\') j += 1;
        else if (ch !== '\`' && text[j] === '\\n') break;
        j += 1;
      }
      const end = Math.min(j + 1, text.length);
      if (strings) cut(i, end, pad(text.slice(i, end)));
      else i = end;
    } else i += 1;
  }
  parts.push(text.slice(kept));
  return parts.join('');
};
`;

export const TS_ANIMATE_SCAN_SOURCE = `${TS_BLANK_SOURCE}
export interface ScriptFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly source: string;
}

/** A script an author did not write for the app: a test, a story, a declaration. */
export const isAppScript = (path: string): boolean =>
  /\\.(?:ts|tsx)$/.test(path) && !/\\.(?:test|spec|d)\\.tsx?$/.test(path);

/** Comments blanked, strings kept: a curve is written in one. */
export const blankScriptComments = (text: string): string => blankScript(text);

export const scriptLineOf = (text: string, index: number): number =>
  text.slice(0, index).split('\\n').length;

export interface AnimateCall {
  /** Offset of the first argument character in the file. */
  readonly start: number;
  /** The argument text, up to the call's own closing paren; a paren in a string never counts. */
  readonly body: string;
}

/** Every \`.animate(\` call, balanced to its closing paren. */
export function animateCalls(text: string): readonly AnimateCall[] {
  const calls: AnimateCall[] = [];
  for (const match of text.matchAll(/\\.animate\\s*\\(/g)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let quote = '';
    let i = start;
    for (; i < text.length && depth > 0; i += 1) {
      const ch = text[i] ?? '';
      if (quote !== '') {
        if (ch === '\\\\') i += 1;
        else if (ch === quote) quote = '';
      } else if (ch === "'" || ch === '"' || ch === '\`') quote = ch;
      else if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
    }
    calls.push({ start, body: text.slice(start, i - 1) });
  }
  return calls;
}
`;
