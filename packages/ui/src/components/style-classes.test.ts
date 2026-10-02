// A class name a component asks its stylesheet for, and the stylesheet does not declare, is dead
// code that reads as live: `cx` drops the `undefined`, so nothing renders wrong and nothing ever
// says so. Under `bun test` a `*.module.scss` import resolves to the file PATH, not a class map,
// so no render can answer this question — the source pair is what has to be compared, and this is
// the build error that makes "every class a component names exists" enforced rather than intended.
// Keys a component COMPUTES are held where they are computed (`button-classes.test.ts`).

import { describe, expect, test } from 'bun:test';

const COMPONENTS = new URL('.', import.meta.url).pathname;

/** `import buttonStyles from './Button.module.scss'` — the binding, and the sheet it reads. */
const SHEET_IMPORT = /import (\w+) from '\.\/([\w-]+\.module\.scss)'/g;
/** Only static keys: a `styles[`tone-${x}`]` is a family the stylesheet emits from a mixin. */
const STATIC_KEY = /\b(\w+)\[(['"])([A-Za-z][\w-]*)\2\]/g;
const DECLARED = /\.([A-Za-z][\w-]*)/g;

describe('every class a component names is declared in the stylesheet it reads it from', () => {
  test('across src/components', async () => {
    const files = [...new Bun.Glob('*.tsx').scanSync({ cwd: COMPONENTS })].sort();
    expect(files.length).toBeGreaterThan(40);

    const undeclared: string[] = [];
    let crossSheet = 0;
    for (const file of files) {
      const source = await Bun.file(`${COMPONENTS}${file}`).text();
      // By BINDING, not by the name `styles`: `Link` reads Button's sheet as `buttonStyles`, and a
      // check that only followed `styles` would wave through a dead key on the second sheet.
      const sheets = new Map(
        [...source.matchAll(SHEET_IMPORT)].map((match) => [match[1] as string, match[2] as string]),
      );
      for (const [binding, sheet] of sheets) {
        if (sheet !== file.replace(/\.tsx$/, '.module.scss')) crossSheet += 1;
        const used = [...source.matchAll(STATIC_KEY)]
          .filter((match) => match[1] === binding)
          .map((match) => match[3] as string);
        if (used.length === 0) continue;
        const stylesheet = Bun.file(`${COMPONENTS}${sheet}`);
        // A component that names a class in a stylesheet that is not there is the same defect, louder.
        if (!(await stylesheet.exists())) {
          undeclared.push(`${file}: no ${sheet}, but names ${used.join(', ')}`);
          continue;
        }
        const css = await stylesheet.text();
        const declared = new Set([...css.matchAll(DECLARED)].map((match) => match[1] as string));
        for (const name of new Set(used)) {
          if (!declared.has(name)) undeclared.push(`${file}: ${binding}['${name}'] (${sheet})`);
        }
      }
    }
    expect(undeclared).toEqual([]);
    // Non-vacuity for the second-sheet path: `Link` reading `Button.module.scss` is the case.
    expect(crossSheet).toBeGreaterThan(0);
  });
});
