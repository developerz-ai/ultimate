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
// Read: a layout property (\`width\`, \`marginLeft\`, \`'box-shadow'\`) as a KEY of the keyframes a
// \`.animate(\` call is given (its first argument), in a script outside tests. REPORT ONLY (\`severity: 'warning'\`).

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
/**
 * A keyframe key: \`width\`, \`'margin-left'\`, \`marginLeft\` — spelled either way in a script, and
 * only in KEY position (after \`{\` or \`,\`): \`up ? top : bottom\` is a value, not a key.
 */
const KEYFRAME_KEY = /(?<=[{,]\\s*)(['"]?)([A-Za-z][\\w-]*)\\1\\s*:(?!:)/g;

/** The text up to a call's first top-level comma: the keyframes, never the options object. */
const firstArgument = (body: string): string => {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] ?? '';
    if (quote !== '') {
      if (ch === '\\\\') i += 1;
      else if (ch === quote) quote = '';
    } else if (ch === "'" || ch === '"' || ch === '\`') quote = ch;
    else if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) depth -= 1;
    else if (ch === ',' && depth === 0) return body.slice(0, i);
  }
  return body;
};

/** Whether \`index\` sits inside a string literal; a quoted key's opening quote does not. */
const insideString = (text: string, index: number): boolean => {
  let quote = '';
  for (let i = 0; i < index; i += 1) {
    const ch = text[i] ?? '';
    if (quote !== '') {
      if (ch === '\\\\') i += 1;
      else if (ch === quote) quote = '';
    } else if (ch === "'" || ch === '"' || ch === '\`') quote = ch;
  }
  return quote !== '';
};
const kebab = (key: string): string => key.replaceAll(/[A-Z]/g, (ch) => \`-\${ch.toLowerCase()}\`);

/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function animatedLayoutScripts(files: readonly ScriptFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    if (!isAppScript(file.path)) continue;
    const text = blankScriptComments(file.source);
    for (const call of animateCalls(text)) {
      const keyframes = firstArgument(call.body);
      for (const match of keyframes.matchAll(KEYFRAME_KEY)) {
        if (insideString(keyframes, match.index)) continue;
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

unitTest('only keyframe keys count: values, strings and the options object are silent', () => {
  const silent = [
    'el.animate({ transform: up ? top : bottom }, { duration: t });',
    "el.animate({ id: 'width: grow' }, { duration: t });",
    'el.animate({ opacity: 1 }, { duration: t, top: 1, width: 2 });',
    "el.animate({ label: 'a, left: 1' }, o);",
  ];
  for (const source of silent) expect(animatedLayoutScripts(script(source))).toEqual([]);
  const array = script('el.animate([{ left: 0 }, { left: 9 }], { duration: t });');
  expect(animatedLayoutScripts(array)).toHaveLength(2);
});

unitTest('a comment-like string does not hide the call after it', () => {
  const source = "const g = 'dist/*'; el.animate({ width: 1 }, o); /** doc */";
  expect(animatedLayoutScripts(script(source))).toHaveLength(1);
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
