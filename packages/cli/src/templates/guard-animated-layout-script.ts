// The `animated-layout-script` guard: `animated-layout-property`'s rule for TypeScript. A layout
// property handed to `.animate(` costs a layout or paint pass per frame; a box that must move
// through the layout is `layout()` from `@ultimat3/ui/motion`. A guard of its own, REPORT ONLY
// (`severity: 'warning'`), because `animated-layout-property` gates and a stricter rule on `main`
// is a break; `x new` writes the `"error"` row.

import { guardCode } from './guard';
import { TS_ANIMATE_SCAN_SOURCE } from './guard-raw-motion-ts-scan';
import type { GeneratedFile } from './naming';

/** Derived from the guard's name, never a literal: an `X_*` literal here is a FRAMEWORK code. */
const NAME = 'animated-layout-script';
const CODE = guardCode(NAME);

const source =
  (): string => `// animated-layout-script: an animation moves transform and opacity, never the layout.
// \`x verify\` discovers every file in \`guards/\` and runs its \`guard\` inside the \`boundaries\`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
//
// Read: a layout property (\`width\`, \`marginLeft\`, \`'box-shadow'\`) as a key of what a \`.animate(\`
// call is given, in a script outside tests. REPORT ONLY (\`severity: 'warning'\`).

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = '${CODE}';

/** What each layout property should have been, so the fix is an edit and not a category. */
const INSTEAD = new Map([
  ['top', 'transform: translateY(…)'],
  ['bottom', 'transform: translateY(…)'],
  ['left', 'transform: translateX(…)'],
  ['right', 'transform: translateX(…)'],
  ['inset', 'transform: translate(…)'],
  ['width', 'transform: scaleX(…)'],
  ['height', 'transform: scaleY(…)'],
  ['box-shadow', 'opacity on a shadow layer that is already painted'],
]);

/** A property whose change the browser cannot composite: it re-lays-out or re-paints the frame. */
const isLayoutProperty = (property: string): boolean =>
  INSTEAD.has(property) ||
  property.startsWith('margin') ||
  property.startsWith('padding') ||
  /^(?:min|max)-(?:width|height)$/.test(property);

${TS_ANIMATE_SCAN_SOURCE}
/** A keyframe key: \`width\`, \`'margin-left'\`, \`marginLeft\` — spelled either way in a script. */
const KEYFRAME_KEY = /(?<![\\w$.])(['"]?)([A-Za-z][\\w-]*)\\1\\s*:/g;
const kebab = (key: string): string => key.replaceAll(/[A-Z]/g, (ch) => \`-\${ch.toLowerCase()}\`);

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function animatedLayoutScripts(files: readonly ScriptFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    if (!isAppScript(file.path)) continue;
    const text = blankScriptComments(file.source);
    for (const call of animateCalls(text)) {
      for (const match of call.body.matchAll(KEYFRAME_KEY)) {
        const property = kebab(match[2] ?? '');
        if (!isLayoutProperty(property)) continue;
        const at = \`\${file.path}:\${scriptLineOf(text, call.start + match.index)}\`;
        findings.push({
          code: CODE,
          cause: \`\${at} animates \${property} in a keyframe object — only transform and opacity are compositor-only, so every frame of this costs a full layout or paint pass on the same main thread the app runs on\`,
          fix: \`animate the box with layout() — import { layout } from '@ultimat3/ui/motion' — or \${INSTEAD.get(property) ?? 'transform or opacity'} instead of \${property} at \${at}, then: x verify --only boundaries\`,
          at,
        });
      }
    }
  }
  return findings;
}

export const guard: Guard = {
  summary: 'a script animation moves transform and opacity, never the layout',
  severity: 'warning',
  async check(_root, sources) {
    const scripts = await sources.files('{apps,packages}/**/*.{ts,tsx}');
    return animatedLayoutScripts(scripts.map((file) => ({ path: file.path, source: file.text })));
  },
};
`;

const test =
  (): string => `// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { animatedLayoutScripts } from './animated-layout-script';

const script = (source: string) => [{ path: 'apps/web/app/feed/card.island.tsx', source }];

unitTest('a layout key in .animate( is refused in any spelling, and layout() is named', () => {
  const findings = animatedLayoutScripts(
    script('el.animate({ width: [0], marginLeft: 4, "box-shadow": x }, { duration: t });'),
  );
  expect(findings).toHaveLength(3);
  expect(findings[0]?.code).toBe('${CODE}');
  expect(findings[0]?.fix).toStartWith('animate the box with layout() — ');
  expect(findings[0]?.at).toBe('apps/web/app/feed/card.island.tsx:1');
});

unitTest('transform, opacity, other calls, a comment and a test file are silent', () => {
  expect(
    animatedLayoutScripts(script('el.animate({ transform: "none" }, { duration: t });')),
  ).toEqual([]);
  expect(animatedLayoutScripts(script('place({ width: 10, left: 4 });'))).toEqual([]);
  expect(animatedLayoutScripts(script('// el.animate({ width: 1 });'))).toEqual([]);
  expect(
    animatedLayoutScripts([{ path: 'apps/web/card.test.ts', source: 'el.animate({ width: 1 });' }]),
  ).toEqual([]);
});
`;

/** `guards/animated-layout-script.ts` and its test. The directory registers it. */
export const animatedLayoutScriptGuardFiles = (): readonly GeneratedFile[] => [
  { path: `guards/${NAME}.ts`, contents: source() },
  { path: `guards/${NAME}.test.ts`, contents: test() },
];
