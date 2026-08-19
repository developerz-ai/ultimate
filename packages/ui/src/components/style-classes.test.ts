// A class name a component asks its stylesheet for, and the stylesheet does not declare, is dead
// code that reads as live: `cx` drops the `undefined`, so nothing renders wrong and nothing ever
// says so. Under `bun test` a `*.module.scss` import resolves to the file PATH, not a class map,
// so no render can answer this question — the source pair is what has to be compared, and this is
// the build error that makes "every class a component names exists" enforced rather than intended.

import { describe, expect, test } from 'bun:test';

const COMPONENTS = new URL('.', import.meta.url).pathname;

/** Only static keys: a `styles[`tone-${x}`]` is a family the stylesheet emits from a mixin. */
const STATIC_KEY = /styles\[(['"])([A-Za-z][\w-]*)\1\]/g;
const DECLARED = /\.([A-Za-z][\w-]*)/g;

describe('every class a component names is declared in its own stylesheet', () => {
  test('across src/components', async () => {
    const files = [...new Bun.Glob('*.tsx').scanSync({ cwd: COMPONENTS })].sort();
    expect(files.length).toBeGreaterThan(40);

    const undeclared: string[] = [];
    for (const file of files) {
      const stylesheet = `${COMPONENTS}${file.replace(/\.tsx$/, '.module.scss')}`;
      const source = await Bun.file(`${COMPONENTS}${file}`).text();
      const used = [...source.matchAll(STATIC_KEY)].map((match) => match[2] as string);
      if (used.length === 0) continue;
      // A component that names a class and ships no stylesheet is the same defect, louder.
      if (!(await Bun.file(stylesheet).exists())) {
        undeclared.push(`${file}: no stylesheet, but names ${used.join(', ')}`);
        continue;
      }
      const css = await Bun.file(stylesheet).text();
      const declared = new Set([...css.matchAll(DECLARED)].map((match) => match[1] as string));
      for (const name of new Set(used)) {
        if (!declared.has(name)) undeclared.push(`${file}: styles['${name}']`);
      }
    }
    expect(undeclared).toEqual([]);
  });
});
