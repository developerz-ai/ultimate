#!/usr/bin/env bun
// The supported-runtime table on `wiki/Stability.md`, generated: every row is a runtime something
// RUNS — the gate's three pins and each `compat.yml` cell — so the range the page promises is the
// range that is tested. Drift is refused by `compat-table.test.ts` in the gate's `unit` step.
//
//   bun run scripts/compat-table.ts [--write] [--check] [--json]

import type { CompatAxis, CompatCell, CompatMatrix } from './compat-cells';
import { COMPAT_AXES, COMPAT_WORKFLOW, loadCompatMatrix } from './compat-cells';
import { flagBool, parseScriptArgs } from './lib/args';
import {
  fillGenerated,
  GENERATED_CLOSE,
  generatedOpen,
  readGenerated,
} from './lib/generated-block';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { ScriptError } from './lib/script-error';

export const STABILITY_PAGE = 'wiki/Stability.md';
const BLOCK = 'compat-table';
const CODE = 'X_COMPAT_TABLE_DRIFT';
export const COMPAT_TABLE_FIX = 'bun run scripts/compat-table.ts --write';
const COMPOSE = 'docker/docker-compose.test.yml';

/** The version of each axis the gate itself runs, read off the file that pins it. */
export type Pins = Readonly<Record<CompatAxis, string>>;

const NAMES: Readonly<Record<CompatAxis, string>> = {
  bun: 'Bun',
  postgres: 'Postgres',
  solid: 'Solid',
};
const PIN_FILES: Readonly<Record<CompatAxis, string>> = {
  bun: '.bun-version',
  postgres: COMPOSE,
  solid: 'root `package.json`',
};

const pinUnreadable = (what: string, fix: string): ScriptError =>
  new ScriptError({ code: CODE, cause: `the gate's ${what} pin could not be read`, fix });

export async function readPins(root: string): Promise<Pins> {
  const bun = (await Bun.file(`${root}/.bun-version`).text()).trim();
  const compose = Bun.YAML.parse(await Bun.file(`${root}/${COMPOSE}`).text()) as {
    readonly services?: { readonly postgres?: { readonly image?: unknown } };
  };
  const image = compose.services?.postgres?.image;
  const postgres = /:(?:pg)?(\d+)/.exec(typeof image === 'string' ? image : '')?.[1];
  const manifest = (await Bun.file(`${root}/package.json`).json()) as {
    readonly devDependencies?: Readonly<Record<string, unknown>>;
  };
  const solid = manifest.devDependencies?.['solid-js'];
  if (postgres === undefined) {
    throw pinUnreadable('Postgres', `grep -n 'image: pgvector' ${COMPOSE}   # tag it pg<major>`);
  }
  if (typeof solid !== 'string' || !/^\d+\.\d+\.\d+$/.test(solid)) {
    throw pinUnreadable('Solid', 'bun add --dev --exact solid-js@1   # at the repo root');
  }
  return { bun, postgres, solid };
}

const versionOf = (cell: CompatCell): string => {
  if (cell.axis === 'bun') return cell.version === 'latest' ? 'newest stable' : cell.version;
  return cell.axis === 'postgres'
    ? `newest \`${cell.version}.x\` image`
    : `newest \`${cell.version}.x\``;
};

const statusOf = (cell: CompatCell): string =>
  cell.support === 'supported' ? 'supported' : 'watched: tested, never promised';

/** Each axis in order: the pin the gate runs, then each compat cell in the workflow's order. */
export function renderCompatTable(matrix: CompatMatrix, pins: Pins): readonly string[] {
  const rows = COMPAT_AXES.flatMap((axis) => [
    `| ${NAMES[axis]} | \`${pins[axis]}\`, the pin (${PIN_FILES[axis].startsWith('root') ? PIN_FILES[axis] : `\`${PIN_FILES[axis]}\``}) | the gate, every push and pull request (\`ci.yml\`) | supported |`,
    ...matrix.cells
      .filter((cell) => cell.axis === axis)
      .map(
        (cell) =>
          `| ${NAMES[axis]} | ${versionOf(cell)} | \`compat.yml\` cell \`${cell.id}\`, weekly | ${statusOf(cell)} |`,
      ),
  ]);
  return ['| Runtime | Version | Run by | Status |', '|---|---|---|---|', ...rows];
}

export function checkCompatTable(
  markdown: string,
  matrix: CompatMatrix,
  pins: Pins,
): readonly Finding[] {
  const body = readGenerated(markdown, BLOCK, COMPAT_TABLE_FIX);
  if (body === undefined) {
    return [
      {
        code: CODE,
        cause: `${STABILITY_PAGE} has no generated compat-table block, so its supported range is a hand-copy nothing checks`,
        fix: `grep -n '## The support window' ${STABILITY_PAGE}   # above it put the lines "${generatedOpen(BLOCK, COMPAT_TABLE_FIX)}" and "${GENERATED_CLOSE}", then: ${COMPAT_TABLE_FIX}`,
        at: STABILITY_PAGE,
      },
    ];
  }
  if (body.join('\n') === renderCompatTable(matrix, pins).join('\n')) return [];
  return [
    {
      code: CODE,
      cause: `${STABILITY_PAGE}'s compat table is not what ${COMPAT_WORKFLOW}'s matrix and the gate's pins render: edited by hand, or a cell or pin moved`,
      fix: COMPAT_TABLE_FIX,
      at: STABILITY_PAGE,
    },
  ];
}

/** The page with its block rewritten; a page with no block is returned as it was. */
export const writeCompatTable = (markdown: string, matrix: CompatMatrix, pins: Pins): string =>
  fillGenerated(markdown, BLOCK, COMPAT_TABLE_FIX, renderCompatTable(matrix, pins)) ?? markdown;

export async function compatTableFindings(root: string): Promise<readonly Finding[]> {
  const page = await Bun.file(`${root}/${STABILITY_PAGE}`).text();
  return checkCompatTable(page, await loadCompatMatrix(root), await readPins(root));
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  try {
    if (flagBool(args, 'write')) {
      const page = Bun.file(`${root}/${STABILITY_PAGE}`);
      const written = writeCompatTable(
        await page.text(),
        await loadCompatMatrix(root),
        await readPins(root),
      );
      await Bun.write(page, written);
    }
    // `--check` is what a run without `--write` does; read so a value handed to it is refused.
    flagBool(args, 'check');
    const findings = await compatTableFindings(root);
    report(
      {
        ok: findings.length === 0,
        script: 'compat-table',
        summary:
          findings.length === 0
            ? `${STABILITY_PAGE} prints the table ${COMPAT_WORKFLOW} renders`
            : `${STABILITY_PAGE}'s compat table has drifted`,
        findings,
      },
      args.json,
    );
  } catch (cause) {
    if (!(cause instanceof ScriptError)) throw cause;
    report(
      { ok: false, script: 'compat-table', summary: 'refused', findings: [cause.toFinding()] },
      args.json,
    );
  }
}
