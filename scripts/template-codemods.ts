#!/usr/bin/env bun
// Enforce, as a gate rule, that a scaffold-owned template changed since the last release tag ships
// with its codemod (`packages/cli/src/codemods/`) or a written reason none is needed
// (`scripts/template-codemods-rows.ts`): an app keeps what `x new` wrote, and only a codemod moves it.
// A clone that cannot reach the tag (shallow, tagless) is a notice, never a false red.
//
//   bun run scripts/template-codemods.ts [--write] [--json]   (--write: re-lock what x new renders)

// why: the LEAF modules, never the `@ultimat3/cli` barrel — the import deprecation-window.ts makes.
import { CODEMODS } from '../packages/cli/src/codemods';
import { quoteArg } from '../packages/cli/src/shell-quote';
import { compareVersions } from '../packages/cli/src/upgrade-plan';
import { parseScriptArgs } from './lib/args';
import type { Changelog } from './lib/changelog-sections';
import { loadChangelog } from './lib/changelog-store';
import type { GitRunner } from './lib/git-fetch';
import { releaseBounds } from './lib/guard-refresh-git';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { git } from './lib/release-due-git';
import { repoRoot } from './lib/run';
import { remoteTagProbe, type TagProbe } from './registry-audit';
import {
  RENDER_LOCK_FILE,
  renderCheck,
  renderLockText,
  renderScaffold,
} from './template-codemods-render';
import { TEMPLATE_CODEMOD_ROWS, type TemplateCodemodRow } from './template-codemods-rows';

const SCRIPT = 'template-codemods';
const CODE = 'X_TEMPLATE_CODEMOD_MISSING';
export const TEMPLATE_DIR = 'packages/cli/src/templates';
const ROWS_FILE = 'scripts/template-codemods-rows.ts';

/**
 * What `x new` and `x g sign-in` write that an app then keeps: the templates these entry modules
 * reach. Shipped guards are not here: they run from the installed CLI, never a copy (`guards/`).
 */
const ENTRIES = [
  'scaffold-app.ts',
  'scaffold-repo.ts',
  'resource.ts',
  'shapes/index.ts',
  'sign-in-authenticator.ts',
  'sign-in-oidc.ts',
  'sign-in-pages.ts',
  'sign-in-password.ts',
].map((file) => `${TEMPLATE_DIR}/${file}`);

const NOT_OWNED = /(?:\.test\.ts|-fixture\.ts)$|\/guard-[^/]+\.ts$/;

/** The scaffold-owned template modules: the entries' import closure inside the templates dir. */
export async function scaffoldOwnedTemplates(root: string): Promise<readonly string[]> {
  const transpiler = new Bun.Transpiler({ loader: 'ts' });
  const seen = new Set<string>();
  const stack = [...ENTRIES];
  while (stack.length > 0) {
    const file = stack.pop() ?? '';
    if (seen.has(file)) continue;
    seen.add(file);
    const dir = file.slice(0, file.lastIndexOf('/') + 1);
    for (const { path } of transpiler.scanImports(await Bun.file(`${root}/${file}`).text())) {
      if (!path.startsWith('.')) continue;
      const base = Bun.fileURLToPath(new URL(path, Bun.pathToFileURL(`/${dir}`))).slice(1);
      for (const candidate of [`${base}.ts`, `${base}/index.ts`, base]) {
        if (!candidate.endsWith('.ts') || !candidate.startsWith(`${TEMPLATE_DIR}/`)) continue;
        if (await Bun.file(`${root}/${candidate}`).exists()) {
          stack.push(candidate);
          break;
        }
      }
    }
  }
  return [...seen].filter((file) => !NOT_OWNED.test(file)).sort();
}

const gapFix = (tag: string, template: string): string =>
  `git diff ${quoteArg(`v${tag}`)} -- ${template}   # then write packages/cli/src/codemods/<id>.ts with since after ${tag}, list it in packages/cli/src/codemods/index.ts and add { template, since, codemod } to ${ROWS_FILE} — or { template, since, none: '<why no app needs it>' }; rerun: bun run scripts/template-codemods.ts --json`;

