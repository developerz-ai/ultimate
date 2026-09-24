// One broken module, one red line: the app's load failures are the `manifest` step's, and every
// other step that loaded the app says where they went instead of repeating them.

import { describe, expect, test } from 'bun:test';
import { LOAD_OWNER, withLoadFindings, withoutLoadFindings } from './load-findings';
import type { Finding } from './output';

const broken: Finding = {
  code: 'X_APP_MODULE_FAILED',
  cause: 'apps/web/app/post/entity.ts: SyntaxError',
  fix: 'x verify --only typecheck --json',
  at: 'apps/web/app/post/entity.ts',
};
const own: Finding = { code: 'X_BUDGET_UNMEASURED', cause: '/posts has no stats', fix: 'x build' };
const load = async () => ({ findings: [broken] });

describe('unit · a load failure is reported once', () => {
  test('a non-owner step drops it, keeps its own, and says where it went', async () => {
    const outcome = await withoutLoadFindings('/app', [broken, own], load);
    expect(outcome.findings).toEqual([own]);
    expect(outcome.ok).toBe(false);
    expect(outcome.output).toBe(`skipped: 1 module-load finding(s) — see ${LOAD_OWNER}`);
  });

  test('a step whose only finding was the load is green, and says so', async () => {
    const outcome = await withoutLoadFindings('/app', [{ ...broken }], load);
    expect(outcome).toEqual({
      ok: true,
      findings: [],
      output: `skipped: 1 module-load finding(s) — see ${LOAD_OWNER}`,
    });
  });

  test('the owner carries it exactly once, even when its own check repeated it', async () => {
    expect(await withLoadFindings('/app', [broken, own], load)).toEqual([broken, own]);
    expect(await withLoadFindings('/app', [], load)).toEqual([broken]);
  });
});
