// `x dev` pins one build id at boot for `x-ultimate-build`; core must hold the same one, so
// `ctx.buildId` and the health report never name a second (`serve-boot-build-id.test.ts` is the
// container's half). The fixture stamps `BUILD_ID: 'stamped-7'`.

import { describe, expect, test } from 'bun:test';
import { BUILD_ID_HEADER, ctxOf, healthReport } from '@ultimat3/core';
import { bootDevFixture } from './cmd-dev-boot-fixture';

const dev = bootDevFixture('.dev-boot-build-id-fixture');

describe('unit · x dev installs the build id it pinned', () => {
  test('the header, the health report and ctx.buildId are one id', async () => {
    const response = await dev.fetchDev('/healthz');
    expect(response.headers.get(BUILD_ID_HEADER)).toBe('stamped-7');
    expect(healthReport().buildId).toBe('stamped-7');
    expect(ctxOf().buildId).toBe('stamped-7');
  });
});
