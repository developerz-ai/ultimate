// The route-presented modal's look lives in `@ultimat3/ui` (`global.scss`), keyed by the attribute
// the router puts on its `<dialog>`. Two packages, one name: `ui` cannot import render (sideways),
// so the sheet is read as text — a rename on either side is red here, not an unstyled modal.
import { expect, test } from 'bun:test';
// why: Bun exposes no path API — nothing native joins a path.
import { join } from 'node:path';
import { NAVIGATION_MODAL_ATTRIBUTE } from './navigation-modal-rules';

test("ui's global sheet styles the router's dialog by the attribute it sets", async () => {
  const sheet = await Bun.file(join(import.meta.dir, '../../ui/src/global.scss')).text();
  expect(sheet).toContain(`:where(dialog[${NAVIGATION_MODAL_ATTRIBUTE}])`);
  // Painted like `Dialog`: the raised surface over the scrim, never a raw colour.
  expect(sheet).toMatch(/background:\s*t\.role\('surface-raised'\)/);
  expect(sheet).toContain('@include t.scrim-backdrop');
});
