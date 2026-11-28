// 31.53.0: CLAUDE.md names the motion and effect guards, the Visual quality section and the agent
// kit that replaced `.claude/commands`. Prose: each edit lands where the text stands as `x new` wrote
// it, within the brief's byte budget; one that cannot be placed is reported with the row to add.

import { editAgentsDocRow } from './agents-doc-row';
import type { Codemod, CodemodApp, CodemodResult } from './codemod';
import { mergeResults } from './engine-edits';

const lines = (...text: readonly string[]): string => text.join('\n');

const OLD_HARNESS = lines(
  '- `.claude/` holds a harness that reads this file: `/feature`, `/planx`, `/verify` and four',
  '  boundary-scoped subagents. `.claude/README.md` says what each costs; every file is deletable.',
);
const NEW_HARNESS = lines(
  '- `.claude/` holds the agent kit that reads this file: five skills, five boundary-scoped agents.',
  '  Managed: `bunx x kit` rewrites them, an edit in place is `X_KIT_DRIFT`; yours go in `app-*`.',
);

const NEW_SKILLS =
  '| `.claude/skills/` | `feature` (hive, one PR, done when merged), `planx`, `verify`, `upgrade`, `design-research` | plain markdown any agent can follow; `bunx x kit` keeps them current |';

const OLD_TIMING =
  '| Timing | a duration and an easing curve come off the motion scale, never a literal | `raw-motion` |';
const NEW_TIMING = lines(
  '| Timing | a duration and an easing curve come off the motion scale — `motionTiming()` from `@ultimat3/ui/motion` in TypeScript — never a literal | `raw-motion`, `raw-motion-script` |',
  '| Motion adapter | animation through `@ultimat3/ui/motion` and `@ultimat3/effects`, never an animation or shader library | `motion-adapter` |',
  '| Frame loops | `frameLoop(tick, { el })` from `@ultimat3/ui/motion`, never a bare `requestAnimationFrame(`; a `// why:` admits one | `raw-frame-loop` |',
  '| Effects | a `<canvas>` or WebGL context only inside `EffectCanvas` (`@ultimat3/effects`), whose `fallback` is required | `effect-without-fallback` |',
);

const OLD_MOTION =
  '| Motion | animate `transform` and `opacity` — never a layout property, never `transition: all` | `animated-layout-property` |';
const NEW_MOTION =
  '| Motion | animate `transform` and `opacity` — never a layout property, never `transition: all`; reorder with `layout()` from `@ultimat3/ui/motion` | `animated-layout-property`, `animated-layout-script` |';

const BEFORE_TOOLS = '## Agent tools';
const VISUAL_QUALITY = lines(
  '## Visual quality',
  '',
  "`apps/web/DESIGN.md` is this app's design — tokens, type, motion, sources — read before rendering.",
  '',
  '| Rule | Refused by |',
  '|---|---|',
  '| every colour pair a theme changes meets WCAG 2.2 AA | `defineTheme`: `X_UI_CONTRAST_INSUFFICIENT` |',
  '| motion is optional: loops and effects stop for reduced motion, a hidden tab and `MotionToggle` | `raw-frame-loop`, `motion-adapter` |',
  "| an effect's static frame renders first, so `site/` stays 0kb JS | `effect-without-fallback`, the `budgets` step |",
  '| a look is matched by measurement: `bunx x shot <route> --against .x/design/<slug>` | recorded, never gating |',
  '',
);

const COMMAND_ROW = /^\| `\.claude\/commands\/(?:feature|planx|verify)\.md` \|.*$/;

/**
 * Every wording `x new` ever shipped for the three rows (read off each release tag's
 * `scaffold-docs.ts`): 31.22.0 to 31.35.x said "plain markdown: any agent can read one and follow it",
 * later ones "plain markdown any agent can follow". A row in neither is the author's.
 */
const SHIPPED_COMMAND_ROWS: ReadonlySet<string> = new Set([
  '| `.claude/commands/feature.md` | build or fix one thing end to end, done when `bun run verify` is green | plain markdown: any agent can read one and follow it |',
  '| `.claude/commands/planx.md` | write a plan to `docs/plans/` for another agent to execute | the same |',
  '| `.claude/commands/verify.md` | run the gate and fix what it reports | the same |',
  '| `.claude/commands/feature.md` | build or fix one thing end to end, done when `bun run verify` is green | plain markdown any agent can follow |',
  '| `.claude/commands/planx.md` | write a plan to `docs/plans/` | the same |',
]);

const SECTION = '## Agent tools';

/**
 * `text` from the Agent tools heading to the last row of the FIRST table under it, or `undefined`
 * when it has none: a later table under the same heading is the author's, never this table.
 */
