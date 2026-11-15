// The two suites every scaffold ships for what a unit test cannot answer: the production driver
// against a real Postgres (`live`), and the landing page in a real browser (`e2e`). With both, a
// fresh app's gate runs its `live` and `e2e` steps from the first commit, example slice or not.

import type { GeneratedFile } from './naming';

/** Where the live suite lands: beside the handle it vouches for. */
export const LIVE_SUITE_PATH = 'packages/db/src/client.live.test.ts';

/** Where the e2e suite lands: beside the page it drives (a shape that drops the page drops it). */
export const E2E_SUITE_PATH = 'apps/web/site/page.e2e.test.ts';

const liveSuite =
  (): string => `// The production driver against a real Postgres — the half the embedded database cannot vouch for.
// A \`uuid[]\`, a \`timestamptz\`, a \`jsonb\` and a \`bigint\` decoded over the wire, so a decode that
// differs from PGlite's is red here and not on the first deploy. \`needs\` skips it, naming the
// command that starts the database, when TEST_DATABASE_URL is unset.
import { postgresClient, sql } from '@ultimat3/db';
import { expect, liveTest } from '@ultimat3/testing';

const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];

interface Decoded {
  readonly ids: readonly string[];
  readonly at: Date;
  readonly doc: { readonly n: number };
  readonly big: string;
}

liveTest(
  'the production driver decodes what the app stores',
  async () => {
    const { TEST_DATABASE_URL: url } = Bun.env;
    const client = postgresClient({ url });
    try {
      const [row] = await client.query<Decoded>(
        sql\`select \${ids}::uuid[] as ids, '2026-01-01T00:00:00Z'::timestamptz as at, '{"n":1}'::jsonb as doc, 9007199254740993::bigint as big\`,
      );
      expect(row?.ids).toEqual(ids);
      expect(row?.at.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(row?.doc).toEqual({ n: 1 });
      // Past 2^53: a bigint that came back as a number would have lost its last digit.
      expect(row?.big).toBe('9007199254740993');
    } finally {
      await client.close();
    }
  },
  { needs: ['postgres'] },
);
`;

const e2eSuite =
  (): string => `// The landing page in a real browser, against the BUILT output — what \`renderRoute\` in
// page.test.ts cannot see: the document a browser parses and the title its tab shows. Its own file
// because the gate types a test by its FILENAME — an e2eTest in page.test.ts is a unit test.
import { e2eTest, expect } from '@ultimat3/testing';

e2eTest('/ loads in a browser and names itself', async ({ page }) => {
  await page.goto('/');
  expect(await page.title()).not.toBe('');
});
`;

/** The live suite, in the db package every scaffold writes. */
export const liveSuiteFiles = (): readonly GeneratedFile[] => [
  { path: LIVE_SUITE_PATH, contents: liveSuite() },
];

/** The e2e suite, beside the landing page. */
export const e2eSuiteFiles = (): readonly GeneratedFile[] => [
  { path: E2E_SUITE_PATH, contents: e2eSuite() },
];
