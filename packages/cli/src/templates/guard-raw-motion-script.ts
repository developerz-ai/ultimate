// The `raw-motion-script` guard: `raw-motion`'s rule for TypeScript. A duration or delay handed to
// `.animate(` and a `cubic-bezier(` string come off the motion scale (`motionTiming()` from
// `@ultimat3/ui/motion`), so a script moves at the tempo the stylesheets do. A guard of its own,
// REPORT ONLY (`severity: 'warning'`), because `raw-motion` gates and a stricter rule on `main`
// is a break; `x new` writes the `"error"` row.

import { guardCode } from './guard';
import { TS_ANIMATE_SCAN_SOURCE } from './guard-raw-motion-ts-scan';
import { MOTION_SCALE_SOURCE } from './motion-scale';
import type { GeneratedFile } from './naming';

/** Derived from the guard's name, never a literal: an `X_*` literal here is a FRAMEWORK code. */
const NAME = 'raw-motion-script';
const CODE = guardCode(NAME);

const source =
  (): string => `// raw-motion-script: a script's durations and curves come off the motion scale, never a literal.
// \`x verify\` discovers every file in \`guards/\` and runs its \`guard\` inside the \`boundaries\`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
//
// Read: a nonzero number written as \`duration\`, \`delay\` or \`endDelay\` inside a \`.animate(\` call,
// and any \`cubic-bezier(\` string, in a script outside tests. REPORT ONLY (\`severity: 'warning'\`).

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = '${CODE}';

${MOTION_SCALE_SOURCE}
${TS_ANIMATE_SCAN_SOURCE}
const NUMBER_OPTION = /(?<![\\w$.])(duration|delay|endDelay)\\s*:\\s*(\\d*\\.?\\d+)(?![\\w.])/g;

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function rawMotionScripts(files: readonly ScriptFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    if (!isAppScript(file.path)) continue;
    const text = blankScriptComments(file.source);
    for (const call of animateCalls(text)) {
      for (const match of call.body.matchAll(NUMBER_OPTION)) {
        const ms = Number(match[2]);
        if (ms === 0) continue;
        const at = \`\${file.path}:\${scriptLineOf(text, call.start + match.index)}\`;
        findings.push({
          code: CODE,
          cause: \`\${at} animates with \\\`\${match[1]}: \${match[2]}\\\` — a time of this call's own, off the motion scale\`,
          fix: \`\${match[1]}: motionTiming('\${durationFor(ms)}') — import { motionTiming } from '@ultimat3/ui/motion' at \${at} (durations: \${DURATIONS.map(([name]) => name).join(' ')}), then: x verify --only boundaries\`,
          at,
        });
      }
    }
    for (const match of text.matchAll(/cubic-bezier\\(([^)]*)\\)/g)) {
      const at = \`\${file.path}:\${scriptLineOf(text, match.index)}\`;
      findings.push({
        code: CODE,
        cause: \`\${at} writes \\\`\${match[0]}\\\` — an easing curve of this file's own, off the motion scale\`,
        fix: \`motionTiming('base', '\${easingFor(match[1] ?? '')}') — import { motionTiming } from '@ultimat3/ui/motion' at \${at} (easings: \${Object.values(EASINGS).join(' ')}), then: x verify --only boundaries\`,
        at,
      });
    }
  }
  return findings;
}

export const guard: Guard = {
  summary: "a script's duration and easing curve come off the motion scale, never a literal",
  severity: 'warning',
  async check(_root, sources) {
    const scripts = await sources.files('{apps,packages}/**/*.{ts,tsx}');
    return rawMotionScripts(scripts.map((file) => ({ path: file.path, source: file.text })));
  },
};
`;

const test =
  (): string => `// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { rawMotionScripts } from './raw-motion-script';

const script = (source: string) => [{ path: 'apps/web/app/feed/card.island.tsx', source }];

unitTest('a number as duration or delay in .animate( is refused, with the token', () => {
  const findings = rawMotionScripts(
    script('el.animate({ opacity: [0, 1] }, { duration: 300, easing: "ease" });'),
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('${CODE}');
  expect(findings[0]?.fix).toStartWith("duration: motionTiming('base') — ");
  expect(rawMotionScripts(script('\\nel.animate(k, {\\n  delay: 130,\\n});'))[0]?.at).toBe(
    'apps/web/app/feed/card.island.tsx:3',
  );
});

unitTest('a cubic-bezier string in a script is refused, and the nearest token named', () => {
  const findings = rawMotionScripts(script("const e = 'cubic-bezier(0.2, 0.9, 0.3, 1)';"));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.fix).toStartWith("motionTiming('base', 'out') — ");
});

unitTest('a token read, a zero, another call, a comment and a test are silent', () => {
  const silent = [
    'el.animate(k, { duration: timing.duration, delay: 0 });',
    'el.animate(k, { duration: motionTiming("fast").duration });',
    'setTimeout(run, { duration: 300 });',
    'run({ duration: 300 });',
    '// el.animate(k, { duration: 300 });',
    "el.animate({ transform: 'translate(0)' }, { duration: t }); run({ duration: 300 });",
  ];
  for (const source of silent) expect(rawMotionScripts(script(source))).toEqual([]);
  expect(
    rawMotionScripts([
      { path: 'apps/web/app/card.test.ts', source: 'el.animate(k, { duration: 300 });' },
    ]),
  ).toEqual([]);
});
`;

/** `guards/raw-motion-script.ts` and its test. The directory registers it. */
export const rawMotionScriptGuardFiles = (): readonly GeneratedFile[] => [
  { path: `guards/${NAME}.ts`, contents: source() },
  { path: `guards/${NAME}.test.ts`, contents: test() },
];
