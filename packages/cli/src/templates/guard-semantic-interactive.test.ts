// The `semantic-interactive` guard as `x new` emits it, run through the gate's own seam: an option
// an `aria-activedescendant` combobox manages takes no focus and no keys of its own, so it is
// silent; a clickable inert element and a `role="button"` with no key handler are not.

import { describe, expect, test } from 'bun:test';
import { shippedGuardFindings } from './shipped-guard-fixture';

const PAGE = 'apps/web/app/search/page.tsx';

const findingsFor = async (line: string): Promise<readonly string[]> =>
  (await shippedGuardFindings('semantic-interactive', { [PAGE]: `${line}\n` })).map(
    (finding) => finding.code,
  );

describe('unit · shipped guard · semantic-interactive', () => {
  test('an option the combobox manages, focus -1, is silent', async () => {
    for (const option of [
      'export const O = () => <div role="option" tabIndex={-1} onMouseDown={pick}>A</div>;',
      'export const O = () => <li role="option" tabindex="-1" onClick={pick}>A</li>;',
    ]) {
      expect(await findingsFor(option)).toEqual([]);
    }
  });

  test('a clickable div, a role="button" with no keys and an option with no -1 are refused', async () => {
    for (const refused of [
      'export const D = () => <div onClick={go}>Go</div>;',
      'export const B = () => <div role="button" tabIndex={0} onClick={go}>Go</div>;',
      'export const O = () => <div role="option" onMouseDown={pick}>A</div>;',
      'export const F = () => <div role="option" tabIndex={0} onMouseDown={pick}>A</div>;',
      'export const T = () => <div role="treeitem" tabIndex={-1} onClick={pick}>A</div>;',
    ]) {
      expect(await findingsFor(refused)).toEqual(['X_SEMANTIC_INTERACTIVE']);
    }
  });
});
