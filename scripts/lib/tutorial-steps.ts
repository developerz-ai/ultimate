// Single responsibility: read a tutorial page as the script it claims to be — each ```bash fence a
// step, in order, with the `✓`/`✗` summary line of the ```text fence right after it as the step's
// expected output — and hold a printed line to it. `tutorial-run.ts` executes; this file only reads.

const FENCE = /^\s*(```|~~~)\s*([\w-]*)/;
// The reason is required: a skipped step the page does not explain is a step nobody re-checks.
const NO_RUN = /^\s*<!--\s*no-run:\s*(\S[^>]*?)\s*-->\s*$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: an ANSI colour escape is ESC, literally.
const ANSI = /\u001b\[[0-9;]*m/g;
/** The page's own mark for a span that differs run to run: `…ms`, `…_add_todos`. */
export const VARIABLE = '…';

export interface TutorialStep {
  readonly path: string;
  /** 1-based line of the opening fence. */
  readonly line: number;
  readonly command: string;
  /** The `<!-- no-run: why -->` reason above the fence, when the page skips it. */
  readonly skip: string | undefined;
  /** The summary lines of the text fence that follows, in order. Empty: only the exit code is held. */
  readonly expected: readonly string[];
}

/** The unindented `✓`/`✗` lines of an output, colour stripped: what a run says about itself. */
export const summaryLines = (output: string): readonly string[] =>
  output
    .replace(ANSI, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.startsWith('✓') || line.startsWith('✗'));

interface Fence {
  readonly line: number;
  readonly info: string;
  readonly body: string;
  readonly marker: string | undefined;
}

function fencesOf(text: string): readonly Fence[] {
  const fences: Fence[] = [];
  const lines = text.split('\n');
  let open: { line: number; info: string; marker: string | undefined; body: string[] } | undefined;
  let previous = '';
  lines.forEach((line, index) => {
    const fence = FENCE.exec(line);
    if (open !== undefined) {
      if (fence !== null && (fence[2] ?? '') === '') {
        fences.push({ ...open, body: open.body.join('\n') });
        open = undefined;
        // A marker belongs to the ONE fence below it, never to the next one down the page.
        previous = '';
      } else open.body.push(line);
      return;
    }
    if (fence !== null) {
      open = {
        line: index + 1,
        info: fence[2] ?? '',
        marker: NO_RUN.exec(previous)?.[1],
        body: [],
      };
      return;
    }
    if (line.trim() !== '') previous = line;
  });
  return fences;
}

/** Every bash fence of one page, in page order. Pure over the text. */
export function tutorialSteps(path: string, text: string): readonly TutorialStep[] {
  const fences = fencesOf(text);
  return fences.flatMap((fence, index) => {
    if (fence.info !== 'bash') return [];
    const next = fences[index + 1];
    return [
      {
        path,
        line: fence.line,
        command: fence.body,
        skip: fence.marker,
        expected: next?.info === 'text' ? summaryLines(next.body) : [],
      },
    ];
  });
}

const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether one printed summary line is the page's line, `…` matching any span and nothing else. */
export function matchesSummary(expected: string, printed: readonly string[]): boolean {
  const pattern = new RegExp(`^${expected.split(VARIABLE).map(literal).join('.*?')}$`);
  return printed.some((line) => pattern.test(line));
}
