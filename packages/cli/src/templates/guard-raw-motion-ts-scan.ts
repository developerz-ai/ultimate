// The TypeScript half of the motion guards, as source text two emitted guards carry (`raw-motion`
// and `animated-layout-property`): a guard imports nothing but types, so the helper is embedded,
// as `LOCAL_BINDING_SOURCE` is. Reads `.animate(` calls — WAAPI's one entry — never a whole file.

export const TS_ANIMATE_SCAN_SOURCE = `export interface ScriptFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly source: string;
}

/** A script an author did not write for the app: a test, a story, a declaration. */
export const isAppScript = (path: string): boolean =>
  /\\.(?:ts|tsx)$/.test(path) && !/\\.(?:test|spec|d)\\.tsx?$/.test(path);

/** Comments blanked IN PLACE so a line number still points at the source; strings are kept. */
export const blankScriptComments = (text: string): string =>
  text
    .replaceAll(/\\/\\*[\\s\\S]*?\\*\\//g, (match) => match.replaceAll(/[^\\n]/g, ' '))
    .replaceAll(/(?<![:\\w])\\/\\/[^\\n]*/g, (match) => ' '.repeat(match.length));

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
