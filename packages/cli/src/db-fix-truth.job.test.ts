// The whole D2 sequence, for real: a scaffold, a generated migration, an edit to its `up`, and the
// `x db gen` the old fix named. That wrote the edit into the schema dump with `drift` green, since
// the dump is what the migrations produce. Now it ends red at `drift`, and the printed line ends it.

import { afterAll, beforeAll, expect, test } from 'bun:test';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import { type FixtureApp, fixtureApp, GIT } from './fix-truth-fixture';
import { MIGRATIONS_DIR } from './migrations';
import type { Finding } from './output';

// A WASM compile, an initdb and a replay per `x db gen` and per `drift`. A hang detector.
const SEQUENCE_MS = 180_000;

let app: FixtureApp;

beforeAll(async () => {
  app = await fixtureApp();
}, SEQUENCE_MS);

afterAll(() => app.remove());

const driftFindings = async (): Promise<readonly Finding[]> => {
  const { stdout } = await app.sh('x verify --only drift --json');
  const report = JSON.parse(stdout) as { steps: readonly { findings: readonly Finding[] }[] };
  return report.steps.flatMap((step) => step.findings);
};

test(
  'an edited migration, then the old fix: red at drift until the printed line restores it',
  async () => {
    const generated = await app.sh('x db gen "initial" --json');
    expect({ code: generated.code, out: generated.stdout }).toEqual({
      code: 0,
      out: expect.any(String),
    });
    await app.sh(`${GIT} add -A && ${GIT} commit -qm initial`);
    expect(await driftFindings()).toEqual([]);

    const dir = join(app.root, MIGRATIONS_DIR);
    const [file] = await Array.fromAsync(new Bun.Glob('*.sql').scan({ cwd: dir }));
    const up = await Bun.file(join(dir, file ?? '')).text();
    const edited = up.replace(/create table\s+"posts"\s*\(/, (open) => `${open}\n  "hacked" text,`);
    expect(edited).not.toBe(up);
    await Bun.write(join(dir, file ?? ''), edited);

    // Exit 0, and the column is now in the dump: the fix this code used to print.
    expect((await app.sh('x db gen "fix initial" --json')).code).toBe(0);
    const dumped = await Bun.file(join(app.root, 'packages/db/schema/04_tables/posts.sql')).text();
    expect(dumped).toContain('"hacked"');

    const findings = await driftFindings();
    const refusal = findings.find((finding) => finding.code === 'X_DB_DRIFT');
    expect(refusal?.cause).toContain('"hacked"');

    expect((await app.sh(refusal?.fix ?? '')).code).toBe(0);
    expect(await driftFindings()).toEqual([]);
  },
  SEQUENCE_MS,
);
