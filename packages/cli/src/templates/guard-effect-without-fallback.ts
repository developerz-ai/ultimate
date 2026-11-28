// The `effect-without-fallback` guard: a GPU or canvas effect is `EffectCanvas` from
// `@ultimat3/effects`, whose `fallback` is required by type. A raw `<canvas`, a WebGL context or
// `navigator.gpu` in a page is an effect with no static frame: blank under reduced motion, no
// WebGL, a lost context, and in every screenshot and server-rendered byte. REPORT ONLY in an app
//
// that predates it (`severity: 'warning'`); `x new` writes the `"error"` row.

import { guardCode } from './guard';
import { TS_BLANK_SOURCE } from './guard-raw-motion-ts-scan';
import type { GeneratedFile } from './naming';

/** Derived from the guard's name, never a literal: an `X_*` literal here is a FRAMEWORK code. */
const NAME = 'effect-without-fallback';
const CODE = guardCode(NAME);

const source =
  (): string => `// effect-without-fallback: a canvas or GPU effect is EffectCanvas, whose fallback is required.
// \`x verify\` discovers every file in \`guards/\` and runs its \`guard\` inside the \`boundaries\`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
//
// Read: \`<canvas\`, \`getContext('webgl…')\` and \`navigator.gpu\` in a \`.tsx\` outside tests. A canvas
// the app draws is
// \`<EffectCanvas draw={…} fallback={…} />\`. REPORT ONLY (\`severity: 'warning'\`) until clean.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = '${CODE}';

export interface SourceFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly source: string;
}

const SIGNATURES: readonly (readonly [RegExp, string])[] = [
  [/<canvas\\b/g, 'a <canvas>'],
  [/getContext\\s*\\(\\s*(['"\`])webgl/g, 'a WebGL context'],
  [/(?<![\\w$])navigator\\s*\\.\\s*gpu\\b/g, 'navigator.gpu'],
];

${TS_BLANK_SOURCE}
/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function effectsWithoutFallback(files: readonly SourceFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const text = blankScript(file.source);
    for (const [pattern, name] of SIGNATURES) {
      for (const match of text.matchAll(pattern)) {
        const at = \`\${file.path}:\${text.slice(0, match.index).split('\\n').length}\`;
        findings.push({
          code: CODE,
          cause: \`\${at} draws with \${name} outside EffectCanvas — no static frame stands in when motion is reduced, WebGL is missing or the context is lost\`,
          fix: \`render <EffectCanvas draw={…} fallback={…} /> — import { EffectCanvas } from '@ultimat3/effects' — at \${at} (a ready-made effect such as ShaderBackground needs no canvas of yours), then: x verify --only boundaries\`,
          at,
        });
      }
    }
  }
  return findings.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '', 'en', { numeric: true }));
}

export const guard: Guard = {
  summary: 'a canvas or GPU effect is EffectCanvas, whose fallback is required, never a raw canvas',
  severity: 'warning',
  async check(_root, sources) {
    const code = await sources.files('{apps,packages}/**/*.tsx');
    return effectsWithoutFallback(
      code
        .filter((file) => !/\\.(?:test|spec)\\.tsx$/.test(file.path))
        .map((file) => ({ path: file.path, source: file.text })),
    );
  },
};
`;

const test =
  (): string => `// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { effectsWithoutFallback } from './effect-without-fallback';

const file = (source: string, path = 'apps/web/app/feed/orb.island.tsx') => [{ path, source }];

unitTest('a raw canvas is refused at its line, and the fix names EffectCanvas', () => {
  const findings = effectsWithoutFallback(file('const a = 1;\\nexport const V = () => <canvas />;'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('${CODE}');
  expect(findings[0]?.at).toBe('apps/web/app/feed/orb.island.tsx:2');
  expect(findings[0]?.fix).toContain('EffectCanvas');
});

unitTest('a WebGL context and navigator.gpu are the same rule', () => {
  expect(effectsWithoutFallback(file("const gl = el.getContext('webgl2');"))).toHaveLength(1);
  expect(effectsWithoutFallback(file('const gl = el.getContext("webgl");'))).toHaveLength(1);
  expect(effectsWithoutFallback(file('const gpu = navigator.gpu;'))).toHaveLength(1);
});

unitTest('a comment-like string hides nothing: the canvas after it is still refused', () => {
  expect(effectsWithoutFallback(file("const u = '//cdn'; const v = <canvas />;"))).toHaveLength(1);
});

unitTest('EffectCanvas, a 2d context, a comment and a string are silent', () => {
  expect(effectsWithoutFallback(file('<EffectCanvas draw={d} fallback={<img />} />'))).toEqual([]);
  expect(effectsWithoutFallback(file("const c = el.getContext('2d');"))).toEqual([]);
  expect(effectsWithoutFallback(file('// <canvas /> navigator.gpu'))).toEqual([]);
  const hidden = file("const s = '/* x */'; const t = <canvas />;");
  expect(effectsWithoutFallback(hidden)).toHaveLength(1);
});
`;

/** `guards/effect-without-fallback.ts` and its test. The directory registers it. */
export const effectWithoutFallbackGuardFiles = (): readonly GeneratedFile[] => [
  { path: `guards/${NAME}.ts`, contents: source() },
  { path: `guards/${NAME}.test.ts`, contents: test() },
];
