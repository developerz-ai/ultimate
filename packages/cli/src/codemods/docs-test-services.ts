// 31.27.0: the app's CLAUDE.md and README.md say what the live and e2e suites run on, and that
// `bun run verify` starts the test services itself. Prose the app may have reworded: each edit
// lands where the text stands as `x new` wrote it, and is skipped silently where it does not.

import type { Codemod } from './codemod';
import type { SnippetEdit } from './engine-edits';
import { editSnippets, mergeResults } from './engine-edits';

const lines = (...text: readonly string[]): string => text.join('\n');

export const DOCS_TEST_SERVICES_EDITS: Readonly<Record<string, readonly SnippetEdit[]>> = {
  'CLAUDE.md': [
    {
      from: lines(
        'Every test the scaffold and the generators write is the idiom to copy. All of them run on the',
        '`unit` step — in process, on the in-memory driver, with no database, browser or server.',
        '',
        'A suite that needs a real server reads it from `docker/test-services.env`: Postgres 18, Redis, NATS',
        'and S3 from `docker/docker-compose.test.yml`, in RAM, with durability and logging off — CI starts',
        'it before `bun run verify`, a laptop with `docker compose -f docker/docker-compose.test.yml up -d',
        '--wait` then `set -a; . docker/test-services.env; set +a`. A resource a test opens is held with',
      ),
      to: lines(
        'Every test the scaffold and the generators write is the idiom to copy. A `*.live.test.ts` runs',
        'on a real Postgres, a `*.e2e.test.ts` in a real browser; the rest on `unit`, in memory.',
        '',
        'A suite that needs a real server reads it from `docker/test-services.env`: Postgres 18, Redis, NATS',
        'and S3 from `docker/docker-compose.test.yml`, in RAM, with durability and logging off.',
        '`bun run verify` starts it itself when nothing answers at `TEST_DATABASE_URL` and Docker is',
        'there; by hand it is `docker compose -f docker/docker-compose.test.yml up -d --wait` then',
        '`set -a; . docker/test-services.env; set +a`. A resource a test opens is held with',
      ),
      optional: true,
    },
  ],
  'README.md': [
    {
      from: lines(
        'Tests against real servers — Postgres 18, Redis, NATS, S3, in RAM and silent, as CI runs them:',
      ),
      to: lines(
        'Tests against real servers — Postgres 18, Redis, NATS, S3, in RAM and silent, as CI runs them.',
        '`bun run verify` starts them when nothing answers and Docker is there; by hand:',
      ),
      optional: true,
    },
  ],
};

export const codemod: Codemod = {
  id: 'docs-test-services',
  since: '31.27.0',
  summary:
    'CLAUDE.md and README.md: the live and e2e suites, and the test services verify starts itself',
  async run(app) {
    const results = [];
    for (const [path, edits] of Object.entries(DOCS_TEST_SERVICES_EDITS)) {
      results.push(await editSnippets(app, path, edits));
    }
    return mergeResults(results);
  },
};
