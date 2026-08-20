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
  {
    path: 'docs/idea/08-pwa-offline.md',
    cites: 'x deploy --critical',
    kind: 'absent',
    why: 'milestone 5 is "designed, not wired", and the flag is cited as the half that was deleted rather than wired',
  },
  {
    path: 'wiki/PWA-And-Offline.md',
    cites: 'x deploy --critical',
    kind: 'absent',
    why: 'the sentence is "there is no deploy flag for this" — naming the removed one is what makes it answerable for a reader who remembers it',
  },
  {
    path: 'wiki/Troubleshooting.md',
    cites: 'x deploy --critical',
    kind: 'absent',
    why: 'the symptom row sends the reader to updateSignal() and names the flag only to say it never set anything and is now gone',
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
    path: 'wiki/CLI-Reference.md',
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
    why: 'milestone 14, in a table whose last column reads "design only"',
  },
  {
    path: 'docs/idea/16-app-targets.md',
    cites: 'x ota',
    kind: 'proposed',
    why: 'the app-targets design: the OTA command set milestones 12–14 propose',
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
    cites: 'x build --platform',
    kind: 'proposed',
    why: 'the flag `--target native|desktop` would share — and the first unknown flag on every `x build --platform … --store` line the page writes, so it covers `--store` too',
  },
  {
    path: 'docs/idea/16-app-targets.md',
    cites: 'x dev --target',
    kind: 'proposed',
    why: 'how the proposed design would run the native target in dev',
  },
];
