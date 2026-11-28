// The pages allowed to name an `x …` that does not resolve, one line each, with the reason.
// Read by `scripts/doc-commands.ts`; an entry that matches nothing is a finding, so the list can
// only shrink by being wrong.
//
// TWO reasons are legitimate and nothing else is. `absent`: the sentence's SUBJECT is that the
// command does not exist — "there is no `x serve` command", `wiki/CLI-Reference.md`'s "Names that
// moved" table, an error row recording that the wiki used to print a command that never shipped.
// Refusing those would delete true sentences, which is a worse doc than a stale one. `proposed`:
// a design document naming vocabulary a roadmap milestone proposes and the registry deliberately
// does not carry yet — `PLANNED_COMMANDS` covers the ones that parse, and these are the ones that
// do not even do that.
//
// Not a reason: "we will fix it later". Drift is a finding.

/** One page's licence to name one non-resolving invocation. */
export interface DocCommandAllowance {
  /** Repo-relative, exactly as the scan reports it. */
  readonly path: string;
  /** The `CitationFault.subject`, verbatim: `x serve`, `x db status`, `x build --helm`. */
  readonly cites: string;
  readonly kind: 'absent' | 'proposed';
  /** Why this page may say it. One sentence, and it must survive being read out loud. */
  readonly why: string;
}

