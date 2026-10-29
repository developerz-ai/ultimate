// The route-presented modal's look lives in `@ultimat3/ui` (`global.scss`, the scroll lock in
// `tokens/reset.scss`), keyed by the attributes the router puts on its `<dialog>`. Two packages,
// one set of names: `ui` cannot import render (sideways), so the sheets are read as text — a rename
// on either side is red here, not an unstyled modal or a page that scrolls behind it.
import { expect, test } from 'bun:test';
// why: Bun exposes no path API — nothing native joins a path.
import { join } from 'node:path';
import {
  NAVIGATION_MODAL_ATTRIBUTE,
  NAVIGATION_MODAL_BODY_ATTRIBUTE,
  NAVIGATION_MODAL_CLOSE_ATTRIBUTE,
  NAVIGATION_MODAL_SKELETON_ATTRIBUTE,
} from './navigation-modal-rules';

const sheet = (path: string): Promise<string> =>
  Bun.file(join(import.meta.dir, '../../ui/src', path)).text();

test("ui's global sheet styles the router's dialog by the attribute it sets", async () => {
  const global = await sheet('global.scss');
  expect(global).toContain(`:where(dialog[${NAVIGATION_MODAL_ATTRIBUTE}])`);
  // Painted like `Dialog`: the raised surface over the scrim, never a raw colour.
  expect(global).toMatch(/background:\s*t\.role\('surface-raised'\)/);
  expect(global).toContain('@include t.scrim-backdrop');
});

test('the frame: its close button, its body and its skeleton are styled by the names it sets', async () => {
  const global = await sheet('global.scss');
  expect(global).toContain(`[${NAVIGATION_MODAL_CLOSE_ATTRIBUTE}]`);
  expect(global).toContain(`[${NAVIGATION_MODAL_BODY_ATTRIBUTE}]`);
  expect(global).toContain(`[${NAVIGATION_MODAL_SKELETON_ATTRIBUTE}]`);
});

test('a popover is never `:modal`: the reset locks the scroll behind the router dialog by name', async () => {
  const reset = await sheet('tokens/reset.scss');
  expect(reset).toContain(`html:has(> body > dialog[${NAVIGATION_MODAL_ATTRIBUTE}][open])`);
});
