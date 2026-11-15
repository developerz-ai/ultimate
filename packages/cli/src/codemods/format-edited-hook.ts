// The PostToolUse format hook, carried twice. 31.22.0: it read `$CLAUDE_FILE_PATHS`, which the
// harness never sets; now `.claude/hooks/format-edited.ts` reads the path from stdin. 31.28.0: that
// script ran `bunx biome`, which with no install fetches an unrelated npm package; now it runs the
// app's own `node_modules/.bin/biome` or nothing, and the docs name `@biomejs/biome`.

import { claudeHookFile, HOOK_PATH } from '../templates/scaffold-claude-hook';
import type { Codemod } from './codemod';
import type { SnippetEdit } from './engine-edits';
import { editSnippets, mergeResults, writeIfAbsent } from './engine-edits';
import { HOOK_SCRIPT_3122 } from './format-edited-hook-3122';

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

/** The stock script `x new` wrote from 31.22.0, whole: an app that edited it keeps its own. */
const script = claudeHookFile().contents;
const HOOK_SCRIPT: SnippetEdit = {
  from: HOOK_SCRIPT_3122,
  to: typeof script === 'string' ? script : HOOK_SCRIPT_3122,
};

/** `bunx biome` names whatever npm calls `biome`; `@biomejs/biome` is the formatter. */
const BIOME_ALLOW: SnippetEdit = {
  from: '      "Bash(bunx biome check:*)",',
  to: '      "Bash(bunx @biomejs/biome check:*)",',
  optional: true,
};
const README_BIOME: SnippetEdit = {
  from: `One \`PostToolUse\` hook, \`${HOOK_PATH}\`: \`bunx biome check --write\` on the file that was just`,
  to: `One \`PostToolUse\` hook, \`${HOOK_PATH}\`: the installed \`biome check --write\` on the file that was just`,
  optional: true,
};
const LINT_LINE: SnippetEdit = {
  from: '`bunx biome check --write <paths>`',
  to: '`bunx @biomejs/biome check --write <paths>`',
  optional: true,
};
const DOCS = [
  '.claude/agents/data.md',
  '.claude/agents/server.md',
  '.claude/agents/web.md',
  '.claude/commands/feature.md',
] as const;

/** The 31.28.0 edits alone, per file, in run order: what a 31.22-to-31.27 app is carried by. */
export const BIOME_EDITS: Readonly<Record<string, readonly SnippetEdit[]>> = {
  [SETTINGS]: [BIOME_ALLOW],
  [HOOK_PATH]: [HOOK_SCRIPT],
  [README]: [README_BIOME],
  ...Object.fromEntries(DOCS.map((path) => [path, [LINT_LINE]])),
};

/** Each file's edits: what the codemod runs, and what its test runs backwards. */
export const FORMAT_HOOK_EDITS = {
  [SETTINGS]: [ALLOWED, HOOK, BIOME_ALLOW],
  [README]: [...README_EDITS, README_BIOME],
} as const;

export const codemod: Codemod = {
  id: 'format-edited-hook',
  since: '31.28.0',
  summary: `.claude/settings.json runs ${HOOK_PATH}, which reads the edited file from stdin and runs the app's own biome, never bunx biome`,
  async run(app) {
    const settings = await editSnippets(app, SETTINGS, FORMAT_HOOK_EDITS[SETTINGS]);
    // The script only where settings.json runs it: an app that dropped the hook keeps none.
    const runsIt = ((await app.read(SETTINGS)) ?? '').includes(HOOK_PATH);
    const results = [
      settings,
      runsIt && typeof script === 'string'
        ? await writeIfAbsent(app, HOOK_PATH, script)
        : { changed: [], skipped: [] },
      await editSnippets(app, HOOK_PATH, [HOOK_SCRIPT]),
      await editSnippets(app, README, FORMAT_HOOK_EDITS[README]),
    ];
    for (const path of DOCS) results.push(await editSnippets(app, path, [LINT_LINE]));
    return mergeResults(results);
  },
};