function agentToolsSection(text: string): string | undefined {
  const start = text.indexOf(`\n${SECTION}\n`);
  if (start === -1) return undefined;
  const lines = text.slice(start + 1).split('\n');
  const head = lines.findIndex((line) => line.startsWith('|'));
  if (head === -1 || lines.slice(1, head).some((line) => line.startsWith('## '))) return undefined;
  let end = head;
  while ((lines[end + 1] ?? '').startsWith('|')) end += 1;
  return lines.slice(0, end + 1).join('\n');
}

type CommandRows =
  | { readonly kind: 'swap'; readonly from: string; readonly to: string }
  | { readonly kind: 'customised'; readonly rows: readonly string[] }
  | { readonly kind: 'none' };

/**
 * The `.claude/commands/*` rows INSIDE the Agent tools table, never an earlier table's: all shipped
 * wordings are replaced by the one skills row, and any row the author changed (a review step added,
 * say) holds the whole swap back so nothing they wrote is dropped. `from` runs from the heading to
 * the last row, so it names exactly one place in the brief.
 */
async function commandRows(app: CodemodApp): Promise<CommandRows> {
  for (const path of ['CLAUDE.md', 'AGENTS.md']) {
    const text = (await app.read(path)) ?? '';
    const section = agentToolsSection(text);
    if (section === undefined) continue;
    const rows = section.split('\n');
    const first = rows.findIndex((row) => COMMAND_ROW.test(row));
    if (first === -1) continue;
    let last = first;
    while (COMMAND_ROW.test(rows[last + 1] ?? '')) last += 1;
    const block = rows.slice(first, last + 1);
    const custom = block.filter((row) => !SHIPPED_COMMAND_ROWS.has(row));
    if (custom.length > 0) return { kind: 'customised', rows: custom };
    const head = rows.slice(0, first).join('\n');
    return {
      kind: 'swap',
      from: `${head}\n${block.join('\n')}`,
      to: `${head}\n${NEW_SKILLS}`,
    };
  }
  return { kind: 'none' };
}

async function swapCommandRows(app: CodemodApp): Promise<CodemodResult> {
  const found = await commandRows(app);
  if (found.kind === 'customised') {
    return {
      changed: [],
      skipped: [
        {
          path: 'CLAUDE.md',
          reason: `the Agent tools table keeps ${String(found.rows.length)} \`.claude/commands\` row(s) you changed, so none was replaced: move what they say into the skills (or your own app-* ones), then replace the rows with this one by hand: ${NEW_SKILLS}`,
        },
      ],
    };
  }
  if (found.kind === 'none') {
    // No legacy row inside the Agent tools table: nothing elsewhere in the brief is this table's.
    for (const path of ['CLAUDE.md', 'AGENTS.md']) {
      if ((await app.read(path))?.includes('`.claude/skills/`') === true) {
        return { changed: [], skipped: [] };
      }
    }
    return {
      changed: [],
      skipped: [
        {
          path: 'CLAUDE.md',
          reason: `no .claude/commands rows in the Agent tools table; add this row to the conventions table by hand: ${NEW_SKILLS}`,
        },
      ],
    };
  }
  return editAgentsDocRow(app, {
    from: found.from,
    to: found.to,
    row: NEW_SKILLS,
    said: (text) => text.includes('`.claude/skills/`'),
    missing: 'no .claude/commands rows in the Agent tools table',
  });
}

const swap =
  (from: string, to: string, said: string, missing: string) =>
  (app: Parameters<Codemod['run']>[0]) =>
    editAgentsDocRow(app, { from, to, row: to, said: (text) => text.includes(said), missing });

export const codemod: Codemod = {
  id: 'docs-visual-quality',
  since: '31.53.0',
  summary:
    "CLAUDE.md names the motion and effect guards, the Visual quality section and the agent kit's skills",
  async run(app): Promise<CodemodResult> {
    // The two that shrink first, so the ones that grow find the room they need.
    const results = [
      await swapCommandRows(app),
      await swap(
        OLD_HARNESS,
        NEW_HARNESS,
        'holds the agent kit',
        'no ".claude/ holds a harness" bullet',
      )(app),
      await swap(
        OLD_TIMING,
        NEW_TIMING,
        'raw-motion-script',
        'no Timing row as x new wrote it',
      )(app),
      await swap(
        OLD_MOTION,
        NEW_MOTION,
        'animated-layout-script',
        'no Motion row as x new wrote it',
      )(app),
      await swap(
        BEFORE_TOOLS,
        `${VISUAL_QUALITY}\n${BEFORE_TOOLS}`,
        '## Visual quality',
        'no "## Agent tools" heading to place the section above',
      )(app),
    ];
    return mergeResults(results);
  },
};
