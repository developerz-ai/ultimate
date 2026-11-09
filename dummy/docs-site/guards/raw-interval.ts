// raw-interval: an island polls with visibleInterval(), never a bare setInterval(.
// `x verify` discovers every file in `guards/` and runs its `guard` inside the `boundaries`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
//
// Why: a raw interval keeps asking from a background tab, and from a tab past its session it asks
// for a 401 forever. `visibleInterval(run, ms)` from `@ultimat3/core/page` makes no call while the
// tab is hidden, one when it is shown, and stops at the first lost session. Read: a bare,
// `window.`, `self.` or `globalThis.` `setInterval(` in a `*.island.tsx`. Admitted: a `// why:` on
// the call's line or the line above it — an animation tick is not a read.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = 'X_RAW_INTERVAL';

export interface SourceFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly source: string;
}

const CALL = /(?<![\w$.])(?:(?:globalThis|window|self)\s*\.\s*)?setInterval\s*\(/g;
const WHY = /\/\/\s*why:/;

/** Comments and string bodies blanked IN PLACE, so a line number still points at the source. */
const blank = (text: string): string =>
  text
    .replaceAll(/\/\*[\s\S]*?\*\//g, (match) => match.replaceAll(/[^\n]/g, ' '))
    .replaceAll(/(?<![:\w])\/\/[^\n]*/g, (match) => ' '.repeat(match.length))
    .replaceAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, (match) =>
      match.replaceAll(/[^\n]/g, ' '),
    );

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function rawIntervals(files: readonly SourceFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const lines = file.source.split('\n');
    const text = blank(file.source);
    for (const match of text.matchAll(CALL)) {
      const line = text.slice(0, match.index).split('\n').length;
      if (WHY.test(lines[line - 1] ?? '') || WHY.test(lines[line - 2] ?? '')) continue;
      const at = `${file.path}:${line}`;
      findings.push({
        code: CODE,
        cause: `${at} polls with setInterval, which keeps asking from a hidden tab and asks for a 401 forever once the session is gone`,
        fix: `import { visibleInterval } from '@ultimat3/core/page' and call visibleInterval(run, ms) at ${at}, disposing it on cleanup — or add a // why: comment on that line naming why this interval is not a read — then: x verify`,
        at,
      });
    }
  }
  return findings;
}

export const guard: Guard = {
  summary: 'an island polls with visibleInterval(), never a bare setInterval',
  async check(_root, sources) {
    // The run's ONE read of the source: every guard asking for this glob shares the walk.
    const code = await sources.files('{apps,packages}/**/*.{ts,tsx}');
    return rawIntervals(
      code
        .filter((file) => file.path.endsWith('.island.tsx'))
        .map((file) => ({ path: file.path, source: file.text })),
    );
  },
};
