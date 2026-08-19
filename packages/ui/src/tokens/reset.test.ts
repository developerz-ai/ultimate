// The reset makes two claims a component header repeats, and a stylesheet cannot be asserted
// through a render — there is no CSS engine in this process. So the source is what is read: a
// claim in a `.tsx` header that no rule backs is the failure mode this file exists to catch.

import { describe, expect, test } from 'bun:test';

const RESET = new URL('./reset.scss', import.meta.url).pathname;
const DIALOG = new URL('../components/Dialog.tsx', import.meta.url).pathname;

describe('reset.scss', () => {
  test('locks body scroll behind a modal surface, which Dialog and Drawer both rely on', async () => {
    const css = await Bun.file(RESET).text();
    const rule = /html:has\(dialog:modal\)\s*\{[^}]*overflow:\s*hidden/;
    // `Dialog`'s header sold body scroll locking and nothing implemented it, so wheeling over the
    // backdrop scrolled the page behind an open dialog. `:modal`, not `[open]`: a non-modal
    // <dialog> shown with `show()` must not freeze the page.
    expect(rule.test(css)).toBe(true);
  });

  test('Dialog points at where the lock actually lives, rather than claiming to do it', async () => {
    const source = await Bun.file(DIALOG).text();
    expect(source).toContain('tokens/reset.scss');
  });
});
