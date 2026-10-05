// `@include t.disabled` appends `:disabled` / `[aria-disabled='true']` to the selector it is nested
// in. Nested under a selector that can never BE `:disabled` — a `[data-disabled]` wrapper, a
// pseudo-element — it compiles to a rule no element matches, and the dim silently never applies.

import { describe, expect, test } from 'bun:test';
import { compileScssFile } from '../sass-probe-fixture';

const COMPONENTS = new URL('.', import.meta.url).pathname;

/** A state selector that cannot match: `:disabled` after a pseudo-element or on a data flag. */
const DEAD_DISABLED =
  /::[\w-]+(?::disabled|\[aria-disabled)|\[data-disabled[^\]]*\](?::disabled|\[aria-disabled)/;

/** The declarations of the rule whose WHOLE selector is `selector`, or `''`. */
function ruleBody(css: string, selector: string): string {
  const at = css.indexOf(`\n${selector} {`);
  if (at < 0) return '';
  return css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
}

describe('a disabled control is dimmed by a rule that can match it', () => {
  test('no component sheet compiles a disabled state that no element can be in', async () => {
    const faults: string[] = [];
    for (const sheet of [...new Bun.Glob('*.module.scss').scanSync({ cwd: COMPONENTS })].sort()) {
      const dead = DEAD_DISABLED.exec(await compileScssFile(`${COMPONENTS}${sheet}`));
      if (dead !== null) faults.push(`${sheet}: ${dead[0]}`);
    }
    expect(faults).toEqual([]);
  });

  test('the Dropzone flag and the FileInput button carry the dim themselves', async () => {
    const dropzone = await compileScssFile(`${COMPONENTS}Dropzone.module.scss`);
    expect(ruleBody(dropzone, '.zone[data-disabled=true]')).toContain('opacity');
    const file = await compileScssFile(`${COMPONENTS}FileInput.module.scss`);
    expect(ruleBody(file, '.input:disabled::file-selector-button')).toContain('opacity');
  });
});
