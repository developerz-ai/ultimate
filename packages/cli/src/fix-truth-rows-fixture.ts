// The rows `fix-truth*.test.ts` run: each breaks the scaffold, names the code it must refuse with,
// and says what running the printed line must leave true. Shared so the rows split across files,
// each over its own `fixtureApp()`, and test workers run them side by side.

import { expect } from 'bun:test';
// why: Bun ships no path joiner.
import { join } from 'node:path';
import { exec } from './exec';
import type { FixtureApp } from './fix-truth-fixture';
import type { Finding } from './output';
import { VERIFY_STEPS } from './verify-checks';
import type { VerifyStepName } from './verify-step';

/** A real scaffold, real biome, real child `x` processes: one row's ceiling. */
export const ROW_MS = 60_000;

interface Report {
  readonly steps?: readonly { readonly findings: readonly Finding[] }[];
  readonly findings?: readonly Finding[];
}

export interface Row {
  readonly name: string;
  readonly code: string;
  /** Applies the break, and returns the finding that says so. */
  readonly refuse: () => Promise<Finding | undefined>;
  /** What running the printed line must leave true. */
  readonly holds: (fix: string) => Promise<void>;
  /** A fix that names an edit: the edit, made as the line says. Absent: the line is executed. */
  readonly perform?: (fix: string) => Promise<void>;
}

export interface FixTruthRows {
  /** FX1, the costly row (two compiles and a barrel walk): a file of its own. */
  readonly barrel: readonly Row[];
  /** Every other row. */
  readonly rest: readonly Row[];
  /** Applies the break, runs the printed line (or the row's edit) and checks it held; resets. */
  run(row: Row): Promise<void>;
  /** `contents` at `path` in the app. */
  write(path: string, contents: string): Promise<number>;
}

