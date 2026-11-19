#!/usr/bin/env bun
// Enforce, as a gate rule, that the command a `fix:` line ends on runs as printed and stays narrow.
//
// `x` is on nobody's PATH in an app, so `runnableFix` turns each citation into `bunx x` when a fix
// is rendered; a citation it cannot see stays `command not found`. And `then: x verify` sent a
// worker fixing one file to the whole gate, which `wiki/Many-Agents.md` forbids. Same fix scan as
// the `errors` step, plus the shipped guards' rule files, whose `fix:` lines the scan cannot read
// through the template they are written in. Repo-only: an app's own fix lines are the app's.
//
//   bun run scripts/fix-tails.ts [--json]

// why: Bun exposes no path-join primitive, and the scan reads every source file by its repo path.
import { join } from 'node:path';
import { staticFix } from '../packages/cli/src/error-contract';
import { createHelperResolver } from '../packages/cli/src/fix-imports';
import { scanFixSites } from '../packages/cli/src/fix-scan';
import { runnableFix } from '../packages/cli/src/output-findings';
import { eachSourceFile, isGenerated, isTest } from '../packages/cli/src/source-files';
import {
  SHIPPED_GUARD_NAMES,
  shippedGuardSources,
} from '../packages/cli/src/templates/scaffold-guards';
import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'fix-tails';

export interface FixTailSite {
  readonly at: string;
  readonly line: number;
  readonly fix: string;
}

/** A quoted span is an argument: `git commit -m "before x upgrade"` tells nobody to run `x`. */
const QUOTED = /(^|[\s([{=,:])(["'])(?:(?!\2).)*\2/g;
/** An `x <command>` with no runner in front, written independently of what `runnableFix` matches. */
const BARE = /(?<![\w./-])(?<!\bbunx )(?<!\bnpx )(?<!\bbun )(?<!\bbun run )(?<!--bun )x (?=[a-z<])/;
/** A closing `then` that runs the gate or every suite, with nothing narrowing it. */
const WHOLE_RUN = /\bthen:? x (?:verify(?![^#;|&]*--only)|test\s*(?:$|[#;|&]))/;

export type FixTailProblem = 'bare' | 'whole-run';

/** What is wrong with one fix line as a reader gets it, `undefined` when nothing is. */
export function fixTailProblem(raw: string): FixTailProblem | undefined {
  const fix = staticFix(raw);
  if (WHOLE_RUN.test(fix)) return 'whole-run';
  return BARE.test(runnableFix(fix).replace(QUOTED, '$1')) ? 'bare' : undefined;
}

const scanned = (at: string, source: string, imported: Parameters<typeof scanFixSites>[2]) =>
  scanFixSites(source, at, imported).sites.map((site) => ({ at, line: site.line, fix: site.fix }));

/** Every fix line a reader can be handed: shipped source, then each shipped guard's rule file. */
export async function fixTailSites(root: string): Promise<readonly FixTailSite[]> {
  const imports = createHelperResolver(root);
  const sites: FixTailSite[] = [];
  for await (const path of eachSourceFile(root)) {
    if (isTest(path) || isGenerated(path)) continue;
    const source = await Bun.file(join(root, path)).text();
    sites.push(...scanned(path, source, await imports(path, source)));
  }
  for (const name of SHIPPED_GUARD_NAMES) {
    for (const source of shippedGuardSources(name)) {
      sites.push(...scanned(`guards/${name}.ts`, source, []));
    }
  }
  return sites;
}

export function fixTailFinding(site: FixTailSite, problem: FixTailProblem): Finding {
  const at = `${site.at}:${String(site.line)}`;
  return problem === 'bare'
    ? {
        code: 'X_FIX_TAIL_BARE',
        cause: `the fix at ${at} cites x where the renderer cannot make it bunx x, so it prints a command no shell finds: ${site.fix}`,
        fix: `edit ${site.at}:${String(site.line)} — put a space, a ( or a backtick before the x, then: bun run scripts/fix-tails.ts --json`,
        at,
      }
    : {
        code: 'X_FIX_TAIL_WHOLE_RUN',
        cause: `the fix at ${at} ends by running the whole gate or every suite, which a worker on a file set must not start: ${site.fix}`,
        fix: `edit ${site.at}:${String(site.line)} — name what it re-runs (x verify --only <step>, x test --filter <path>), then: bun run scripts/fix-tails.ts --json`,
        at,
      };
}

export const fixTailFindings = (sites: readonly FixTailSite[]): readonly Finding[] =>
  sites.flatMap((site) => {
    const problem = fixTailProblem(site.fix);
    return problem === undefined ? [] : [fixTailFinding(site, problem)];
  });

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const sites = await fixTailSites(repoRoot());
  const findings = fixTailFindings(sites);
  report(
    {
      ok: findings.length === 0 && sites.length > 0,
      script: SCRIPT,
      summary: `${String(findings.length)} of ${String(sites.length)} fix line(s) end on a command that does not run as printed or runs everything`,
      findings,
    },
    args.json,
  );
}
