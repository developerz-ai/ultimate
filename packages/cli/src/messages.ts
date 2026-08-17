// The CLI's own flat message catalog. The CLI must render errors before an app (and therefore
// an app's i18n runtime) exists — `x new` and `x doctor` run outside any app — so it owns a
// built-in catalog in the same flat-key/loud-miss shape as @ultimat3/i18n instead of importing
// one. Missing keys render as ⟦key⟧, never as English fallback.

const CATALOG = {
  'cli.tagline': 'Ultimate — one command means shippable',
  'cli.usage': 'usage: x <command> [options]',
  'cli.hint.help': 'run `x help <command>` for details, add --json to any command',
  'cli.flags.heading': 'flags',
  'cli.commands.heading': 'commands',
  'cli.build.done': 'built {target}',
  'cli.build.failed': '{target} build failed',
  // `describeCron`'s vocabulary. `@ultimat3/time` is tier 1 and reaches no i18n runtime, so the
  // caller supplies the words — and the caller here is a rendered `x tasks show` line, which is
  // exactly what this catalog holds. `msg()` leaves an un-supplied `{n}`/`{time}`/`{days}`/
  // `{months}` intact, so each value arrives at `describeCron` as the template it interpolates.
  'cli.cron.andMore': 'and {n} more',
  'cli.cron.at': 'at {time}',
  'cli.cron.everyDay': 'every day',
  'cli.cron.everyHour': 'every hour',
  'cli.cron.everyMinute': 'every minute',
  'cli.cron.everyNHours': 'every {n} hours',
  'cli.cron.everyNMinutes': 'every {n} minutes',
  'cli.cron.inMonths': 'in {months}',
  'cli.cron.onDaysOfMonth': 'on day {days} of the month',
  'cli.cron.onWeekdays': 'on {days}',
  'cli.db.backfill.empty': 'no backfill has run against this database yet',
  'cli.db.backfill.listed': '{count} backfill pass(es)',
  /** The empty cell in a `x db backfill --list` column — a value, not a column key. */
  'cli.db.backfill.none': '-',
  'cli.db.backfill.pending': '{count} of {declared} declared backfill(s) never completed',
  'cli.db.backfill.swept': 'every one of {declared} declared backfill(s) has completed',
  // Every action counted, never derived: `count - enqueued` folded a deduped pass into "blocked",
  // so the summary said blocked while `--json` said deduped for the same row — two renderers
  // stating different facts about one run, which is the thing `--json` exists to make impossible.
  'cli.db.backfill.planned':
    '{count} backfill(s): {enqueued} enqueued, {deduped} already live, {blocked} blocked',
  'cli.db.backfill.dryRun': '{count} backfill(s) would run — nothing written without --write',
  'cli.db.branch.ready': 'branch {name} ready',
  'cli.db.branch.dropped': 'branch {name} dropped',
  'cli.db.branch.failed': 'branch command failed',
  'cli.db.branch.listed': '{count} branch(es) of this database',
  'cli.db.branch.none': 'this database has no branch',
  /** The empty cell in an `x db branch ls` column — a value, not a column key. */
  'cli.db.branch.unknown': '-',
  'cli.db.gen.failed': 'migration not generated',
  'cli.db.gen.unchanged': 'entities and migrations agree — nothing to generate',
  'cli.db.gen.written': 'migration {id} generated',
  'cli.db.migrate.applied': 'migrations applied',
  'cli.db.migrate.failed': 'migration failed',
  'cli.db.reset.done': 'database reset and migrated',
  'cli.dev.ready': 'dev ready on {url} — /_x mounted ({panels} panels), {services}',
  // The mail and CDN halves of that boot line. Rendered text, so it lives here — while
  // `describeMail`/`describeCdn` keep the same wording as the fixed vocabulary `x dev --json`
  // carries, and `dev-runtime.test.ts` pins the two together so neither can drift alone.
  'cli.dev.cdn.external': 'cdn=external({driver} via {detail})',
  'cli.dev.cdn.none': 'cdn=none',
  'cli.dev.mail.embedded': 'mail=embedded',
  'cli.dev.mail.external': 'mail=external({driver} via {detail})',
  'cli.dev.mail.refused': 'mail=refused({detail})',
  'cli.dev.hmr': 'reloaded {file} in {ms}ms',
  'cli.dev.roles': '  roles {roles}',
  'cli.dev.panels': '  panels {panels}',
  'cli.dev.introspect': '  introspect {url}',
  'cli.dev.manifest': '  manifest {path}',
  'cli.deploy.plan': 'containers only: {images} image, roles {roles}',
  'cli.doctor.clean': 'no findings — environment is shippable',
  'cli.doctor.findings': '{count} finding(s)',
  'cli.docs.code': '{code} is an error code — x errors explain answers it',
  'cli.docs.exports': 'exports: {list}',
  'cli.docs.installed': 'installed: {list}',
  'cli.docs.tryErrors': 'every X_* code, with its fix',
  'cli.docs.tryActions': "this app's own primitives, not the framework's",
  'cli.docs.found': '{count} doc(s) for "{query}"',
  'cli.docs.none': 'no framework doc matches "{query}"',
  'cli.docs.unresolved': 'the installed framework packages could not be located',
  'cli.errors.count': '{count} registered error code(s)',
  'cli.errors.explained': '{code} — {title}',
  // One rendering of "this file was written", for every command that writes files — `x g`, its
  // own `--dry-run`, and `x new`. Three copies of the same two characters is how a fourth writer
  // arrives with a fifth marker; `--json` carries the paths themselves in `data.files`.
  'cli.file.added': '  + {path}',
  'cli.fix.clean': 'no boundary violation involves {file}',
  // "nothing written", the same admission `cli.generate.planned` makes and for the same reason: a
  // command called `fix` that only ever REPORTS teaches an agent to expect a repair and act as
  // though one happened. There is no `--write` and there is not going to be one
  // (`docs/architecture/02-boundaries.md`), so the line that runs says so every time.
  'cli.fix.plan':
    '{count} boundary violation(s) involve {file} — {edits} edit(s) to make, nothing written',
  'cli.generate.wrote': 'wrote {count} file(s) for {kind} {name}',
  // A distinct key, not the same sentence with a flag beside it: `--dry-run` reported "wrote 4
  // file(s)" while `data.dryRun` said nothing had landed, so an agent branching on `summary`
  // believed the files were on disk.
  'cli.generate.planned': 'would write {count} file(s) for {kind} {name} — nothing written',
  'cli.i18n.added': 'added {locale} — {keys} key(s) seeded from {from}',
  'cli.i18n.dynamic': '{count} dynamic t() call(s) the extractor cannot verify:',
  'cli.i18n.gaps': '{missing} missing key(s) across {locales} locale(s)',
  'cli.i18n.ok': '{locales} locale(s), {keys} key(s) used — no gaps',
  'cli.i18n.synced': 'synced {locale} from {from} — {added} key(s) added, {total} total',
  'cli.i18n.unused': '{count} key(s) defined in {locale} and never used:',
  'cli.jobs.backfillNoCursor': 'no cursor yet',
  'cli.jobs.cancelled': 'job {id} cancelled — {state}',
  'cli.jobs.backfillRow': '{name} — {rows} row(s) so far, cursor {cursor}',
  'cli.jobs.backfills': '{count} backfill(s) in flight:',
  'cli.jobs.deadLetters': '{count} dead letter(s):',
  'cli.jobs.depth':
    '{ready} ready · {running} running · {delayed} delayed · {dead} dead across {queues} queue(s)',
  'cli.jobs.drained': 'drained {count} job(s) from {from} to {to}',
  'cli.jobs.drainedPartial':
    'drained {count} job(s) from {from} to {to} — {skipped} left on {from}',
  'cli.jobs.listed': '{count} job(s)',
  'cli.jobs.noError': 'no error recorded',
  'cli.jobs.retried': 'job {id} re-queued — {state}',
  'cli.jobs.shown': 'job {id} — {state}, attempt {attempt} of {attempts}',
  'cli.jobs.skipped': '{count} job(s) left on {from} — re-run the drain once each is claimable:',
  'cli.manifest.blocked': 'manifest not written — {count} module(s) did not load',
  'cli.manifest.fresh': 'manifest is fresh',
  'cli.manifest.stale': 'manifest is stale',
  'cli.manifest.wrote': 'manifest written to {path} ({routes} routes, {actions} actions)',
  'cli.mcp.serving': 'mcp {transport} serving {tools} tools',
  'cli.mcp.scopes': '  scopes {scopes}',
  'cli.new.done': 'created {name} — next: cd {name} && x dev',
  'cli.policy.count':
    '{permissions} permission(s), {roles} role(s), {enforced} enforced by a declaration',
  // One row per (declaration, actor) pair, never per role: a permission two declarations enforce
  // evaluates every actor twice, so "of N role(s)" over-counted whenever it had more than one.
  'cli.policy.explained': '{subject} — allowed for {allowed} of {evaluations} actor evaluation(s)',
  'cli.policy.allow': 'allow',
  'cli.policy.deny': 'deny',
  'cli.policy.declaration': '{kind} {name} — policy {label}',
  /** The empty cell in a `x policy list` column — a value, not a column key. */
  'cli.policy.none': '-',
  'cli.policy.noInput':
    'evaluated with no request input and no row — a rule reading either decides again on the real request',
  'cli.policy.undecidable': 'not decidable outside a request — this policy reads request input',
  'cli.policy.unenforced': '{count} permission(s) no action or query enforces:',
  'cli.registry.count': '{count} {kind}',
  'cli.registry.described': '{kind} {name}',
  'cli.routes.count': '{count} routes',
  'cli.routes.empty': 'no routes in the manifest — run `x manifest` first',
  'cli.tasks.count': '{count} task(s)',
  'cli.tasks.shown': '{name} — {cron} ({tz}), next {next}',
  'cli.test.fail': '{failed} of {workers} shard(s) failed',
  'cli.test.pass': '{files} test file(s) on {workers} worker(s) passed in {ms}ms',
  'cli.test.sampled': 'sampled {kept} of {total} {type} file(s)',
  'cli.test.type.fail': '{type} — {failed} of {workers} shard(s) failed',
  'cli.test.type.pass': '{type} — {files} test file(s) on {workers} worker(s) passed in {ms}ms',
  'cli.verify.pass': 'all {count} steps passed in {ms}ms',
  'cli.verify.fail': '{failed} of {count} steps failed',
  // A skipped step is not a passed one, so the two counts never share a sentence — and the skipped
  // ones are named, because "which suite has nothing to run here?" is the question a green gate
  // over a missing suite has to answer on its own line. Whole sentences per case rather than a
  // clause the caller glues on, the same shape `cli.jobs.drained`/`drainedPartial` already uses.
  'cli.verify.passSkipped':
    '{passed} of {count} steps passed in {ms}ms — {skipped} skipped: {names}',
  'cli.verify.failSkipped': '{failed} of {count} steps failed — {skipped} skipped: {names}',
  'cli.verify.serial': 'serial',
  'cli.verify.workers': '{workers} workers',
  'cli.env.checked': '{count} declared variable(s), all present and valid',
  'cli.env.invalid': '{count} of {total} declared variable(s) missing or malformed',
  'cli.env.wrote': 'wrote {path} — {count} declared variable(s)',
  'cli.env.fresh': '{path} already matches the declaration',
  'cli.secrets.init': 'sealed {path} — master key {kid}, and .gitignore now covers the key file',
  'cli.secrets.deploy': '  carry the key into a deploy with {env}="$(cat {keyPath})"',
  'cli.secrets.redeploy': '  set {env}="$(cat {keyPath})" in every deploy before the next release',
  'cli.secrets.shown': '{count} secret(s) in {path}, sealed with master key {kid}',
  'cli.secrets.empty': '{path} holds no secrets yet',
  'cli.secrets.undeclared':
    '{count} secret(s) no envSchema declares, so nothing reads them: {names}',
  'cli.secrets.edited': '{path} resealed — {added} added, {updated} changed, {removed} removed',
  'cli.secrets.unchanged': '{path} unchanged — nothing was written',
  'cli.secrets.set': 'sealed {name} into {path} — {count} secret(s)',
  'cli.secrets.rotated':
    'rotated {path} from master key {from} to {to} — {count} secret(s) resealed',
} as const;

export type MessageKey = keyof typeof CATALOG;

export type MessageParams = Readonly<Record<string, string | number>>;

/**
 * Look up a message and interpolate `{name}` placeholders. An unknown key renders `⟦key⟧` so a
 * miss is visible in the terminal and in `--json`, never silently papered over.
 */
export function msg(key: MessageKey | string, params: MessageParams = {}): string {
  const template: string | undefined = (CATALOG as Record<string, string>)[key];
  if (template === undefined) return `⟦${key}⟧`;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

export const messageKeys = (): readonly string[] => Object.keys(CATALOG);
