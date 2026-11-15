// The template-codemod rule: a scaffold-owned template changed since the last tag needs a live row
// (a listed codemod of that `since`, or a written reason); a test or guard template needs none; a
// clone that cannot reach the tag is a notice, never a red. And the rule on this repo's own tree.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { parseChangelog } from './lib/changelog-sections';
import type { GitRunner } from './lib/git-fetch';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import {
  scaffoldOwnedTemplates,
  TEMPLATE_DIR,
  templateCodemodFindings,
  templateCodemodGaps,
} from './template-codemods';
import type { TemplateCodemodRow } from './template-codemods-rows';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const AUTH = `${TEMPLATE_DIR}/scaffold-auth.ts`;
const CLAUDE = `${TEMPLATE_DIR}/scaffold-claude.ts`;
const OWNED = [AUTH, CLAUDE];
const CODEMODS = [{ id: 'authenticator-session-refusal', since: '31.28.0' }];

const gaps = (changed: readonly string[], rows: readonly TemplateCodemodRow[]) =>
  templateCodemodGaps({ latest: '31.27.0', changed, owned: OWNED, rows, codemods: CODEMODS });

describe('unit · template-codemods, the rule', () => {
  test('a changed scaffold-owned template with no row is refused, naming it and the diff', () => {
    const [finding, ...rest] = gaps([AUTH], []);
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_TEMPLATE_CODEMOD_MISSING');
    expect(finding?.at).toBe(AUTH);
    expect(finding?.fix).toStartWith(`git diff v31.27.0 -- ${AUTH}`);
  });

  test('a listed codemod of the row’s since, or a written reason, answers for it', () => {
    expect(
      gaps(
        [AUTH, CLAUDE],
        [
          { template: AUTH, since: '31.28.0', codemod: 'authenticator-session-refusal' },
          { template: CLAUDE, since: '31.28.0', none: 'prose the app owns, which no gate reads' },
        ],
      ),
    ).toEqual([]);
  });

  test('a row at or below the last tag is history and answers for nothing', () => {
    expect(
      gaps(
        [CLAUDE],
        [{ template: CLAUDE, since: '31.27.0', none: 'an older change, long shipped' }],
      ),
    ).toHaveLength(1);
  });

  test('a row naming an unlisted codemod, a codemod of another since, or no reason, is refused', () => {
    const rows: readonly TemplateCodemodRow[] = [
      { template: AUTH, since: '31.28.0', codemod: 'gone' },
      { template: CLAUDE, since: '31.28.0', none: 'n/a' },
    ];
    expect(gaps([AUTH, CLAUDE], rows).map((finding) => finding.cause)).toEqual([
      expect.stringContaining('no codemod of that id'),
      expect.stringContaining('says no reason'),
    ]);
    const mismatched = gaps(
      [AUTH],
      [{ template: AUTH, since: '31.29.0', codemod: 'authenticator-session-refusal' }],
    );
    expect(mismatched[0]?.cause).toContain('it since 31.28.0');
  });

  test('a row for a path that is no scaffold-owned template is refused', () => {
    const found = gaps(
      [],
      [
        {
          template: `${TEMPLATE_DIR}/nope.ts`,
          since: '31.28.0',
          none: 'whatever the reason may be',
        },
      ],
    );
    expect(found[0]?.cause).toContain('no scaffold-owned template');
  });

  test('a test, a fixture or anything outside the owned set needs no row', () => {
    expect(gaps([`${TEMPLATE_DIR}/scaffold-auth.test.ts`, 'README.md'], [])).toEqual([]);
  });
});

describe('unit · template-codemods, the owned set', () => {
  test('what x new and x g sign-in write, never a shipped guard or a test', async () => {
    const owned = await scaffoldOwnedTemplates(repoRoot());
    for (const file of [
      'scaffold-auth.ts',
      'scaffold-claude.ts',
      'scaffold-claude-hook.ts',
      'chart-dashboard.ts',
      'sign-in-authenticator.ts',
      'github/ci.yml.ts',
    ]) {
      expect(owned).toContain(`${TEMPLATE_DIR}/${file}`);
    }
    expect(owned.some((file) => file.endsWith('.test.ts'))).toBe(false);
    expect(owned.some((file) => /\/guard-[^/]+\.ts$/.test(file))).toBe(false);
  });
});

