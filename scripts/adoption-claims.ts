#!/usr/bin/env bun
// Enforce, on `x verify`'s `manifest` step, that a published page says who uses Ultimate ONLY
// through the generated production-apps block (`scripts/production-apps.ts`). README said "no
// production use" while the FAQ said "Yes": a hand-written claim about adopters drifts from the one
// constant, so any other sentence claiming production use or adopters is refused.
//
//   bun run scripts/adoption-claims.ts [--json]

import { renderFixShellArg } from '@ultimat3/core';
import { parseScriptArgs } from './lib/args';
import type { MarkdownFile } from './lib/doc-citations';
import { readMarkdown } from './lib/doc-citations';
import { GENERATED_CLOSE, generatedOpen } from './lib/generated-block';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { PRODUCTION_APPS_FIX } from './production-apps';

const SCRIPT = 'adoption-claims';
const CODE = 'X_ADOPTION_CLAIM_UNGENERATED';

/** Every page a stranger or an agent reads; records (`docs/plans`, `docs/history`, CHANGELOG) stand. */
export const ADOPTION_GLOBS: readonly string[] = [
  '*.md',
  'llms.txt',
  'wiki/**/*.md',
  'docs/**/*.md',
  'packages/*/*.md',
  'examples/*/README.md',
  'dummy/*/README.md',
];

export const skipAdoptionPath = (path: string): boolean =>
  path === 'CHANGELOG.md' ||
  path.startsWith('docs/changelog/') ||
  path.startsWith('docs/plans/') ||
  path.startsWith('docs/history/');

/**
 * The phrasings of a who-uses-it claim, each narrow enough that ordinary production prose ("in
 * production the boot refuses…", "an adopter re-implementing…") is not one. A new phrasing that
 * slips past is added here with the sentence that used it.
 */
const CLAIMS: readonly RegExp[] = [
  /\bproduction use\b/i,
  /\bused in production\b/i,
  /\b(?:outside|external|production|real-world)\s+adopters?\b/i,
  /\bno\s+adopters?\b/i,
  /\bserves?\s+production\s+traffic\b/i,
  /\bapps?\s+(?:outside|beyond)\s+this\s+repo(?:sitory)?\b/i,
  /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|several|many|dozens of)\s+(?:apps|companies|teams|organisations|organizations|projects)\s+(?:use|run|build on|are built on|in production)\b/i,
];

const BLOCK_OPEN = generatedOpen('production-apps', PRODUCTION_APPS_FIX);

/** Each line claiming adoption outside the generated block, as a finding at `path:line`. */
export function scanAdoptionClaims(file: MarkdownFile): readonly Finding[] {
  const findings: Finding[] = [];
  let inBlock = false;
  for (const [index, line] of file.text.split('\n').entries()) {
    if (line === BLOCK_OPEN) inBlock = true;
    else if (inBlock && line === GENERATED_CLOSE) inBlock = false;
    else if (!inBlock && CLAIMS.some((claim) => claim.test(line))) {
      const at = `${file.path}:${index + 1}`;
      findings.push({
        code: CODE,
        cause: `${at} claims who uses Ultimate in its own words, outside the generated production-apps block, so it can drift from PRODUCTION_APPS the way README's "no production use" drifted from the FAQ's "Yes"`,
        fix: `grep -n '' ${renderFixShellArg(file.path, '<file>')}   # at line ${index + 1}, drop the claim or point at the block; a page that must state it gets the block: add it to PRODUCTION_APPS_FILES in scripts/production-apps.ts, then: ${PRODUCTION_APPS_FIX}`,
        at,
      });
    }
  }
  return findings;
}

export async function adoptionClaimFindings(root: string): Promise<readonly Finding[]> {
  const findings: Finding[] = [];
  for (const glob of ADOPTION_GLOBS) {
    for (const file of await readMarkdown(root, glob, skipAdoptionPath)) {
      findings.push(...scanAdoptionClaims(file));
    }
  }
  return findings;
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const findings = await adoptionClaimFindings(repoRoot());
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? 'every who-uses-it claim on a published page is the generated production-apps block'
          : `${findings.length} hand-written who-uses-it claim(s) outside the generated block`,
      findings,
    },
    args.json,
  );
}
