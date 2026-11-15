// 31.22.0: the PostToolUse format hook read `$CLAUDE_FILE_PATHS`, which the harness never sets, so
// it formatted nothing. Now `.claude/hooks/format-edited.ts` reads the edited path from stdin;
// `settings.json` runs it, and the read-only commands the app's docs name stop prompting.

import { claudeHookFile, HOOK_PATH } from '../templates/scaffold-claude-hook';
import type { Codemod } from './codemod';
import type { SnippetEdit } from './engine-edits';
import { editSnippets, mergeResults, writeIfAbsent } from './engine-edits';

const SETTINGS = '.claude/settings.json';
const README = '.claude/README.md';

const lines = (...text: readonly string[]): string => text.join('\n');

/** The hook as `settings.json` held it before: the dead command, matched as the template wrote it. */
const HOOK: SnippetEdit = {
  from: lines(
    '        "matcher": "Edit|Write",',
    '        "hooks": [',
    '          {',
    '            "type": "command",',
    '            "command": "bunx biome check --no-errors-on-unmatched --write \\"$CLAUDE_FILE_PATHS\\" 2>/dev/null || true"',
    '          }',
  ),
  to: lines(
    '        "matcher": "Edit|Write|MultiEdit",',
    '        "hooks": [',
    '          {',
    '            "type": "command",',
    `            "command": "bun \\"$CLAUDE_PROJECT_DIR\\"/${HOOK_PATH}",`,
    '            "timeout": 20',
    '          }',
  ),
};

/** The read-only commands added to the allowlist alongside: the app's own list wins if edited. */
const ALLOWED: SnippetEdit = {
  from: lines('      "Bash(bunx x docs:*)",', '      "Bash(bunx x env check:*)",'),
  to: lines(
    '      "Bash(bunx x docs:*)",',
    ...[
      'impact',
      'graph',
      'affected',
      'exercise',
      'i18n sync',
      'fix boundary',
      'mcp tools',
      'env check',
    ].map((command) => `      "Bash(bunx x ${command}:*)",`),
  ),
  optional: true,
};

const README_EDITS: readonly SnippetEdit[] = [
  {
    from: lines(
      '| `settings.json` | nothing in context | read once per session; the hook runs per edit |',
      '| `commands/*.md` |',
    ),
    to: lines(
      '| `settings.json` | nothing in context | read once per session; the hook runs per edit |',
      `| \`${HOOK_PATH.slice('.claude/'.length)}\` | nothing in context | runs after each edit, on that one file |`,
      '| `commands/*.md` |',
    ),
    optional: true,
  },
  {
    from: lines(
      'One `PostToolUse` hook: `bunx biome check --write` on the file that was just edited. **`--write`',
      'means it rewrites that file in place** — the same safe fixes `biome check --write .` would make',
      'repo-wide, but your working tree does change after every agent edit. Scoped to one file, so it costs',
      'milliseconds, and it settles formatting arguments before they reach a diff.',
    ),
    to: lines(
      `One \`PostToolUse\` hook, \`${HOOK_PATH}\`: \`bunx biome check --write\` on the file that was just`,
      'edited, named by the JSON the harness sends on stdin. **`--write` means it rewrites that file in',
      'place** — the same safe fixes `biome check --write .` would make repo-wide, but your working tree',
      'does change after every agent edit. Scoped to one file, so it costs milliseconds, and it settles',
      'formatting arguments before they reach a diff. What biome cannot fix is shown to the agent at once,',
      'with the command that re-checks the file, instead of surfacing later as a red `lint` step.',
    ),
    optional: true,
  },
];

/** Each file's edits: what the codemod runs, and what its test runs backwards. */
export const FORMAT_HOOK_EDITS = {
  [SETTINGS]: [ALLOWED, HOOK],
  [README]: README_EDITS,
} as const;

export const codemod: Codemod = {
  id: 'format-edited-hook',
  since: '31.22.0',
  summary: `.claude/settings.json runs ${HOOK_PATH}, which reads the edited file from stdin: the old hook formatted nothing`,
  async run(app) {
    const settings = await editSnippets(app, SETTINGS, [ALLOWED, HOOK]);
    // The script only where settings.json runs it: an app that dropped the hook keeps none.
    const runsIt = ((await app.read(SETTINGS)) ?? '').includes(HOOK_PATH);
    const script = claudeHookFile().contents;
    return mergeResults([
      settings,
      runsIt && typeof script === 'string'
        ? await writeIfAbsent(app, HOOK_PATH, script)
        : { changed: [], skipped: [] },
      await editSnippets(app, README, README_EDITS),
    ]);
  },
};
