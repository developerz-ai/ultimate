// The CLI's own flat message catalog. The CLI must render errors before an app (and therefore
// an app's i18n runtime) exists — `x new` and `x doctor` run outside any app — so it owns a
// built-in catalog in the same flat-key/loud-miss shape as @ultimat3/i18n instead of importing
// one. Missing keys render as ⟦key⟧, never as English fallback.

import { CLIENT_MESSAGES } from './messages-client';
import { DB_MESSAGES } from './messages-db';
import { GATE_MESSAGES } from './messages-gate';
import { REPRO_MESSAGES } from './messages-repro';
import { SHOT_MESSAGES } from './messages-shot';
import { UPGRADE_MESSAGES } from './messages-upgrade';

const CATALOG = {
  'cli.tagline': 'Ultimate — one command means shippable',
  'cli.usage': 'usage: x <command> [options]',
  'cli.hint.help': 'run `x help <command>` for details, add --json to any command',
  'cli.flags.heading': 'flags',
  'cli.commands.heading': 'commands',
  'cli.build.done': 'built {target}',
  'cli.build.failed': '{target} build failed',
  // A build-output line, so it belongs here rather than inline beside the emitter: `x build` is a
  // human surface and every other word it prints comes from this catalog.
  'cli.build.pushUnwired':
    'pwa.push is true and this build has no Web Push runtime behind it (a static export serves no subscribe action), so the emitted sw.js carries no push handler',
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
  'cli.dev.ready': 'dev ready on {url} — /_x mounted ({panels} panels), {services}',
  // The mail and CDN halves of that boot line. Rendered text, so it lives here — while
  // `describeMail`/`describeCdn` keep the same wording as the fixed vocabulary `x dev --json`
  // carries, and `runtime-services.test.ts` pins the two together so neither can drift alone.
  'cli.dev.cdn.external': 'cdn=external({driver} via {detail})',
  'cli.dev.cdn.none': 'cdn=none',
  'cli.dev.mail.embedded': 'mail=embedded',
  'cli.dev.mail.external': 'mail=external({driver} via {detail})',
  'cli.dev.mail.refused': 'mail=refused({detail})',
  'cli.dev.hmr': 'reloaded {file} in {ms}ms',
  'cli.dev.restart': 'restarting: {reason} — a module that defines a primitive holds the old code',
  // The two other restarts (`dev-rebuild-remount.ts`), each saying its own cause: the route table is
  // mounted once at boot, and a module that failed to import is served only by a new process.
  'cli.dev.restartSurface':
    'restarting: {file} changed what x dev mounts ({changes}) — the route table is built once, at boot',
  'cli.dev.restartFindings':
    'restarting: {file} changed which modules load ({changes}) — the new process prints the verdict',
  'cli.dev.change.added': '{what} added',
  'cli.dev.change.removed': '{what} removed',
  'cli.dev.change.failing': '{file} fails to load',
  'cli.dev.change.loads': '{file} loads again',
  'cli.dev.mounted.route': 'route {name}',
  'cli.dev.mounted.action': 'action {name}',
  'cli.dev.mounted.query': 'query {name}',
  'cli.dev.mounted.channel': 'channel {name}',
  'cli.dev.mounted.admin': 'admin {name}',
  'cli.dev.mounted.mount': 'mount {name}',
  // The restart's wait, said while it waits: a save never cancels a running job (issue #677).
  'cli.dev.restartWaiting':
    'restart waits for {count} running job(s) to finish — no new job is claimed; Ctrl-C stops now (a job still running is cut off at the drain deadline and requeued)',
  // A hard kill leaves the lock behind and that is normal, not a fault — worth one line so a
  // reader knows why the boot paused, and never a finding.
  'cli.dev.staleLock': 'cleared a stale dev.lock — the previous x dev did not shut down cleanly',
  'cli.dev.roles': '  roles {roles}',
  'cli.dev.panels': '  panels {panels}',
  'cli.dev.introspect': '  introspect {url}',
  'cli.dev.manifest': '  manifest {path}',
  'cli.dev.mcp': '  mcp POST {path}',
  // `x stop` (`cmd-stop.ts`): the lock's holder, and only it.
  'cli.stop.none': 'no x dev is running in this checkout',
  'cli.stop.stale':
    'the dev.lock names a pid another process now holds — nothing signalled; the next x dev clears the lock',
  'cli.stop.stopped': 'stopped x dev (pid {pid}, port {port}) in {ms}ms',
  'cli.stop.terminated':
    'terminated x dev (pid {pid}, port {port}) in {ms}ms — Windows stops a process without a drain',
  'cli.deploy.plan': 'containers only: {images} image, roles {roles}',
  'cli.deploy.verified':
    'build {build} held {windowMs} ms over {samples} sample(s); queues: {served} served, {idle} idle',
  'cli.deploy.verifiedUngraded':
    'build {build} held {windowMs} ms over {samples} sample(s); queues NOT graded: DATABASE_URL is unset, so no worker row was read',
  'cli.deploy.unverified': 'build {build} not verified: {count} finding(s)',
  'cli.doctor.clean': 'no findings — environment is shippable',
  'cli.doctor.poolerBound':
    'DATABASE_POOLER={pooler}, {role} role: statement_timeout {statement} ms, idle_in_transaction_session_timeout {idle} ms, as the session reads them',
  'cli.doctor.poolerWakeOff':
    'wake off, pickup within idlePollMaxMs ({ms} ms by default): a transaction pooler delivers no notification. For the wake, give this role a direct or session-pooled DATABASE_URL and unset DATABASE_POOLER',
  'cli.doctor.findings': '{count} finding(s)',
  'cli.doctor.guards':
    '{count} shipped guard(s) this app does not hold — each line adds one, then x verify reports what it finds:',
  'cli.doctor.guardsDiffer':
    '{count} shipped guard(s) differ from the current template — an older copy or your own edit; each line rewrites one and its test, review the diff before keeping it:',
  // `x doctor`'s other listing: what the coverage floor in x.verify.json does not see, and why.
  'cli.doctor.coverageExclude':
    '{count} path(s) x.verify.json excludes from the coverage floor — each with the reason it gives:',
  'cli.doctor.chartAlerts': '{count} monitoring template(s) missing from the chart:',
  // `x doctor`'s reminder: the rolling rail is off until this key is set (`doctor-rolling.ts`).
  'cli.doctor.rollingSince':
    'the rolling-deploy rail is off: set "rollingSince": "{newest}" in x.verify.json to judge every migration after your newest',
  'cli.docs.code': '{code} is an error code — x errors explain answers it',
  'cli.docs.exports': 'exports: {list}',
  'cli.docs.installed': 'installed: {list}',
  'cli.docs.tryErrors': 'every X_* code, with its fix',
  'cli.docs.tryActions': "this app's own primitives, not the framework's",
  'cli.docs.found': '{count} doc(s) for "{query}"',
  'cli.docs.none': 'no framework doc matches "{query}"',
  'cli.docs.unresolved': 'the installed framework packages could not be located',
  'cli.drill.listed': '{count} drill(s); run one with x drill <name> --json',
  'cli.drill.summary': '{held} of {ran} drill(s) held; {notRun} not run, its service undeclared',
  'cli.errors.count': '{count} registered error code(s)',
  'cli.errors.explained': '{code} — {title}',
  'cli.exercise.none': 'this app registers no action, query or job: nothing to exercise',
  'cli.exercise.summary':
    '{total} primitive(s): {reached} reached, {refused} refused, {off} off, {unreached} unreached — {file}',
  'cli.exercise.phases': 'took {total} ms — {phases} — slowest: {slowest}',
  'cli.exercise.slowest': 'slowest: {primitive} · {proof} {ms} ms',
  // One rendering of "this file was written", for every command that writes files — `x g`, its
  // own `--dry-run`, and `x new`. Three copies of the same two characters is how a fourth writer
  // arrives with a fifth marker; `--json` carries the paths themselves in `data.files`.
  'cli.file.added': '  + {path}',
  // Its pair, for the one generator that deletes: `x g sign-in --oidc` drops `x new`'s dev viewer.
  'cli.file.removed': '  - {path}',
  'cli.fix.clean': 'no boundary violation involves {file}',
  // "nothing written", the same admission `cli.generate.planned` makes and for the same reason: a
  // command called `fix` that only ever REPORTS teaches an agent to expect a repair and act as
  // though one happened. There is no `--write` and there is not going to be one
  // (`docs/architecture/02-boundaries.md`), so the line that runs says so every time.
  'cli.fix.plan':
    '{count} boundary violation(s) involve {file} — {edits} edit(s) to make, nothing written',
  'cli.generate.wrote': 'wrote {count} file(s) for {kind} {name}',
  // The run that declared a table: `{next}` is commands, joined with `&&`, that run as printed.
  'cli.generate.wroteNext': 'wrote {count} file(s) for {kind} {name} — next: {next}',
  // A distinct key, not the same sentence with a flag beside it: `--dry-run` reported "wrote 4
  // file(s)" while `data.dryRun` said nothing had landed, so an agent branching on `summary`
  // believed the files were on disk.
  'cli.generate.planned': 'would write {count} file(s) for {kind} {name} — nothing written',
  'cli.generate.chartAlertsPrinted': '{count} alert rule(s), as Prometheus rule groups',
  'cli.i18n.added': 'added {locale} — {keys} key(s) seeded from {from}',
  'cli.i18n.dynamic': '{count} dynamic t() call(s) the extractor cannot verify:',
  'cli.i18n.gaps': '{missing} missing key(s) across {locales} locale(s)',
  'cli.i18n.ok': '{locales} locale(s), {keys} key(s) used — no gaps',
  // The summary a locale-parity finding needs: `cli.i18n.gaps` counts MISSING KEYS, so it cannot
  // say "this locale's slots drifted and this string was never translated".
  'cli.i18n.parity':
    '{count} locale-parity finding(s) across {locales} locale(s) — a slot or an untranslated copy against {reference}',
  'cli.i18n.synced': 'synced {locale} from {from} — {added} key(s) added, {total} total',
  'cli.i18n.unused': '{count} key(s) defined in {locale} and never used:',
  'cli.mail.preview.missing':
    '{id}: {missing} of {locales} locale(s) miss a key — see data.previews[].missing',
  'cli.mail.preview.ok': '{id}: rendered in {locales} locale(s), every key resolved',
  'cli.jobs.backfillNoCursor': 'no cursor yet',
  'cli.jobs.cancelled': 'job {id} cancelled — {state}',
  'cli.jobs.backfillRow': '{name} — {rows} row(s) so far, cursor {cursor}',
  'cli.jobs.backfills': '{count} backfill(s) in flight:',
  'cli.jobs.deadLetters': '{count} dead letter(s):',
  'cli.jobs.depth':
    '{ready} ready · {running} running · {delayed} delayed · {dead} dead across {queues} queue(s)',
  'cli.jobs.listed': '{count} job(s)',
  'cli.jobs.nextPage': 'more — next page: x jobs list --after {cursor}',
  'cli.jobs.noError': 'no error recorded',
  'cli.jobs.paused': 'queue {queue} paused — no worker claims from it; enqueues still land',
  'cli.jobs.pausedQueues': 'paused queue(s): {queues}',
  'cli.jobs.promoted': 'job {id} promoted — due now',
  'cli.jobs.removed': 'job {id} removed — it was {state}',
  'cli.jobs.resumed': 'queue {queue} resumed',
  'cli.jobs.retried': 'job {id} re-queued — {state}',
  'cli.jobs.stepResolved': 'job {id} step {step} resolved — {status}; next: x jobs retry {id}',
  'cli.jobs.shown': 'job {id} — {state}, attempt {attempt} of {attempts}',
  'cli.manifest.blocked': 'manifest not written — {count} module(s) did not load',
  'cli.manifest.fresh': 'manifest is fresh',
  'cli.manifest.stale': 'manifest is stale',
  'cli.manifest.wrote': 'manifest written to {path} ({routes} routes, {actions} actions)',
  'cli.mcp.serving': 'mcp {transport} serving {tools} tools',
  'cli.mcp.scopes': '  scopes {scopes}',
  'cli.mcp.locked': 'mcp lock: {server} — {tools} tool(s) written to {file}',
  'cli.mcp.lock_current': 'mcp lock: {server} matches {file}',
  // `bun run setup` and nothing else: the scaffold ships it (`bin/setup.ts`), `README.md` and
  // the generated `ci.yml` both name it, and it is the only spelling that is right on a fresh clone — it
  // installs, writes `.env.development.local`, runs `x db gen "initial"` (the scaffold writes no
  // migration, so the drift step is red until it has), migrates and seeds. The four-command line
  // this replaced named `x dev` off a tree where nothing had installed the CLI yet, and skipped the
  // seed entirely.
  // `bun run dev`, never `x dev`: `bun install` links the binary into `./node_modules/.bin` and
  // nowhere else, so a bare `x` is not on PATH in the shell it is pasted into (proved with
  // `env -i PATH=… command -v x`); `bun run` puts that directory on PATH for the script. And
  // `bun run`, never a `bin/` path: Bun runs the line identically in PowerShell, cmd and bash.
  // `{cd}` is the resolved target as the caller's shell reaches it — `--dir` included, relative to
  // the cwd when under it, shell-quoted (`cmd-new.ts`'s `cdTarget`). `cd {name}` entered the wrong
  // directory, or none, whenever `--dir` put the app somewhere else.
  'cli.new.done': 'created {name} — next: cd {cd} && bun run setup && bun run dev',
  // `--dry-run`'s own summary: nothing landed, so "created" was a claim an agent branching on the
  // summary would act on. `{dir}` is the resolved target, `--dir` included.
  'cli.new.dryRun':
    'would create {name} in {dir} — nothing written; after a real run: cd {cd} && bun run setup && bun run dev',
  // The two prose lines of `x new`'s report. The `run: cd … && git init …` line beneath the second
  // one stays inline in `cmd-new.ts`: it is an instruction to paste verbatim, and a translated
  // command is a broken one — the same split `Finding.fix` already makes.
  'cli.new.wrote': '  {count} files in {dir}',
  'cli.new.noRepository': '  no repository — {problem}',
  // `git init` ran and the commit did not: `.git` exists, so "no repository" was false.
  'cli.new.uncommitted': '  repository initialised, nothing committed — {problem}',
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
  'cli.auth.sealed':
    'sealed {sealed} second-factor secret(s); {already} already sealed, {skipped} changed mid-run and left alone',
  'cli.tasks.count': '{count} task(s)',
  'cli.tasks.shown': '{name} — {cron} ({tz}), next {next}',
  'cli.test.fail': '{failed} of {workers} shard(s) failed',
  'cli.test.affected.none': 'nothing is affected by {base}...HEAD — 0 test file(s) ran',
  'cli.test.empty': 'no test file matches {selection} — 0 test file(s) ran (--allow-empty)',
  'cli.test.pass': '{files} test file(s) on {workers} worker(s) passed in {ms}ms',
  'cli.test.batch': '── batch {batch} of {batches} · {files} file(s) ──',
  'cli.test.batches': ' · {batches} batches',
  'cli.test.sampled': 'sampled {kept} of {total} {type} file(s)',
  'cli.test.type.fail': '{type} — {failed} of {workers} shard(s) failed',
  'cli.test.type.pass': '{type} — {files} test file(s) on {workers} worker(s) passed in {ms}ms',
  'cli.clean.nothing': 'nothing to clean: no test leftovers under this app',
  'cli.clean.removed': 'removed {paths} path(s) and {databases} probe database(s)',
  'cli.clean.would':
    'would remove {paths} path(s) and {databases} probe database(s) — --dry-run removed nothing',
  'cli.env.checked': '{count} declared variable(s), all present and valid',
  'cli.env.invalid': '{count} of {total} declared variable(s) missing or malformed',
  'cli.env.checkedAsProduction': 'checked as production: no ULTIMATE_ENV named',
  'cli.env.wrote': 'wrote {path} — {count} declared variable(s)',
  'cli.env.fresh': '{path} already matches the declaration',
  'cli.env.initialised': 'wrote {path} — {count} value(s), secrets generated and never printed',
  'cli.env.unfilled': '  {key} is required and empty — set it in {path}',
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
  'cli.vapid.created':
    'sealed a new Web Push key pair into {path} — ULTIMATE_VAPID_PUBLIC_KEY and ULTIMATE_VAPID_PRIVATE_KEY',
  'cli.vapid.public': '  public key (every page carries it as <meta name="x-push-key">): {key}',
  'cli.vapid.source.environment':
    'this process signs Web Push with the pair in its environment (ULTIMATE_VAPID_*)',
  'cli.vapid.source.sealed': 'this app signs Web Push with the pair sealed in {path}',
  'cli.vapid.source.development':
    'no pair in the environment or {path}: a local process signs with the published development pair, which a deployed boot refuses — x vapid create',
  'cli.secrets.rotated':
    'rotated {path} from master key {from} to {to} — {count} secret(s) resealed',
  'cli.secrets.retired':
    '  master key {kid} is retired, not gone: values it sealed still open — once they are re-sealed, x secrets rotate --drop {kid}',
  'cli.secrets.dropped':
    'dropped retired master key {kid} from {path} — {count} retired key(s) still declared',
  'cli.secrets.ring': 'retired master key(s) that still open sealed values: {kids}',
  ...CLIENT_MESSAGES,
  ...REPRO_MESSAGES,
  ...DB_MESSAGES,
  ...SHOT_MESSAGES,
  ...UPGRADE_MESSAGES,
  ...GATE_MESSAGES,
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