export const DOC_COMMAND_ALLOWANCES: readonly DocCommandAllowance[] = [
  // 26.0.0's migration row for the one-verb rename (#709): its subject is the old verbs a script
  // still runs, so a reader can recognise each one and swap it for the verb named beside it.
  {
    path: 'wiki/Upgrading.md',
    cites: 'x jobs ls',
    kind: 'absent',
    why: 'the 26.0.0 migration row names the removed verb so a script running it is recognised; the verb is list since 26.0.0',
  },
  {
    path: 'wiki/Upgrading.md',
    cites: 'x jobs rm',
    kind: 'absent',
    why: 'the 26.0.0 migration row names the removed verb so a script running it is recognised; the verb is delete since 26.0.0',
  },
  {
    path: 'wiki/Upgrading.md',
    cites: 'x db branch ls',
    kind: 'absent',
    why: 'the 26.0.0 migration row names the removed verb so a script running it is recognised; the verb is list since 26.0.0',
  },
  {
    path: 'wiki/Upgrading.md',
    cites: 'x db branch drop',
    kind: 'absent',
    why: 'the 26.0.0 migration row names the removed verb so a script running it is recognised; the verb is delete since 26.0.0',
  },
  // The record of the bug that made `x db branch` take a verb: its fix line said `ls`, and the old
  // dispatcher cloned a database called `ls`. The spelling IS the subject; 26.0.0 renamed the verb
  // to `list` (#709), and rewriting the record to `list` would make it describe a bug `list` never had.
  {
    path: 'docs/history/cli.md',
    cites: 'x db branch ls',
    kind: 'absent',
    why: 'the record is about the fix line `x db branch ls --json` cloning a database called ls; the verb is list since 26.0.0',
  },
  // The #290 record: 34 refusals emitted `x entities describe column --json`. The emitted string IS
  // the subject; rewriting it to `show` (26.0.0, #709) would record a fix line nothing ever printed.
  {
    path: 'docs/history/entity.md',
    cites: 'x entities describe',
    kind: 'absent',
    why: 'the record quotes the fix line the refusals emitted, x entities describe column --json; the verb is show since 26.0.0',
  },
  // 5.0.0's upgrade note about a `fix:` line that named a command which does not exist. The whole
  // sentence is "this said `x db replication init`, and there is no such subcommand" — naming it is
  // the point, and a reader who has the old string in a runbook needs to recognise it. It lists the
  // seven `x db` subcommands that DO ship on the same line, so nobody leaves the paragraph believing
  // in the eighth.
  {
    path: 'wiki/Upgrading.md',
    cites: 'x db replication',
    kind: 'absent',
    why: 'the entry records that this fix line cited a command that never existed, and names the seven real x db subcommands beside it',
  },
  // The five below are one deletion. `x deploy --critical` was parsed, echoed into the plan JSON
  // and read by nothing; 4.0.0 removed it. Each of these pages already said so — the flag was
  // documented as inert — so the sentences stayed true and gained "removed in 4.0.0". Deleting
  // them instead would erase the answer to "how do I force a reload?", which is the real question
  // every one of them is answering: your app calls `updateSignal()`, and no deploy flag does it.
  {
    path: 'docs/architecture/13-topology-runtime.md',
    cites: 'x deploy --critical',
    kind: 'absent',
    why: 'the row records that no forced-reload exception ships, and names the deleted flag as one of the two things that never acted on it',
  },
  // `x test --worker I` was deleted for `x verify --only unit --shard i/n`, the split CI already
  // used. The 22.x row recording what X_TEST_SHARD_FAILED belonged to, and the major's own
  // migration row, name the flag so a reader with it in a script finds the replacement.
  {
    path: 'wiki/Upgrading.md',
    cites: 'x test --worker',
    kind: 'absent',
    why: 'an upgrade page must name a removed flag: the migration is "x verify --only unit --shard i/n", and a reader who used it needs to find that line',
  },
  {
    path: 'wiki/Upgrading.md',
    cites: 'x deploy --critical',
    kind: 'absent',
    why: 'an upgrade page must name a removed flag: the migration is "drop it", and a reader who used it needs to find that line',
  },
  {
    path: 'wiki/Installation.md',
    cites: 'x env --fix',
    kind: 'absent',
    why: 'the Repair row exists to say it: "There is **no** `x env --fix`", then names the flags `x env` really declares',
  },
  {
    path: 'wiki/Testing.md',
    cites: 'x test mock',
    kind: 'absent',
    why: 'the X_TEST_NETWORK_SEALED row names mockFetch/allowHost and ends "There is no `x test mock` subcommand"',
  },
  {
    path: 'wiki/Tutorial-01-First-App.md',
    cites: 'x boundaries',
    kind: 'absent',
    why: 'the sentence teaches that boundaries is a step of `x verify`: "`bunx x boundaries` exits `X_CLI_UNKNOWN_COMMAND`"',
  },
  {
    path: 'wiki/CLI-Reference-Ship.md',
    cites: 'x serve',
    kind: 'absent',
    why: 'the section is titled "Serving in production" and its first sentence is "There is no `x serve` command"',
  },
  {
    path: 'wiki/CLI-Reference.md',
    cites: 'x db apply',
    kind: 'absent',
    why: 'the "Names that moved" table — the left column is the older name, and the row exists to retire it',
  },
  {
    path: 'wiki/CLI-Reference.md',
    cites: 'x gen',
    kind: 'absent',
    why: 'the same table: `x gen <kind>` moved to `x g <kind>`',
  },
  {
    path: 'wiki/CLI-Reference.md',
    cites: 'x deploy compose',
    kind: 'absent',
    why: 'the same table: `x deploy compose` moved to `x deploy --method compose`, refused since deploy took subcommands',
  },
  {
    path: 'wiki/CLI-Reference.md',
    cites: 'x deploy static',
    kind: 'absent',
    why: 'the same table: `x deploy static` moved to `x build --target static`',
  },
  {
    path: 'wiki/N-Plus-One-Detection.md',
    cites: 'x serve',
    kind: 'absent',
    why: 'contrasts `x dev` with the production boot: "`x serve`/`ROLE=web` never do"',
  },
  {
    path: 'docs/ops/03-observability.md',
    cites: 'x serve',
    kind: 'absent',
    why: 'states "There is no `x serve` command — a container runs the scaffolded apps/web/server.ts"',
  },
  {
    path: 'docs/idea/14-roadmap.md',
    cites: 'x ota',
    kind: 'proposed',
    why: 'milestone 14, in the "Not planned" table: the design proposed it, and the State column reads not planned',
  },
  {
    path: 'docs/idea/16-app-targets.md',
    cites: 'x ota',
    kind: 'proposed',
    why: 'the app-targets design: the OTA command set milestones 12–14 proposed, not planned since 2026-11-16',
  },
  {
    path: 'docs/idea/16-app-targets.md',
    cites: 'x app',
    kind: 'proposed',
    why: 'same design: `x app add mobile|desktop`, proposed with the native targets',
  },
  {
    path: 'docs/idea/16-app-targets.md',
    cites: 'x sdk',
    kind: 'proposed',
    why: 'same design: `x sdk swift|kotlin`, proposed with the native targets',
  },
  {
    path: 'docs/idea/16-app-targets.md',
    cites: 'x update',
    kind: 'proposed',
    why: 'named once, to explain why the proposed command is `x ota` and not `x update`',
  },
  {
    path: 'docs/idea/16-app-targets.md',
    cites: 'x new --targets',
    kind: 'proposed',
    why: 'the flag the native targets would add to `x new`',
  },
  {
    path: 'docs/idea/16-app-targets.md',
    cites: 'x build --store',
    kind: 'proposed',
    why: 'the store-submission flag the native targets would add; `--platform` itself shipped with the binary target in plan 101 sweep 8b',
  },
  {
    path: 'docs/idea/16-app-targets.md',
    cites: 'x dev --target',
    kind: 'proposed',
    why: 'how the proposed design would run the native target in dev',
  },
  // The reference app's desktop placeholder says the CLI has no `x app add` yet — true, and the
  // reason the directory is empty. Same proposed vocabulary as `docs/idea/16-app-targets.md`.
  {
    path: 'examples/dummy/apps/desktop/README.md',
    cites: 'x app',
    kind: 'absent',
    why: 'the sentence says the CLI has no `x app add`, which is why the desktop directory stays empty',
  },
  // The 25.0.0 rows record what a script running `x jobs drain --to …` met, and what it then
  // answered while planned. `drain` left the registry 2026-11-15 (wiki/Known-Gaps.md): the rows are
  // history a pinned reader still needs to recognise the verb by.
  {
    path: 'wiki/Upgrading.md',
    cites: 'x jobs drain',
    kind: 'absent',
    why: 'the 25.0.0 migration rows name the verb a script ran so it is recognised; x jobs has had no drain since 2026-11-15',
  },
  // The record of how `PLANNED_SUBCOMMANDS` began: `x db studio` was its first entry. Dated
  // history — the subcommand left the registry 2026-11-15, and rewriting the record would lose why.
  {
    path: 'docs/history/cli.md',
    cites: 'x db studio',
    kind: 'absent',
    why: 'the record says `x db studio` was the planned table first entry; it left the registry on 2026-11-15',
  },
  // Plan 101b slice 13 emptied `PLANNED_COMMANDS`: `x branch`, `x ai` and `x money` left the
  // registry 2026-11-16, each for a "not planned" row in wiki/Known-Gaps.md. The pages below name
  // them as non-commands — the decision rows, the reference's own "Planned commands" paragraph,
  // dated records and design history — so a reader who meets the old word finds where it went.
  {
    path: 'wiki/Known-Gaps.md',
    cites: 'x branch',
    kind: 'absent',
    why: 'the "Open by decision" row records that x branch is not planned and names x db branch create plus a container instead',
  },
  {
    path: 'wiki/Known-Gaps.md',
    cites: 'x ai',
    kind: 'absent',
    why: 'the "Open by decision" row records that x ai is not planned and names x test eval, a backfill() reindex and the bus instead',
  },
  {
    path: 'wiki/Known-Gaps.md',
    cites: 'x money',
    kind: 'absent',
    why: 'the "Open by decision" row records that x money is not planned and names registerCurrency() at boot instead',
  },
  {
    path: 'wiki/CLI-Reference.md',
    cites: 'x branch',
    kind: 'absent',
    why: 'the "Planned commands" paragraph says the table is empty and x branch now answers X_CLI_UNKNOWN_COMMAND',
  },
  {
    path: 'wiki/CLI-Reference.md',
    cites: 'x ai',
    kind: 'absent',
    why: 'the "Planned commands" paragraph says the table is empty and x ai now answers X_CLI_UNKNOWN_COMMAND',
  },
  {
    path: 'wiki/CLI-Reference.md',
    cites: 'x money',
    kind: 'absent',
    why: 'the "Planned commands" paragraph says the table is empty and x money now answers X_CLI_UNKNOWN_COMMAND',
  },
  {
    path: 'wiki/CLI-Reference.md',
    cites: 'x db studio',
    kind: 'absent',
    why: 'the "Planned commands" paragraph lists the subcommands that left PLANNED_SUBCOMMANDS on 2026-11-15',
  },
  {
    path: 'wiki/CLI-Reference.md',
    cites: 'x jobs drain',
    kind: 'absent',
    why: 'the "Planned commands" paragraph lists the subcommands that left PLANNED_SUBCOMMANDS on 2026-11-15',
  },
  {
    path: 'wiki/CLI-Reference.md',
    cites: 'x token grant',
    kind: 'absent',
    why: 'the "Planned commands" paragraph lists the subcommands that left PLANNED_SUBCOMMANDS on 2026-11-15',
  },
  {
    path: 'wiki/CLI-Reference.md',
    cites: 'x cache stats',
    kind: 'absent',
    why: 'the "Planned commands" paragraph lists the subcommands that left PLANNED_SUBCOMMANDS on 2026-11-15',
  },
  {
    path: 'docs/idea/13-dx.md',
    cites: 'x branch',
    kind: 'absent',
    why: 'the planned-commands paragraph records that the list is empty and x branch answers X_CLI_UNKNOWN_COMMAND',
  },
  {
    path: 'docs/idea/13-dx.md',
    cites: 'x ai',
    kind: 'absent',
    why: 'the planned-commands paragraph records that the list is empty and x ai answers X_CLI_UNKNOWN_COMMAND',
  },
  {
    path: 'docs/idea/13-dx.md',
    cites: 'x money',
    kind: 'absent',
    why: 'the planned-commands paragraph records that the list is empty and x money answers X_CLI_UNKNOWN_COMMAND',
  },
  {
    path: 'docs/idea/09-ai-first.md',
    cites: 'x branch',
    kind: 'absent',
    why: 'the branch-environments design says x branch is not planned and answers X_CLI_UNKNOWN_COMMAND',
  },
  {
    path: 'docs/idea/14-roadmap.md',
    cites: 'x branch',
    kind: 'absent',
    why: 'milestone 9 and the "Not planned" section both say x branch, a whole branch environment, is not planned',
  },
  {
    path: 'docs/history/ai.md',
    cites: 'x ai',
    kind: 'absent',
    why: 'the record of why no fix line may name x ai: the command was planned and threw, and is unknown since 2026-11-16',
  },
  {
    path: 'docs/history/cli.md',
    cites: 'x ai',
    kind: 'absent',
    why: 'the record quotes the six shipped fix lines that named unregistered commands, x ai prompts among them',
  },
  {
    path: 'docs/history/cli.md',
    cites: 'x branch',
    kind: 'absent',
    why: 'the record quotes the fix line the then-planned x branch handed out, which cloned a database called ls',
  },
];
