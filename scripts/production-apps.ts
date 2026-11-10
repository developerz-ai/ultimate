#!/usr/bin/env bun
// Enforce, on `x verify`'s `manifest` step, that "who uses it" is ONE claim: `PRODUCTION_APPS`,
// rendered into a generated block on each page that answers it. README said "no production use"
// while `wiki/FAQ.md` answered "Yes" to production-ready; two hand-copies of one fact disagreed.
//
//   bun run scripts/production-apps.ts [--write] [--json]

import { flagBool, parseScriptArgs } from './lib/args';
import { fillGenerated, readGenerated } from './lib/generated-block';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { ScriptError } from './lib/script-error';

const SCRIPT = 'production-apps';
const BLOCK = 'production-apps';
const CODE = 'X_PRODUCTION_APPS_DRIFT';
export const PRODUCTION_APPS_FIX = 'bun run scripts/production-apps.ts --write';

export interface ProductionApps {
  /** Apps outside this repository built on the framework. */
  readonly count: number;
  /** Of those, how many serve production traffic, as far as can be shown. A floor, never a guess. */
  readonly deployed: number;
  /** Vague on purpose: an exact size, with the count, narrows an adopter down to a name. */
  readonly sizes: string;
  /** `YYYY-MM` the owner last restated it. */
  readonly asOf: string;
}

/**
 * Owner-reported, and the one claim on these pages no command can re-derive: adopters are NEVER
 * named in this tree (`scripts/private-names.ts` refuses a name), so their repositories cannot be
 * cited. `count` is the adopters the v31 plan upgrades one by one
 * (`docs/plans/2026/11/09/101-final-hardening-before-v31/`, slices 40–48); `deployed` is the ones
 * that plan read production logs from. Raise either only on the owner's word.
 */
export const PRODUCTION_APPS: ProductionApps = {
  count: 9,
  deployed: 1,
  sizes: 'small to medium',
  asOf: '2026-11',
};

/** Every page that answers "who uses it". A new one joins this list, never restates the claim. */
export const PRODUCTION_APPS_FILES: readonly string[] = [
  'README.md',
  'wiki/FAQ.md',
  'wiki/Compared.md',
];

/** One sentence, link-free: the same text reads right on GitHub, in the wiki and on the docs site. */
export function renderProductionApps(apps: ProductionApps): readonly string[] {
  if (apps.deployed > apps.count) {
    throw new ScriptError({
      code: CODE,
      cause: `PRODUCTION_APPS says ${apps.deployed} deployed of ${apps.count} apps, more than exist`,
      fix: "grep -n 'deployed:' scripts/production-apps.ts   # set PRODUCTION_APPS.deployed to at most its count",
    });
  }
  return [
    `${apps.count} apps outside this repository build on Ultimate, ${apps.sizes} in size; at least ${apps.deployed} of them ${apps.deployed === 1 ? 'serves' : 'serve'} production traffic. Owner-reported, \`As of ${apps.asOf}\`: adopters are never named (\`scripts/private-names.ts\` refuses a name in the tree), so no command here re-derives this line.`,
  ];
}

/** Drift on one page: the block is missing, or is not what `PRODUCTION_APPS` renders. */
export function checkProductionApps(
  file: string,
  markdown: string,
  apps: ProductionApps,
): readonly Finding[] {
  const body = readGenerated(markdown, BLOCK, PRODUCTION_APPS_FIX);
  if (body === undefined) {
    return [
      {
        code: CODE,
        cause: `${file} answers who uses Ultimate and has no generated production-apps block, so its answer is a hand-copy nothing checks`,
        fix: `grep -n -i 'who uses|production' ${file}   # where the claim belongs put the lines "<!-- generated: ${BLOCK} — ${PRODUCTION_APPS_FIX} -->" and "<!-- end generated -->", then: ${PRODUCTION_APPS_FIX}`,
        at: file,
      },
    ];
  }
  if (body.join('\n') === renderProductionApps(apps).join('\n')) return [];
  return [
    {
      code: CODE,
      cause: `${file}'s production-apps block is not what PRODUCTION_APPS in scripts/production-apps.ts renders: edited by hand, or the constant moved`,
      fix: PRODUCTION_APPS_FIX,
      at: file,
    },
  ];
}

/** The page with its block rewritten; a page with no block is returned as it was. */
export const writeProductionApps = (markdown: string, apps: ProductionApps): string =>
  fillGenerated(markdown, BLOCK, PRODUCTION_APPS_FIX, renderProductionApps(apps)) ?? markdown;

/** A root missing one of the pages is a fixture tree: only the pages present are held. */
export async function productionAppsFindings(root: string): Promise<readonly Finding[]> {
  const findings: Finding[] = [];
  for (const file of PRODUCTION_APPS_FILES) {
    const handle = Bun.file(`${root}/${file}`);
    if (!(await handle.exists())) continue;
    findings.push(...checkProductionApps(file, await handle.text(), PRODUCTION_APPS));
  }
  return findings;
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  if (flagBool(args, 'write')) {
    for (const file of PRODUCTION_APPS_FILES) {
      const handle = Bun.file(`${root}/${file}`);
      await Bun.write(handle, writeProductionApps(await handle.text(), PRODUCTION_APPS));
    }
  }
  const findings = await productionAppsFindings(root);
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? `${PRODUCTION_APPS_FILES.length} pages state PRODUCTION_APPS as rendered`
          : `${findings.length} page(s) differ from PRODUCTION_APPS`,
      findings,
    },
    args.json,
  );
}
