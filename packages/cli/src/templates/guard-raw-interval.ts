// The `raw-interval` guard `x new` ships: an island polls with `visibleInterval()` from
// `@ultimat3/core/page`, never a bare `setInterval(`. A raw interval keeps asking from a hidden tab
// and, past the session, asks for a 401 forever — five adopters hand-rolled the gate this replaces.
// A `// why:` on the call's line, or the line above it, admits a tick that is not a read.

import { guardCode } from './guard';
import { LOCAL_BINDING_SOURCE } from './guard-local-binding';
import type { GeneratedFile } from './naming';

/** Derived from the guard's name, never a literal: an `X_*` literal here is a FRAMEWORK code. */
const NAME = 'raw-interval';
const CODE = guardCode(NAME);

const source =
  (): string => `// raw-interval: an island polls with visibleInterval(), never a bare setInterval(.
// \`x verify\` discovers every file in \`guards/\` and runs its \`guard\` inside the \`boundaries\`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
//
// Why: a raw interval keeps asking from a background tab, and from a tab past its session it asks
// for a 401 forever. \`visibleInterval(run, ms)\` from \`@ultimat3/core/page\` makes no call while the
// tab is hidden, one when it is shown, and stops at the first lost session; a query's re-read is
// \`useQuery(ref, input, { poll: pollEvery(ms) })\`, the same timer, built. Read: a bare,
// \`window.\`, \`self.\` or \`globalThis.\` \`setInterval(\` in a \`*.island.tsx\`. Admitted: a \`// why:\` on
// the call's line or the line above it — an animation tick is not a read. Not read: a bare
// \`setInterval(\` in a file that binds its own (declared, imported, a parameter, destructured).

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = '${CODE}';

export interface SourceFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly source: string;
}

const CALL = /(?<![\\w$.])(?:(?:globalThis|window|self)\\s*\\.\\s*)?setInterval\\s*\\(/g;
const WHY = /\\/\\/\\s*why:/;

${LOCAL_BINDING_SOURCE}

/** Comments and string bodies blanked IN PLACE, so a line number still points at the source. */
const blank = (text: string): string =>
  text
    .replaceAll(/\\/\\*[\\s\\S]*?\\*\\//g, (match) => match.replaceAll(/[^\\n]/g, ' '))
    .replaceAll(/(?<![:\\w])\\/\\/[^\\n]*/g, (match) => ' '.repeat(match.length))
    .replaceAll(/'(?:[^'\\\\\\n]|\\\\.)*'|"(?:[^"\\\\\\n]|\\\\.)*"|\`(?:[^\`\\\\]|\\\\.)*\`/g, (match) =>
      match.replaceAll(/[^\\n]/g, ' '),
    );

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function rawIntervals(files: readonly SourceFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const lines = file.source.split('\\n');
    const text = blank(file.source);
    const local = bindsLocally(text, 'setInterval');
    for (const match of text.matchAll(CALL)) {
      // A bare call to the file's own \`setInterval\` is not the timer; \`window.\` always is.
      if (local && match[0].startsWith('setInterval')) continue;
      const line = text.slice(0, match.index).split('\\n').length;
      if (WHY.test(lines[line - 1] ?? '') || WHY.test(lines[line - 2] ?? '')) continue;
      const at = \`\${file.path}:\${line}\`;
      findings.push({
        code: CODE,
        cause: \`\${at} polls with setInterval, which keeps asking from a hidden tab and asks for a 401 forever once the session is gone\`,
        fix: \`re-read a query with useQuery(ref, input, { poll: pollEvery(ms) }) (pollEvery is exported by @ultimat3/realtime) at \${at}; any other read: import { visibleInterval } from '@ultimat3/core/page' and call visibleInterval(run, ms) there, disposing it on cleanup — or add a // why: comment on that line naming why this interval is not a read — then: x verify\`,
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
`;

const test =
  (): string => `// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { rawIntervals } from './raw-interval';

const file = (source: string) => [{ path: 'apps/web/app/feed/ticker.island.tsx', source }];

unitTest('a bare setInterval is refused, and the finding names the line', () => {
  const findings = rawIntervals(file('const a = 1;\\nconst id = setInterval(poll, 5000);'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('${CODE}');
  expect(findings[0]?.at).toBe('apps/web/app/feed/ticker.island.tsx:2');
});

unitTest('window., self. and globalThis. are the same rule', () => {
  expect(rawIntervals(file('window.setInterval(poll, 5000);'))).toHaveLength(1);
  expect(rawIntervals(file('self.setInterval(poll, 5000);'))).toHaveLength(1);
  expect(rawIntervals(file('globalThis.setInterval(poll, 5000);'))).toHaveLength(1);
});

unitTest('a why: on the line or the line above admits it', () => {
  expect(rawIntervals(file('setInterval(tick, 16); // why: a frame, not a read'))).toEqual([]);
  expect(rawIntervals(file('// why: a clock, not a read\\nsetInterval(tick, 1000);'))).toEqual([]);
});

unitTest('visibleInterval, another object, a comment and a string are not calls', () => {
  expect(rawIntervals(file('visibleInterval(poll, 5000);'))).toEqual([]);
  expect(rawIntervals(file('timers.setInterval(poll, 5000);'))).toEqual([]);
  expect(rawIntervals(file('// setInterval(poll, 5000);'))).toEqual([]);
  expect(rawIntervals(file("const s = 'setInterval(poll)';"))).toEqual([]);
});
`;

/** `guards/raw-interval.ts` and its test. No index, no registry — the directory registers it. */
export const rawIntervalGuardFiles = (): readonly GeneratedFile[] => [
  { path: `guards/${NAME}.ts`, contents: source() },
  { path: `guards/${NAME}.test.ts`, contents: test() },
];
