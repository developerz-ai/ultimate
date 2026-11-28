// The `motion-adapter` guard: motion and GPU effects go through `@ultimat3/ui/motion` and
// `@ultimat3/effects`, never a second engine imported into app code. Every engine here is the
// framework's own (WAAPI for motion, a WebGL2 mount for shaders); a second one is a second tempo,
// a second reduced-motion story and a second bundle graph nobody budgeted. REPORT ONLY in an app
//
// that predates it (`severity: 'warning'`); `x new` writes the `"error"` row.

import { guardCode } from './guard';
import { TS_BLANK_SOURCE } from './guard-raw-motion-ts-scan';
import type { GeneratedFile } from './naming';

/** Derived from the guard's name, never a literal: an `X_*` literal here is a FRAMEWORK code. */
const NAME = 'motion-adapter';
const CODE = guardCode(NAME);

const source =
  (): string => `// motion-adapter: motion and GPU effects come from the framework's adapter, never a direct engine.
// \`x verify\` discovers every file in \`guards/\` and runs its \`guard\` inside the \`boundaries\`
// step — nothing registers this file, so nothing can forget to. Delete it to drop the rule.
//
// Read: an import, re-export, \`import()\` or \`require()\` of an engine's package or one of its
// subpaths, in a script outside tests. REPORT ONLY (\`severity: 'warning'\`): listed, never red,
// until an app is clean of it; \`"error"\` in \`guards/shipped.json\` makes it gate.

import type { Finding, Guard } from '@ultimat3/cli';

/** The app owns the codes its own conventions raise — this one is named for the guard. */
const CODE = '${CODE}';

const MOTION_FIX =
  "animate, stagger, inView, scrollLinked, layout, Presence from '@ultimat3/ui/motion'";
const GPU_FIX =
  "ShaderBackground, EffectCanvas or another effect from '@ultimat3/effects' (its static frame is the fallback)";

/** Package → the framework surface that does its job. */
const ENGINES: Readonly<Record<string, string>> = {
  motion: MOTION_FIX,
  'motion-dom': MOTION_FIX,
  'framer-motion': MOTION_FIX,
  gsap: MOTION_FIX,
  animejs: MOTION_FIX,
  'solid-motionone': MOTION_FIX,
  'solid-transition-group': "Presence, PresenceList from '@ultimat3/ui/motion'",
  '@paper-design/shaders': GPU_FIX,
  shaders: GPU_FIX,
  ogl: GPU_FIX,
  three: GPU_FIX,
};

export interface ScriptFile {
  /** App-root-relative POSIX path, so the finding names the file an author opens. */
  readonly path: string;
  readonly source: string;
}

const SPECIFIER = /(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*|\\brequire\\s*\\(\\s*)(['"])([^'"\\n]+)\\1/g;

/** \`three/examples/jsm/x\` → \`three\`; \`@paper-design/shaders/react\` → \`@paper-design/shaders\`. */
const packageOf = (specifier: string): string =>
  specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/');

${TS_BLANK_SOURCE}
/** Pure — the caller does the I/O — so the rule is testable without a filesystem. */
export function motionAdapter(files: readonly ScriptFile[]): readonly Finding[] {
  const findings: Finding[] = [];
  for (const file of files) {
    const text = blankScript(file.source);
    for (const match of text.matchAll(SPECIFIER)) {
      const engine = packageOf(match[2] ?? '');
      if (!Object.hasOwn(ENGINES, engine)) continue;
      const at = \`\${file.path}:\${text.slice(0, match.index).split('\\n').length}\`;
      findings.push({
        code: CODE,
        cause: \`\${at} imports \${engine}, a second animation or effect engine — the app moves at one tempo, under one reduced-motion rule, through the framework's own\`,
        fix: \`import \${ENGINES[engine]} at \${at}, then remove \${engine} from package.json and run: x verify --only boundaries\`,
        at,
      });
    }
  }
  return findings;
}

export const guard: Guard = {
  summary:
    'motion and effects come from @ultimat3/ui/motion and @ultimat3/effects, never a direct engine',
  severity: 'warning',
  async check(_root, sources) {
    const code = await sources.files('{apps,packages}/**/*.{ts,tsx}');
    return motionAdapter(
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
import { motionAdapter } from './motion-adapter';

const file = (source: string) => [{ path: 'apps/web/app/feed/card.island.tsx', source }];

unitTest('a direct engine import is refused, at its line, with the adapter to use', () => {
  const findings = motionAdapter(file("import { a } from './a';\\nimport b from 'motion';"));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('${CODE}');
  expect(findings[0]?.at).toBe('apps/web/app/feed/card.island.tsx:2');
  expect(findings[0]?.fix).toContain('@ultimat3/ui/motion');
});

unitTest('every engine, its subpaths, import(), require() and re-exports are the same rule', () => {
  const engines = [
    "import 'gsap';",
    "import { motion } from 'framer-motion';",
    "import { animate } from 'motion/react';",
    "import { x } from 'motion-dom';",
    "import a from 'animejs';",
    "import { Motion } from 'solid-motionone';",
    "import { TransitionGroup } from 'solid-transition-group';",
    "import { Mesh } from '@paper-design/shaders/react';",
    "import { Shader } from 'shaders';",
    "import { Renderer } from 'ogl';",
    "import { Scene } from 'three/examples/jsm/Addons.js';",
    "const m = await import('gsap');",
    "const t = require('three');",
    "export { animate } from 'motion';",
  ];
  for (const line of engines) expect(motionAdapter(file(line))).toHaveLength(1);
});

unitTest('a comment-like string hides nothing: the import after it is still refused', () => {
  expect(motionAdapter(file("const g = 'dist/*'; import('gsap'); /** d */"))).toHaveLength(1);
  expect(motionAdapter(file("const u = '//cdn'; const t = require('three');"))).toHaveLength(1);
});

unitTest('the adapter, a lookalike package, a comment and a string are silent', () => {
  const silent = [
    "import { animate } from '@ultimat3/ui/motion';",
    "import { Aurora } from '@ultimat3/effects';",
    "import { x } from 'motionless';",
    "import { x } from 'threes';",
    "import { x } from './motion';",
    "// import { animate } from 'motion';",
    "const s = 'gsap';",
  ];
  for (const line of silent) expect(motionAdapter(file(line))).toEqual([]);
});
`;

/** `guards/motion-adapter.ts` and its test. No index, no registry — the directory registers it. */
export const motionAdapterGuardFiles = (): readonly GeneratedFile[] => [
  { path: `guards/${NAME}.ts`, contents: source() },
  { path: `guards/${NAME}.test.ts`, contents: test() },
];