/** Pure: each changed owned template's missing or broken answer, against the last tag `latest`. */
export function templateCodemodGaps(input: {
  readonly latest: string;
  readonly changed: readonly string[];
  readonly owned: readonly string[];
  readonly rows: readonly TemplateCodemodRow[];
  readonly codemods: readonly { readonly id: string; readonly since: string }[];
}): readonly Finding[] {
  const { latest } = input;
  const owned = new Set(input.owned);
  const live = input.rows.filter((row) => compareVersions(row.since, latest) > 0);
  const findings: Finding[] = [];
  for (const template of [...new Set(input.changed)].filter((path) => owned.has(path)).sort()) {
    if (!live.some((row) => row.template === template)) {
      findings.push({
        code: CODE,
        cause: `${template} changed since v${latest}, and no codemod or written reason answers for it: an app keeps the file x new wrote, so without a codemod x upgrade leaves every app on the old one`,
        fix: gapFix(latest, template),
        at: template,
      });
    }
  }
  for (const row of live) {
    if (!owned.has(row.template)) {
      findings.push({
        code: CODE,
        cause: `${ROWS_FILE} answers for ${row.template}, which is no scaffold-owned template: a row for nothing excuses nothing`,
        fix: `edit ${ROWS_FILE} — remove the ${row.template} row, or name the template as it is; then bun run scripts/template-codemods.ts --json`,
        at: ROWS_FILE,
      });
    } else if ('codemod' in row) {
      const listed = input.codemods.find((codemod) => codemod.id === row.codemod);
      if (listed?.since !== row.since) {
        findings.push({
          code: CODE,
          cause: `${ROWS_FILE} carries ${row.template} by codemod ${row.codemod} since ${row.since}, and packages/cli/src/codemods/index.ts lists ${listed === undefined ? 'no codemod of that id' : `it since ${listed.since}`}`,
          fix: `edit packages/cli/src/codemods/index.ts — list ${row.codemod} there with since ${row.since}, or correct its row in ${ROWS_FILE}; then bun test ./packages/cli/src/codemods/index.test.ts`,
          at: ROWS_FILE,
        });
      }
    } else if (row.none.trim().length < 20) {
      findings.push({
        code: CODE,
        cause: `${ROWS_FILE} excuses ${row.template} with "${row.none}", which says no reason an app needs no codemod`,
        fix: `edit ${ROWS_FILE} — write in the ${row.template} row's none why an app that keeps the old file is not broken by it; then bun run scripts/template-codemods.ts --json`,
        at: ROWS_FILE,
      });
    }
  }
  return findings;
}

export interface TemplateCodemodsOutcome {
  readonly findings: readonly Finding[];
  /** Why nothing was judged: the tag or the diff this clone could not answer for. */
  readonly notice?: string;
}

export interface TemplateCodemodsOptions {
  readonly runner?: GitRunner;
  readonly probe?: TagProbe;
  readonly changelog?: Changelog;
  readonly rows?: readonly TemplateCodemodRow[];
  /** What `x new` renders now; the real render unless a test names one. */
  readonly rendered?: Readonly<Record<string, string>>;
}

const boundedGit: GitRunner = (command, { cwd }) => git(command.slice(1), cwd);

const lines = (output: string): readonly string[] =>
  output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

export async function templateCodemodFindings(
  root: string,
  options: TemplateCodemodsOptions = {},
): Promise<TemplateCodemodsOutcome> {
  const runner = options.runner ?? boundedGit;
  const changelog = options.changelog ?? (await loadChangelog(root));
  const bounds = await releaseBounds(
    root,
    changelog,
    runner,
    options.probe ?? remoteTagProbe(root),
  );
  if ('finding' in bounds) {
    return {
      findings: [],
      notice: `not judged: ${bounds.finding.cause} — ${bounds.finding.fix}`,
    };
  }
  const tag = `v${bounds.latest}`;
  // The working tree against the tag, untracked templates included: a new file is a change too.
  const diff = await runner(
    ['git', 'diff', '--no-renames', '--name-only', tag, '--', `${TEMPLATE_DIR}/`],
    { cwd: root },
  );
  const untracked = await runner(
    ['git', 'ls-files', '--others', '--exclude-standard', '--', `${TEMPLATE_DIR}/`],
    { cwd: root },
  );
  if (!diff.ok || !untracked.ok) {
    return {
      findings: [],
      notice: `not judged: git could not diff ${TEMPLATE_DIR}/ against ${tag} in this clone — git fetch --no-tags origin ${quoteArg(`+refs/tags/${tag}:refs/tags/${tag}`)} && bun run scripts/template-codemods.ts --json`,
    };
  }
  // What `x new` renders, against the tag's lock: a change made outside `templates/` counts too.
  const rendered = await renderCheck({
    root,
    tag,
    show: async (ref) => {
      const shown = await runner(['git', 'show', ref], { cwd: root });
      return shown.ok ? shown.output : undefined;
    },
    ...(options.rendered === undefined ? {} : { now: options.rendered }),
  });
  const findings = templateCodemodGaps({
    latest: bounds.latest,
    changed: [...lines(diff.output), ...lines(untracked.output), ...rendered.changed],
    owned: [...(await scaffoldOwnedTemplates(root)), ...rendered.paths],
    rows: options.rows ?? TEMPLATE_CODEMOD_ROWS,
    codemods: CODEMODS,
  });
  const stale: readonly Finding[] = rendered.stale
    ? [
        {
          code: CODE,
          cause: `${RENDER_LOCK_FILE} is not what x new renders now, so the next release could not tell what this one changed in an app's files`,
          fix: 'bun run scripts/template-codemods.ts --write   # then commit the lock beside the change',
          at: RENDER_LOCK_FILE,
        },
      ]
    : [];
  return {
    findings: [...findings, ...stale],
    ...(rendered.notice === undefined ? {} : { notice: rendered.notice }),
  };
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  if (args.flags.has('write')) {
    await Bun.write(`${repoRoot()}/${RENDER_LOCK_FILE}`, renderLockText(renderScaffold()));
  }
  const { findings, notice } = await templateCodemodFindings(repoRoot());
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length > 0
          ? `${findings.length} scaffold-owned template change(s) with no codemod`
          : (notice ??
            'every scaffold-owned template changed since the last release has its codemod or its reason'),
      findings,
      ...(notice === undefined ? {} : { data: { notice } }),
    },
    args.json,
  );
}