/** The rows over `app`, read when a row runs: the app is built in the file's `beforeAll`. */
export function fixTruthRows(app: () => FixtureApp): FixTruthRows {
  /** Every finding a `--json` command reported, wherever it put them. */
  const findingsOf = (stdout: string): readonly Finding[] => {
    const report = JSON.parse(stdout) as Report;
    return [...(report.findings ?? []), ...(report.steps ?? []).flatMap((step) => step.findings)];
  };

  /** One gate step in process: the row is about what it reports, and a child `x` is seconds per call. */
  const verifyStep = async (name: VerifyStepName): Promise<readonly Finding[]> => {
    const step = VERIFY_STEPS.find((one) => one.name === name);
    if (step === undefined) return expect.unreachable(`no step ${name}`);
    const outcome = await step.run({ root: app().root, runner: exec, env: {} } as never);
    return outcome.findings;
  };

  /** What the app load reports, in a child: the registries and the resolver are per process. */
  const loadFindings = async (): Promise<readonly Finding[]> => {
    const loader = join(import.meta.dir, 'app-load.ts');
    await Bun.write(
      join(app().root, '.shims/load.ts'),
      `import { setLogStream } from '@ultimat3/core';
import { loadApp } from ${JSON.stringify(loader)};
setLogStream('stderr');
await Bun.write(Bun.stdout, JSON.stringify((await loadApp(process.cwd())).findings));`,
    );
    const { stdout, stderr } = await app().sh('bun .shims/load.ts');
    if (stdout === '') return expect.unreachable(`the load crashed: ${stderr}`);
    return JSON.parse(stdout) as readonly Finding[];
  };

  const write = (path: string, contents: string): Promise<number> =>
    Bun.write(join(app().root, path), contents);

  const POST = 'apps/web/app/post';

  const ISLAND = `${POST}/post-form.island.tsx`;
  /** FX1's mistake: an island reading the slice's repository, by value, as an agent writes it. */
  const REPO_IN_ISLAND = "import { list } from './repo';\nexport const listed = list;\n";

  /**
   * A barrel fix, made the way its line says, until `boundaries` stops reporting one. The two shapes
   * a printed fix has taken: swap a specifier at `file:line`, or delete the import at `file:line`
   * (and the one use this row planted — "every use of what it binds").
   */
  const followBarrelFixes = async (first: string): Promise<void> => {
    let fix: string | undefined = first;
    for (let round = 0; fix !== undefined && round < 6; round += 1) {
      const swap = /(?:import at|edit) (\S+):(\d+)\b.*?from '([^']+)' to '([^']+)'/.exec(fix);
      const cut = /^edit (\S+):(\d+) — delete the import of '([^']+)'/.exec(fix);
      const [, file = '', at = '0'] = swap ?? cut ?? expect.unreachable(`no edit in: ${fix}`);
      const path = join(app().root, file);
      const lines = (await Bun.file(path).text()).split('\n');
      const index = Number(at) - 1;
      if (swap !== null) {
        lines[index] = (lines[index] ?? '').replace(`'${swap[3]}'`, `'${swap[4]}'`);
      } else {
        expect(lines[index]).toContain(`'${cut?.[3]}'`);
        lines.splice(index, 1);
      }
      await Bun.write(
        path,
        lines.filter((line) => line !== 'export const listed = list;').join('\n'),
      );
      const left = await verifyStep('boundaries');
      fix = left.find((one) => one.code === 'X_BROWSER_SERVER_BARREL')?.fix;
    }
  };

  const rows: readonly Row[] = [
    {
      name: 'FX1 an island importing a repository is cut at the island, and the tree still builds',
      code: 'X_BROWSER_SERVER_BARREL',
      refuse: async () => {
        const source = await Bun.file(join(app().root, ISLAND)).text();
        await write(
          ISLAND,
          source.replace(/^import styles .*$/m, (line) => `${line}\n${REPO_IN_ISLAND}`),
        );
        expect(await app().typeErrors()).toEqual([]);
        const found = await verifyStep('boundaries');
        const barrels = found.filter((one) => one.code === 'X_BROWSER_SERVER_BARREL');
        // One edge, one finding — and it is the island's, never a generated file it reached.
        expect(barrels.map((one) => one.at?.split(':')[0])).toEqual([ISLAND]);
        return barrels[0];
      },
      perform: followBarrelFixes,
      holds: async () => {
        expect(await verifyStep('boundaries')).toEqual([]);
        expect(await app().typeErrors()).toEqual([]);
      },
    },
    {
      name: 'D1b a format miss is told --write on the file',
      code: 'X_LINT_FAILED',
      refuse: async () => {
        await write(`${POST}/truth.ts`, 'export const used   =   2\n');
        return (await verifyStep('lint'))[0];
      },
      holds: async () => {
        expect(await verifyStep('lint')).toEqual([]);
      },
    },
    {
      name: 'D1b an unused variable is an edit naming the line, never --write',
      code: 'X_LINT_FAILED',
      refuse: async () => {
        await write(`${POST}/truth.ts`, 'const unused = 1;\nexport const used = 2;\n');
        return (await verifyStep('lint')).find((one) => one.at === `${POST}/truth.ts`);
      },
      perform: async (fix) => {
        expect(fix).not.toContain('--write');
        expect(fix).toContain(`edit ${POST}/truth.ts:1`);
        await write(`${POST}/truth.ts`, 'export const used = 2;\n');
      },
      holds: async () => {
        expect(await verifyStep('lint')).toEqual([]);
      },
    },
    {
      name: 'D3 a typoed --feature writes into the slice it meant',
      code: 'X_FEATURE_UNKNOWN',
      refuse: async () =>
        findingsOf((await app().sh('x g action shipPost --feature pst --json')).stdout)[0],
      holds: async () => {
        expect(await Bun.file(join(app().root, `${POST}/actions/ship-post.ts`)).exists()).toBe(
          true,
        );
        expect(await Bun.file(join(app().root, 'apps/web/app/pst/entity.ts')).exists()).toBe(false);
      },
    },
    {
      name: 'D4 a route reading a repo gets a query in that slice, and no table',
      code: 'X_BOUNDARY_ROUTE_TO_DB',
      refuse: async () => {
        await write(
          'apps/web/app/shoplist/page.tsx',
          "import { list } from '../post/repo';\nexport const Page = () => String(list);\n",
        );
        const found = await verifyStep('boundaries');
        return found.find((one) => one.code === 'X_BOUNDARY_ROUTE_TO_DB');
      },
      holds: async () => {
        expect(await Bun.file(join(app().root, `${POST}/queries/shoplist.ts`)).exists()).toBe(true);
        const { stdout } = await app().sh('git status --short --untracked-files=all');
        expect(stdout).not.toContain('shoplist/entity.ts');
        expect(stdout).not.toContain('shoplists');
      },
    },
    {
      name: 'D6 a relative import that resolves to nothing names the file, and the edit clears it',
      code: 'X_APP_IMPORT_UNRESOLVED',
      refuse: async () => {
        await write(`${POST}/truth.ts`, "export { x } from '../nowhere/repo';\n");
        return (await loadFindings()).find((one) => one.code === 'X_APP_IMPORT_UNRESOLVED');
      },
      perform: async (fix) => {
        const shown = await app().sh(fix);
        expect(shown.stdout).toContain('../nowhere/repo');
        await write(`${POST}/truth.ts`, 'export const x = 1;\n');
      },
      holds: async () => {
        expect(await loadFindings()).toEqual([]);
      },
    },
    {
      name: 'D12a a $view key naming no column is an edit, with the columns on its line',
      code: 'X_INVARIANT_VIOLATED',
      refuse: async () => {
        await write(
          `${POST}/truth.ts`,
          "import { post } from './entity';\nexport const v = (post.$view as (k: string[]) => unknown)(['titel']);\n",
        );
        return (await loadFindings()).find((one) => one.code === 'X_INVARIANT_VIOLATED');
      },
      perform: async (fix) => {
        expect(fix).not.toContain('x entities show');
        const pick = /pick from: (\w+)/.exec(fix)?.[1];
        await write(
          `${POST}/truth.ts`,
          `import { post } from './entity';\nexport const v = (post.$view as (k: string[]) => unknown)(['${String(pick)}']);\n`,
        );
      },
      holds: async () => {
        expect(await loadFindings()).toEqual([]);
      },
    },
  ];

  const run = async (row: Row): Promise<void> => {
    try {
      const finding = await row.refuse();
      expect(finding?.code).toBe(row.code);
      const fix = finding?.fix ?? '';
      if (row.perform === undefined) {
        const ran = await app().sh(fix);
        expect({ fix, code: ran.code, stderr: ran.stderr }).toEqual({
          fix,
          code: 0,
          stderr: expect.any(String),
        });
      } else {
        await row.perform(fix);
      }
      await row.holds(fix);
    } finally {
      await app().reset();
    }
  };

  return {
    barrel: rows.filter((row) => row.code === 'X_BROWSER_SERVER_BARREL'),
    rest: rows.filter((row) => row.code !== 'X_BROWSER_SERVER_BARREL'),
    run,
    write,
  };
}
