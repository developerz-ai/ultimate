// A native form's refusal, as the page shows it: every code the app names reads as a catalog
// sentence (never ⟦key⟧), an unknown code reads as the general one, and a success shows nothing.
//
// Imported dynamically for the reason `app-shell.test.ts` gives: the `.tsx` loader must be in
// place before the module compiles.

import { beforeAll, expect, test } from 'bun:test';
// Side-effect import: `defineCatalogs()` runs on the way through, so `t()` resolves.
import '@social-media-clone/i18n';
import type { ActionAnswer } from '@ultimat3/action';
import { ctxOf, runWithContext } from '@ultimat3/core';
import { t } from '@ultimat3/i18n';
import { renderComponent } from '@ultimat3/render/server';

const FILE = 'apps/web/shared/ui/action-refusal.tsx';

let refusal: typeof import('./action-refusal');

const inEnglish = <T>(run: () => T): T => runWithContext(ctxOf({ tz: 'UTC', locale: 'en' }), run);

const render = (answer: ActionAnswer | null): Promise<string> =>
  inEnglish(() => renderComponent(() => refusal.ActionRefusal({ answer }), {}, FILE));

beforeAll(async () => {
  refusal = await import('./action-refusal');
});

test('unit · every code the app names reads as a catalog sentence', () => {
  for (const code of Object.keys(refusal.REFUSALS)) {
    expect(inEnglish(() => t(refusal.refusalKey(code)))).not.toContain('⟦');
  }
  expect(inEnglish(() => t(refusal.refusalKey('X_SOMETHING_ELSE')))).not.toContain('⟦');
});

test('unit · a refused sign-in shows its sentence; a success shows nothing', async () => {
  const wrong: ActionAnswer = {
    action: 'createSession',
    outcome: 'refusal',
    code: 'X_AUTH_CREDENTIALS_INVALID',
    issues: [],
    truncated: false,
  };
  const html = await render(wrong);
  expect(html).toContain('role="alert"');
  expect(html).toContain('That handle and password do not match.');
  expect(await render({ action: 'createSession', outcome: 'success' })).not.toContain('role=');
  expect(await render(null)).not.toContain('role=');
});
