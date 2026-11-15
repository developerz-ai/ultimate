// The landing page in a real browser, against the BUILT output — what `renderRoute` in
// page.test.ts cannot see: the document a browser parses and the title its tab shows. Its own file
// because the gate types a test by its FILENAME — an e2eTest in page.test.ts is a unit test.
import { e2eTest, expect } from '@ultimat3/testing';

e2eTest('/ loads in a browser and names itself', async ({ page }) => {
  await page.goto('/');
  expect(await page.title()).not.toBe('');
});
