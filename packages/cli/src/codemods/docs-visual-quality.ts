// 31.53.0: CLAUDE.md names the motion and effect guards, the Visual quality section and the agent
// kit that replaced `.claude/commands`. Prose: each edit lands where the text stands as `x new` wrote
// it, within the brief's byte budget; one that cannot be placed is reported with the row to add.

import { editAgentsDocRow } from './agents-doc-row';
import type { Codemod, CodemodResult } from './codemod';
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

const OLD_COMMANDS = lines(
  '| `.claude/commands/feature.md` | build or fix one thing end to end, done when `bun run verify` is green | plain markdown any agent can follow |',
  '| `.claude/commands/planx.md` | write a plan to `docs/plans/` | the same |',
  '| `.claude/commands/verify.md` | run the gate and fix what it reports | the same |',
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
      await swap(
        OLD_COMMANDS,
        NEW_SKILLS,
        '`.claude/skills/`',
        'no .claude/commands rows in the Agent tools table',
      )(app),
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