/** A git that holds the given tags and answers `diff` with `changed`; or cannot diff at all. */
const fakeGit =
  (tags: readonly string[], changed: string | null, shown?: string): GitRunner =>
  async (command) => {
    const args = command.slice(1);
    const answer = (ok: boolean, output = '') => ({
      command,
      ok,
      code: ok ? 0 : 1,
      output,
      durationMs: 0,
      timedOut: false,
    });
    if (args[0] === 'rev-parse' && args[1] === '--is-shallow-repository')
      return answer(true, 'true');
    if (args[0] === 'rev-parse')
      return answer(tags.some((tag) => (args.at(-1) ?? '').includes(`refs/tags/${tag}^`)));
    if (args[0] === 'fetch') return answer(false);
    if (args[0] === 'diff') return changed === null ? answer(false) : answer(true, changed);
    if (args[0] === 'ls-files') return answer(true, '');
    if (args[0] === 'show' && shown !== undefined) return answer(true, shown);
    return answer(false);
  };

/** A render the tag's lock agrees with: no rendered change, so only the template diff speaks. */
const SAME = { 'bare:README.md': 'same' };

const CHANGELOG = parseChangelog(
  '## [Unreleased]\n\nx\n\n## 31.27.0 - 2026-11-14\n\nx\n\n## 31.26.0 - 2026-11-13\n\nx\n',
);

describe('unit · template-codemods, a clone that cannot answer', () => {
  test('a tag nobody can reach is a notice and no finding', async () => {
    const outcome = await templateCodemodFindings(repoRoot(), {
      runner: fakeGit([], ''),
      probe: async () => undefined,
      changelog: CHANGELOG,
    });
    expect(outcome.findings).toEqual([]);
    expect(outcome.notice).toContain('not judged');
  });

  test('a tag held but a diff git cannot make (shallow) is a notice naming the fetch', async () => {
    const outcome = await templateCodemodFindings(repoRoot(), {
      runner: fakeGit(['v31.27.0', 'v31.26.0'], null),
      probe: async () => true,
      changelog: CHANGELOG,
    });
    expect(outcome.findings).toEqual([]);
    expect(outcome.notice).toContain('git fetch --no-tags origin');
  });

  test('a reachable tag and a changed template with no row is the finding, not a notice', async () => {
    const outcome = await templateCodemodFindings(repoRoot(), {
      runner: fakeGit(['v31.27.0', 'v31.26.0'], `${AUTH}\n`, JSON.stringify(SAME)),
      probe: async () => true,
      changelog: CHANGELOG,
      rows: [],
      rendered: SAME,
    });
    expect(outcome.notice).toBeUndefined();
    expect(outcome.findings.map((finding) => finding.at)).toContain(AUTH);
  });
});

describe('unit · template-codemods, a change outside templates/', () => {
  // `DEFAULT_PLAN_PARTS` lives in verify-plan.ts and is printed into ci.yml: no template file
  // changed, yet what x new writes did — the rendered lock is what sees it.
  const NOW = { 'bare:.github/workflows/ci.yml': 'new', 'bare:README.md': 'same' };
  const BASE = JSON.stringify({ 'bare:.github/workflows/ci.yml': 'old', 'bare:README.md': 'same' });

  test('a rendered file that moved since the tag needs its own row, named by its path', async () => {
    const outcome = await templateCodemodFindings(repoRoot(), {
      runner: fakeGit(['v31.27.0', 'v31.26.0'], '', BASE),
      probe: async () => true,
      changelog: CHANGELOG,
      rows: [],
      rendered: NOW,
    });
    expect(outcome.findings.map((finding) => finding.at)).toContain('.github/workflows/ci.yml');
    const answered = await templateCodemodFindings(repoRoot(), {
      runner: fakeGit(['v31.27.0', 'v31.26.0'], '', BASE),
      probe: async () => true,
      changelog: CHANGELOG,
      rows: [
        {
          template: '.github/workflows/ci.yml',
          since: '31.28.0',
          none: 'the parts count moved; an old workflow still runs the whole gate',
        },
      ],
      rendered: NOW,
    });
    expect(answered.findings.map((finding) => finding.at)).not.toContain(
      '.github/workflows/ci.yml',
    );
  });
});

describe('the template-codemod rule, on this repo', () => {
  // Green is the rows: the same tree with none of them is red for every changed template they name.
  test('every scaffold-owned template changed since the last tag has its codemod or its reason', async () => {
    const root = repoRoot();
    const outcome = await templateCodemodFindings(root);
    expect(outcome.findings).toEqual([]);
    if (outcome.notice !== undefined) return;
    const bare = await templateCodemodFindings(root, { rows: [] });
    expect(bare.findings.length).toBeGreaterThan(0);
  });
});
