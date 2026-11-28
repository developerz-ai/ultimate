// The `motion-adapter` guard as `x new` emits it, run through the gate's own seam: a direct engine
// is refused at its line, report-only by the guard's own declaration (an "error" row in
// guards/shipped.json, which `x new` writes, makes it gate: `scaffold-guards.test.ts`);
// the framework's adapter and a lookalike are not.

import { describe, expect, test } from 'bun:test';
import { shippedGuardReport } from './shipped-guard-fixture';

const FILE = 'apps/web/app/feed/card.island.tsx';

describe('unit · shipped guard · motion-adapter', () => {
  test('a direct engine import is X_MOTION_ADAPTER, a warning by the guard own declaration', async () => {
    const report = await shippedGuardReport('motion-adapter', {
      [FILE]: "import { a } from './a';\nimport gsap from 'gsap';\n",
      'apps/web/app/feed/ok.island.tsx': "import { animate } from '@ultimat3/ui/motion';\n",
    });
    expect(report.findings).toEqual([]);
    expect(report.warnings.map((finding) => [finding.code, finding.at])).toEqual([
      ['X_MOTION_ADAPTER', `${FILE}:2`],
    ]);
    expect(report.warnings[0]?.fix).toContain("'@ultimat3/ui/motion'");
  });

  test('every named engine and a subpath, import() and require() are refused; a test file is not', async () => {
    const lines = [
      "import 'motion';",
      "import { x } from 'motion/react';",
      "import { x } from 'motion-dom';",
      "import { x } from 'framer-motion';",
      "import { x } from 'animejs';",
      "import { x } from 'solid-motionone';",
      "import { x } from 'solid-transition-group';",
      "import { x } from '@paper-design/shaders';",
      "import { x } from 'shaders/solid';",
      "import { x } from 'ogl';",
      "import { x } from 'three';",
      "const g = await import('gsap');",
    ];
    const report = await shippedGuardReport('motion-adapter', {
      [FILE]: `${lines.join('\n')}\n`,
      'apps/web/app/feed/card.test.tsx': "import 'gsap';\n",
    });
    expect(report.warnings).toHaveLength(lines.length);
  });

  test('a lookalike package name and a comment are silent', async () => {
    const report = await shippedGuardReport('motion-adapter', {
      [FILE]: "// import 'gsap';\nimport { x } from 'motionless';\nimport { y } from './three';\n",
    });
    expect([...report.findings, ...report.warnings]).toEqual([]);
  });
});
