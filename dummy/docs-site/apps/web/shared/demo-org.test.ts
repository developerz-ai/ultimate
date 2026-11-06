// The dev actor, the seed and the dashboard all read DEMO_ORG_ID. If it stops being the uuid the
// seed's `id()` derives, a generated tenant policy denies the dev actor again.
import { seedId } from '@ultimat3/entity';
import { expect, unitTest } from '@ultimat3/testing';
import { DEMO_ORG_ID, DEMO_ORG_LABEL } from './demo-org';

const UUID_V5 = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

unitTest('the demo org is the uuid the seed writes', () => {
  expect(DEMO_ORG_ID).toBe(seedId(DEMO_ORG_LABEL));
  expect(DEMO_ORG_ID).toMatch(UUID_V5);
});
