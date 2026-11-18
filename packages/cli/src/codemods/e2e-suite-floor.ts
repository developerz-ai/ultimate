// 31.47.1: 31.28.0's floor required `e2e` of any app with a page, while only `apps/web/site/page.tsx`
// got a suite, so an app without that page answered `X_VERIFY_SUITE_VANISHED`. A floor in that state
// gains the suite, or, with no page a suite could visit, excuses the step and says why.

import { isJsonObject } from '@ultimat3/core';
import { VERIFY_FLOOR_FILE } from '../verify-floor';
import type { Codemod, CodemodResult } from './codemod';
import { e2eSuitePlan, writeE2eSuite } from './e2e-suite';
import { e2eExcuse, renderFloor, withSkip } from './verify-floor-skips';

const NOTHING: CodemodResult = { changed: [], skipped: [] };

function parsed(source: string): Record<string, unknown> | undefined {
  try {
    const floor: unknown = JSON.parse(source);
    return isJsonObject(floor) ? floor : undefined;
  } catch {
    // `verify-floor-skips` reports a floor it cannot read.
    return undefined;
  }
}

export const codemod: Codemod = {
  id: 'e2e-suite-floor',
  since: '31.47.1',
  summary: `an ${VERIFY_FLOOR_FILE} requiring e2e gains a suite for a page the app serves, or excuses the step where no page can be visited`,
  async run(app) {
    const source = await app.read(VERIFY_FLOOR_FILE);
    const floor = source === undefined ? undefined : parsed(source);
    const steps = floor?.['steps'];
    if (floor === undefined || !Array.isArray(steps) || !steps.includes('e2e')) return NOTHING;
    if (isJsonObject(floor['skip']) && 'e2e' in floor['skip']) return NOTHING;
    const plan = await e2eSuitePlan(app);
    if (plan.kind !== 'none') return writeE2eSuite(app, plan);
    const next = withSkip(
      { ...floor, steps: steps.filter((step) => step !== 'e2e') },
      { e2e: e2eExcuse(plan) },
    );
    await app.write(VERIFY_FLOOR_FILE, renderFloor(next));
    return { changed: [VERIFY_FLOOR_FILE], skipped: [] };
  },
};
