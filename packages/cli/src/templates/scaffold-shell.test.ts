// The scaffold's header bar at a phone's width. Its four pieces — the menu button, the brand, the
// environment pill and the theme toggle — did not shrink, so a generated app laid out 429px wide
// in a 390px viewport and the whole page scrolled sideways. Asserted off what Sass EMITS for the
// emitted sheet, with the ui tokens resolved from this checkout.

import { describe, expect, test } from 'bun:test';
import { names } from './naming';
import { shellFiles } from './scaffold-shell';

const TOKENS = Bun.fileURLToPath(new URL('../../../ui/src/tokens', import.meta.url));
const RENDER = Bun.fileURLToPath(new URL('../../../render', import.meta.url));

async function compiledShellSheet(): Promise<string> {
  const file = shellFiles(names('acme'), true).find((f) => f.path.endsWith('shell.module.scss'));
  const sass = (await import(Bun.resolveSync('sass', RENDER))) as {
    compileString(source: string, options: { url: URL }): { css: string };
  };
  const source = String(file?.contents ?? '').replace("'@ultimat3/ui/tokens'", `'${TOKENS}'`);
  return sass.compileString(source, { url: Bun.pathToFileURL(`${TOKENS}/../shell.module.scss`) })
    .css;
}

/** The declarations of the first top-level rule for `selector`. */
const ruleOf = (css: string, selector: string): string =>
  new RegExp(`(?:^|\\})\\s*${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';

describe('the scaffold header fits a 390px phone', () => {
  test('the bar and the brand may shrink below their content', async () => {
    const css = await compiledShellSheet();
    expect(ruleOf(css, '.bar')).toContain('min-inline-size: 0');
    expect(ruleOf(css, '.brand')).toContain('min-inline-size: 0');
  });

  test('a long app name truncates with an ellipsis instead of widening the page', async () => {
    const wordmark = ruleOf(await compiledShellSheet(), '.wordmark');
    expect(wordmark).toContain('text-overflow: ellipsis');
    expect(wordmark).toContain('overflow: hidden');
    expect(wordmark).toContain('white-space: nowrap');
  });

  test('the controls at the end keep their size; the pill compacts to its dot below sm', async () => {
    const css = await compiledShellSheet();
    expect(ruleOf(css, '.end')).toContain('flex: none');
    expect(css).toMatch(
      /@media \(max-width: 479\.98px\)\s*\{\s*\.envLabel\s*\{[^}]*clip-path: inset\(50%\)/,
    );
  });
});
