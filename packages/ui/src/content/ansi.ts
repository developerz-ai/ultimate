// Terminal output to styled runs, line by line. SGR 30–37 and 90–97 map to semantic roles; 256 and
// truecolor fall to the default foreground — no raw colour ever leaves here. Every other escape
// (cursor moves, OSC titles, private modes) and every other control byte is dropped, never printed.

/** The roles a run's colour can name; `TerminalView.module.scss` styles each. */
export type AnsiRole =
  | 'muted'
  | 'danger'
  | 'success'
  | 'warning'
  | 'info'
  | 'chart-5'
  | 'chart-1'
  | 'strong';

export interface AnsiStyle {
  readonly fg?: AnsiRole | undefined;
  readonly bold?: boolean | undefined;
  readonly dim?: boolean | undefined;
  readonly italic?: boolean | undefined;
  readonly underline?: boolean | undefined;
}

export interface AnsiRun extends AnsiStyle {
  readonly text: string;
}

export type AnsiLine = readonly AnsiRun[];

/** Black, red, green, yellow, blue, magenta, cyan, white — normal and bright alike. */
const PALETTE: readonly (AnsiRole | undefined)[] = [
  'muted',
  'danger',
  'success',
  'warning',
  'info',
  'chart-5',
  'chart-1',
  'strong',
];

const ESC = '\u001b';
/** CSI: parameters, intermediates, one final byte. */
const CSI = /\[([0-?]*)[ -/]*([@-~])/y;

interface Pen {
  fg?: AnsiRole | undefined;
  bold?: boolean | undefined;
  dim?: boolean | undefined;
  italic?: boolean | undefined;
  underline?: boolean | undefined;
}

/** One SGR sequence applied to the pen. Unknown codes change nothing. */
function applySgr(pen: Pen, params: string): void {
  const codes =
    params === '' ? [0] : params.split(/[;:]/).map((part) => (part === '' ? 0 : Number(part)));
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i] ?? 0;
    if (code === 0) {
      pen.fg = undefined;
      pen.bold = pen.dim = pen.italic = pen.underline = undefined;
    } else if (code === 1) pen.bold = true;
    else if (code === 2) pen.dim = true;
    else if (code === 3) pen.italic = true;
    else if (code === 4) pen.underline = true;
    else if (code === 22) pen.bold = pen.dim = undefined;
    else if (code === 23) pen.italic = undefined;
    else if (code === 24) pen.underline = undefined;
    else if (code >= 30 && code <= 37) pen.fg = PALETTE[code - 30];
    else if (code >= 90 && code <= 97) pen.fg = PALETTE[code - 90];
    else if (code === 39) pen.fg = undefined;
    else if (code === 38 || code === 48) {
      // 256-colour and truecolor have no semantic role: the default foreground, and skip the args.
      if (code === 38) pen.fg = undefined;
      i += codes[i + 1] === 5 ? 2 : codes[i + 1] === 2 ? 4 : 0;
    }
  }
}

const isPrintable = (code: number): boolean =>
  code === 9 || (code >= 0x20 && code !== 0x7f && (code < 0x80 || code > 0x9f));

/** The lines of `text`, each a list of styled runs. Joined, the runs hold no control byte. */
export function parseAnsi(text: string): AnsiLine[] {
  const lines: AnsiLine[] = [];
  let line: AnsiRun[] = [];
  let pen: Pen = {};
  let buf = '';
  const flush = (): void => {
    if (buf === '') return;
    const run: AnsiRun = { text: buf, ...pen };
    line.push(
      Object.fromEntries(
        Object.entries(run).filter(([, value]) => value !== undefined),
      ) as unknown as AnsiRun,
    );
    buf = '';
  };
  for (let i = 0; i < text.length; ) {
    const char = text[i] ?? '';
    if (char === ESC) {
      flush();
      const next = text[i + 1];
      if (next === '[') {
        CSI.lastIndex = i + 1;
        const csi = CSI.exec(text);
        if (csi === null) {
          i += 2;
          continue;
        }
        if (csi[2] === 'm') {
          pen = { ...pen };
          applySgr(pen, csi[1] ?? '');
        }
        i += 1 + csi[0].length;
      } else if (next === ']' || next === 'P' || next === '_' || next === '^') {
        // OSC / DCS / APC / PM: a string ended by BEL or ST, swallowed whole.
        let j = i + 2;
        while (
          j < text.length &&
          text[j] !== '\u0007' &&
          !(text[j] === ESC && text[j + 1] === '\\')
        )
          j += 1;
        i = text[j] === '\u0007' ? j + 1 : j + 2;
      } else i += next === undefined ? 1 : 2;
      continue;
    }
    if (char === '\n') {
      flush();
      lines.push(line);
      line = [];
      i += 1;
      continue;
    }
    const code = char.charCodeAt(0);
    if (isPrintable(code)) buf += char;
    i += 1;
  }
  flush();
  if (line.length > 0 || lines.length === 0) lines.push(line);
  return lines;
}
