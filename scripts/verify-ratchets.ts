// The pin ratchets the `errors` step runs, so `bun run scripts/<n>.ts` and the gate give one
// verdict. `finite-bounds` was red on main over five sites with every gate step green: its CLI
// existed and nothing the gate runs called it. `verify-ratchets.test.ts` holds every
// `scripts/lib/*-pins.ts` to being reached from here, from another host check, or exempted.

import type { HostCheck } from '@ultimat3/cli';
import { claudeMdFindings } from './claude-md-size';
import { configReaderFindings } from './config-readers';
import { fetchFindingFor, fetchGaps } from './fetch-deadline';
import { finiteBoundFindings } from './finite-bounds';
import { GATED_APPS } from './lib/gated-apps';
import { logLevelFindingFor, logLevelGaps } from './log-levels';
import { nodeImportFindings } from './node-imports';
import { protoIndexFindings } from './proto-index';
import { secretCompareFindings } from './secret-compare';
import { sourceHeaderFindings } from './source-headers';
import { spawnFindingFor, spawnGaps } from './spawn-timeout';

/** Every tracked app is in this tree: what config-readers' app half reads. */
const tracked = async (root: string): Promise<boolean> =>
  (
    await Promise.all(GATED_APPS.map((app) => Bun.file(`${root}/${app.dir}/package.json`).exists()))
  ).every(Boolean);

/** The scripts below, by path: what the wiring test reads them as. */
export const RATCHET_SCRIPTS = [
  'scripts/claude-md-size.ts',
  'scripts/config-readers.ts',
  'scripts/fetch-deadline.ts',
  'scripts/finite-bounds.ts',
  'scripts/log-levels.ts',
  'scripts/node-imports.ts',
  'scripts/proto-index.ts',
  'scripts/secret-compare.ts',
  'scripts/source-headers.ts',
  'scripts/spawn-timeout.ts',
] as const;

/** One check per script above, in the same order; each is that script's own `--json` findings. */
export const RATCHET_CHECKS: readonly HostCheck[] = [
  (root) => claudeMdFindings(root),
  // Its app half reads the tracked apps: a root without them (a fixture) is unscanned, never clean.
  async (root) =>
    (await tracked(root))
      ? configReaderFindings(root)
      : [
          {
            code: 'X_CORPUS_UNSCANNED',
            cause: `${root} holds no tracked app, so config-readers could not read the app half of its pins`,
            fix: 'bun run scripts/config-readers.ts --json   # from the repository root, where the tracked apps are',
          },
        ],
  async (root) => (await fetchGaps(root)).map(fetchFindingFor),
  finiteBoundFindings,
  async (root) => (await logLevelGaps(root)).map(logLevelFindingFor),
  nodeImportFindings,
  protoIndexFindings,
  secretCompareFindings,
  sourceHeaderFindings,
  async (root) => (await spawnGaps(root)).map(spawnFindingFor),
];
