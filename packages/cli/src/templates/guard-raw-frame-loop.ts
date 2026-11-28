// The `raw-frame-loop` guard: a per-frame loop is `frameLoop()` from `@ultimat3/ui/motion`, never a
// bare `requestAnimationFrame(`. A raw loop keeps painting in a hidden tab, offscreen and under
// reduced motion; `frameLoop` stops for each of those and for a user's pause (WCAG 2.2.2). A
// `// why:` on the call's line, or the line above it, admits a one-shot that is not a loop —
// as `raw-interval` admits a tick. REPORT ONLY in an app that predates it.

import { guardCode } from './guard';
import { LOCAL_BINDING_SOURCE } from './guard-local-binding';
import type { GeneratedFile } from './naming';

/** Derived from the guard's name, never a literal: an `X_*` literal here is a FRAMEWORK code. */
const NAME = 'raw-frame-loop';
const CODE = guardCode(NAME);

const source =
  (): string => `// raw-frame-loop: a per-frame loop is frameLoop(), never a bare requestAnimationFrame(.
// \`x verify\` discovers every file in \`guards/\` and runs its \`guard\` inside the \`boundaries\`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
//
// Why: a raw loop paints on in a hidden tab, offscreen and under reduced motion, and no user can
// pause it. \`frameLoop(tick, { el })\` from \`@ultimat3/ui/motion\` stops for each of those. Read: a
// bare, \`window.\`, \`self.\` or \`globalThis.\` \`requestAnimationFrame(\` in a script outside tests.
// Admitted: a \`// why:\` on the call's line or the line above it. Not read: a file that binds its
// own \`requestAnimationFrame\`. REPORT ONLY (\`severity: 'warning'\`) until an app is clean of it.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = '${CODE}';

export interface SourceFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly source: string;
}

const CALL = /(?<![\\w$.])(?:(?:globalThis|window|self)\\s*\\.\\s*)?requestAnimationFrame\\s*\\(/g;
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
export function rawFrameLoops(files: readonly SourceFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const lines = file.source.split('\\n');
    const text = blank(file.source);
    const local = bindsLocally(text, 'requestAnimationFrame');
    for (const match of text.matchAll(CALL)) {
      // A bare call to the file's own \`requestAnimationFrame\` is not the browser's; \`window.\` is.
      if (local && match[0].startsWith('requestAnimationFrame')) continue;
      const line = text.slice(0, match.index).split('\\n').length;
      if (WHY.test(lines[line - 1] ?? '') || WHY.test(lines[line - 2] ?? '')) continue;
      const at = \`\${file.path}:\${line}\`;
      findings.push({
        code: CODE,
        cause: \`\${at} runs a frame loop with requestAnimationFrame, which keeps painting in a hidden tab, offscreen and under reduced motion, and which no user can pause\`,
        fix: \`import { frameLoop } from '@ultimat3/ui/motion' and call frameLoop(tick, { el }) at \${at}, disposing it on cleanup — or add a // why: comment on that line naming why this call is not a loop — then: x verify --only boundaries\`,
        at,
      });
    }
  }
  return findings;
}

export const guard: Guard = {
  summary: 'a per-frame loop is frameLoop(), never a bare requestAnimationFrame',
  severity: 'warning',
  async check(_root, sources) {
    const code = await sources.files('{apps,packages}/**/*.{ts,tsx}');
    return rawFrameLoops(
      code
        .filter((file) => !/\\.(?:test|spec|d)\\.tsx?$/.test(file.path))
        .map((file) => ({ path: file.path, source: file.text })),
    );
  },
};
`;

const test =
  (): string => `// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { rawFrameLoops } from './raw-frame-loop';

const file = (source: string) => [{ path: 'apps/web/app/feed/orb.island.tsx', source }];

unitTest('a bare requestAnimationFrame is refused, and the finding names the line', () => {
  const findings = rawFrameLoops(file('const a = 1;\\nrequestAnimationFrame(tick);'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('${CODE}');
  expect(findings[0]?.at).toBe('apps/web/app/feed/orb.island.tsx:2');
  expect(findings[0]?.fix).toContain('frameLoop');
});

unitTest('window., self. and globalThis. are the same rule', () => {
  expect(rawFrameLoops(file('window.requestAnimationFrame(tick);'))).toHaveLength(1);
  expect(rawFrameLoops(file('self.requestAnimationFrame(tick);'))).toHaveLength(1);
  expect(rawFrameLoops(file('globalThis.requestAnimationFrame(tick);'))).toHaveLength(1);
});

unitTest('a why: on the line or the line above admits it', () => {
  const same = file('requestAnimationFrame(focus); // why: one frame');
  expect(rawFrameLoops(same)).toEqual([]);
  const above = file('// why: one frame\\nrequestAnimationFrame(focus);');
  expect(rawFrameLoops(above)).toEqual([]);
});

unitTest('frameLoop, another object, a comment, a string and a local binding are not calls', () => {
  expect(rawFrameLoops(file('frameLoop(tick, { el });'))).toEqual([]);
  expect(rawFrameLoops(file('clock.requestAnimationFrame(tick);'))).toEqual([]);
  expect(rawFrameLoops(file('// requestAnimationFrame(tick);'))).toEqual([]);
  expect(rawFrameLoops(file("const s = 'requestAnimationFrame(tick)';"))).toEqual([]);
  expect(
    rawFrameLoops(file('const requestAnimationFrame = fake;\\nrequestAnimationFrame(tick);')),
  ).toEqual([]);
});
`;

/** `guards/raw-frame-loop.ts` and its test. No index, no registry — the directory registers it. */
export const rawFrameLoopGuardFiles = (): readonly GeneratedFile[] => [
  { path: `guards/${NAME}.ts`, contents: source() },
  { path: `guards/${NAME}.test.ts`, contents: test() },
];
