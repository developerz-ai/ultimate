// Read the failing tests out of the text `bun test` prints: each `(fail)` line, named with the file
// header above it, and the lines between the two as the excerpt an issue quotes. Pure, so the
// shapes Bun really prints are pinned in the test beside it and nothing here spawns.

/** One test that failed, where it lives, and what Bun printed for it. */
export interface FailedTest {
  readonly file: string;
  readonly test: string;
  readonly excerpt: string;
}

/** A file header: the path Bun prints before that file's results — bare, or in CI's ::group:: line. */
const HEADER = /^(?:::group::)?(\S.*\.test\.[cm]?[jt]sx?):$/;
/** A failure line, its trailing `[1.20ms]` timing dropped so a rerun names the same test. */
const FAIL = /^\s*\(fail\)\s+(.*?)(?:\s+\[[\d.]+m?s\])?\s*$/;
/** Bun's end-of-run repeat of every failure, under no file header: never a second failure. */
const REPEAT = /^\s*\d+ tests? failed:?\s*$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: an ANSI escape IS a control character.
const ANSI = /\u001b\[[0-9;]*m/g;
/** An excerpt is for a reader, never a log: the lines nearest the failure carry the assertion. */
const EXCERPT_LINES = 12;

export function failedTests(output: string): readonly FailedTest[] {
  const found: FailedTest[] = [];
  let file: string | undefined;
  let since: string[] = [];
  for (const raw of output.split('\n')) {
    const line = raw.replace(ANSI, '');
    if (REPEAT.test(line)) break;
    const header = HEADER.exec(line);
    if (header !== null) {
      file = header[1];
      since = [];
      continue;
    }
    const fail = FAIL.exec(line);
    if (fail === null || file === undefined) {
      since.push(line);
      continue;
    }
    found.push({ file, test: fail[1] ?? '', excerpt: since.slice(-EXCERPT_LINES).join('\n') });
    since = [];
  }
  return found;
}
