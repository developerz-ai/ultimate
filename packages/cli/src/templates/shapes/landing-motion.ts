// What every shape's `site/` landing shares: the `@ultimat3/effects` dependency (pinned EXACT, like
// every `@ultimat3/*`), a CSS-tier Aurora behind the hero — 0 B of JavaScript, so the landing's
// `0kb` budget is untouched — and the one view-transition name the shell's content takes so the
// client router morphs list → detail while the chrome stays put.

import { loadVersion } from '../../version-loader';
import type { GeneratedFile } from '../naming';
import type { ShapeEdit } from './overlay';

const SITE = 'apps/web/site';

/** `@ultimat3/effects` joins the app's dependencies, in the sorted place the scaffold keeps. */
export const effectsDependency = (): ShapeEdit => ({
  path: 'package.json',
  find: `    "@ultimat3/entity": "${loadVersion()}",`,
  replace: `    "@ultimat3/effects": "${loadVersion()}",\n    "@ultimat3/entity": "${loadVersion()}",`,
});

/** The base landing: an Aurora as the hero's first child, laid under the hero's own content. */
export const baseLandingAurora = (): readonly ShapeEdit[] => [
  {
    path: `${SITE}/page.tsx`,
    find: "import { defineRoute } from '@ultimat3/render';\n",
    replace:
      "import { Aurora } from '@ultimat3/effects';\nimport { defineRoute } from '@ultimat3/render';\n",
  },
  {
    path: `${SITE}/page.tsx`,
    find: '      <header class={styles.hero}>\n',
    replace: '      <header class={styles.hero}>\n        <Aurora class={styles.aurora} />\n',
  },
  {
    path: `${SITE}/page.module.scss`,
    find: '.eyebrow {',
    replace: `// The backdrop is CSS alone (\`data-effect-backend="css"\`): the hero's content sits above it.
.hero > .aurora {
  position: absolute;
  inset: 0;
  z-index: tokens.z(base);
}

.hero > :not(.aurora) {
  position: relative;
  z-index: tokens.z(raised);
}

.eyebrow {`,
  },
];

/** Its test: the backdrop is the css tier and the landing still ships no island. */
export const landingMotionTest = (): GeneratedFile => ({
  path: `${SITE}/landing-motion.test.ts`,
  contents: `// The landing's backdrop is Aurora's CSS tier: it costs no JavaScript, so the page stays 0kb with
// no island, and the server's frame is what a reader under reduced motion keeps.
import { expect, renderRoute, unitTest } from '@ultimat3/testing';
import * as page from './page';

unitTest('the hero sits on a css-tier Aurora and the landing still hydrates nothing', async () => {
  const view = await renderRoute(page, { url: 'https://example.test/' });
  expect(view.html).toContain('data-effect-backend="css"');
  expect(page.config.hydrate).toBe('never');
  expect(page.config.budget.js).toBe('0kb');
  expect(view.islands).toEqual([]);
});
`,
});
