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
  // A THIRD outcome, and it is neither of the other two: nothing to generate, but the sidecar the
  // `drift` step reads did move — an edit under `packages/db/src` that implies no DDL. Rendering it
  // as `written` would name a migration nobody can apply; as `unchanged`, it would hide a file this
  // command wrote. `GeneratedFiles.outcome` is what `--json` carries the same distinction on.
  'cli.db.gen.recorded': 'no migration needed — schema hash re-recorded in {file}',
  'cli.db.gen.written': 'migration {id} generated',
  'cli.db.migrate.applied': 'migrations applied',
  'cli.db.migrate.failed': 'migration failed',
  'cli.db.reset.done': 'database reset and migrated',
  // Every seed counted per outcome, exactly as the backfill summary is: a replayed seed writes
  // nothing and skips everything, and a total that hid that would make the second run look idle.
  'cli.db.seed.done':
    '{count} seed(s): {inserted} inserted, {updated} updated, {skipped} already stored',
  'cli.db.seed.dryRun': '{count} seed(s) would run — nothing written while --dry-run is set',
  'cli.db.seed.failed': '{failed} of {count} seed(s) failed',
  'cli.db.seed.none': 'no seed matched — nothing to run',
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
  // A hard kill leaves the lock behind and that is normal, not a fault — worth one line so a
  // reader knows why the boot paused, and never a finding.
  'cli.dev.staleLock': 'cleared a stale dev.lock — the previous x dev did not shut down cleanly',
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
  // `bin/setup` and nothing else: the scaffold ships it, `README.md` and `bin/check` both name it,
  // and it is the only spelling that is right on a fresh clone — it installs, writes
  // `.env.development.local`, runs `x db gen "initial"` (the scaffold writes no migration, so the
  // drift step is red until it has), migrates and seeds. The four-command line this replaced named
  // `x dev` off a tree where nothing had installed the CLI yet, and skipped the seed entirely.
  // `bin/dev`, never `x dev`: `bun install` links the binary into `./node_modules/.bin` and
  // nowhere else, so the bare `x` this line printed is not on PATH in the shell it is pasted into
  // (proved with `env -i PATH=… command -v x`). The scaffold's own `bin/` wrappers are the form
  // that works from a fresh clone, and `bin/setup` already uses `bunx x` internally for this
  // reason.
  'cli.new.done': 'created {name} — next: cd {name} && bin/setup && bin/dev',
  // The two prose lines of `x new`'s report. The `run: cd … && git init …` line beneath the second
  // one stays inline in `cmd-new.ts`: it is an instruction to paste verbatim, and a translated
  // command is a broken one — the same split `Finding.fix` already makes.
  'cli.new.wrote': '  {count} files in {dir}',
  'cli.new.noRepository': '  no repository — {problem}',
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
  'cli.affected.count':
    '{count} workspace(s) affected by {base}...HEAD, from {changed} changed file(s)',
  'cli.affected.dirty':
    '  including the working tree (--dirty): every uncommitted change in this checkout, whoever made it',
  'cli.affected.none': 'no workspace is affected by {base}...HEAD, from {changed} changed file(s)',
  'cli.affected.rootWide':
    '  every workspace: {files} belongs to none of them and changes what all of them compile',
  // `x shot` — the picture is the `lines`, the verdict is the artifact. The summary names the
  // GATING fact, and a redirect comes first: a photograph of the sign-in page with every island
  // missing reads as a bug in the app, and it is a bug in the capture.
  'cli.shot.ok': '{route} clean — {islands} island(s) mounted, nothing logged and nothing threw',
  'cli.shot.errors': '{route}: {errors} console error(s) — verdict.json names each one',
  'cli.shot.redirected': '{route} redirected to {url} — the picture is not the route asked for',
  'cli.shot.server.booted': '  server   booted for this shot on {url}',
  'cli.shot.server.reused': '  server   the x dev already running on {url}',
  'cli.shot.canvas': '  canvas   {width}x{height}',
  'cli.shot.canvasUnreadable': '  canvas   unreadable — {bytes} byte(s), not a decodable image',
  'cli.shot.islands': '  islands  {booted} of {declared} mounted ({strategies})',
  'cli.shot.islandsUnknown': '  islands  not counted — the page answered no probe',
  // The failure a picture cannot show and a console count cannot see: a rejected mount promise
  // calls no console method, so the FIRST one is named here rather than left to verdict.json.
  'cli.shot.islandFailed': '{route}: {failed} island(s) failed to mount — {island}: {message}',
  'cli.shot.network': '  network  {requests} request(s), {refused} refused, {dropped} dropped',
  'cli.shot.console': '  console  {level}: {text}',
  'cli.shot.threw': '{route}: {thrown} uncaught exception(s) — {first}',
  'cli.shot.pageError': '  threw    {message}  {at}',
  'cli.shot.picture': '  picture  {path}',
  'cli.shot.verdict': '  verdict  {path}',
  'cli.shot.blind.status':
    'HTTP response status is not observed — the port records requests, never responses',
  // `--island`. A component capture reports per STATE, so the summary counts pictures and the
  // lines name one state each; nothing here restates a fact `--json` does not carry.
  'cli.shot.island.ok':
    '{island} clean — {pictures} picture(s), every one mounted, nothing logged and nothing threw',
  'cli.shot.island.failed':
    '{island}: {taken} of {expected} declared picture(s) taken — verdict.json names each refusal',
  'cli.shot.island.state': '  {state}  {theme}  {width}x{height}  {file}',
  'cli.shot.island.missing': '  missing  {file} — no picture was taken for this declared state',
  'cli.shot.island.picture': '  pictures {path}',
  'cli.shot.island.verdict': '  verdict  {path}',
  'cli.shot.island.blind.crop':
    'the picture is the viewport, not a crop — the browser port takes no clip rectangle, so a state sizes its own frame with viewport',
  'cli.shot.island.blind.locale':
    'toLocaleString() on a Date resolves its zone inside the engine — only an explicit timeZone is pinned by this harness',
  'cli.ci.failed':
    '{failed} of {runs} workflow run(s) on {branch} failed — {findings} finding(s) recovered from the log',
  'cli.ci.green': 'every one of {runs} workflow run(s) on {branch} passed',
  'cli.ci.job': '  {conclusion}  {job}  ({steps})',
  'cli.ci.jobs.other': '  {count} other job(s) in this run',
  'cli.ci.logs.empty': '  the failed step wrote no log — {url}',
  /** The conclusion of a run GitHub has not finished — a value, not a column key. */
  'cli.ci.pending': 'pending',
  'cli.ci.run': '{conclusion}  {workflow}  {url}',
  'cli.ci.running':
    '{running} of {runs} workflow run(s) on {branch} has not finished — nothing has failed yet',
  'cli.ci.tail': '  log tail, {job}:',
  'cli.pr.body.truncated': '      … {hidden} more line(s) — re-run with --full',
  /** The line of a thread whose anchor GitHub answers null for — a value, not a column key. */
  'cli.pr.line.unknown': '-',
  'cli.pr.replied': 'replied on thread {id}: {url}',
  // Resolving closes a CONVERSATION. Whether the finding is fixed is a fact about the code that
  // no GitHub mutation observes, and a summary saying "addressed" would assert one from the other.
  'cli.pr.resolved':
    'thread {id} is marked resolved on GitHub — that records the conversation, not that the finding is fixed',
  'cli.pr.review.count':
    '{unresolved} unresolved and {resolved} resolved review thread(s) on {repo}#{pr}',
  'cli.pr.review.current': '  submitted against the current head {head}',
  'cli.pr.review.decision': '  review: {decision} by {author} at {submitted}',
  'cli.pr.review.none': 'no review thread is anchored to a line on {repo}#{pr}',
  'cli.pr.review.stale':
    '  submitted against {commit}; the head is now {head} ({committed}) — this decision predates the current code',
  'cli.pr.review.truncated':
    '  more than {count} threads — this is the first page, not the whole review',
  'cli.pr.review.undecided': '  GitHub reports no review decision yet',
  'cli.pr.thread.closed': '  resolved    {path}:{line}  {id}',
  'cli.pr.thread.comment': '    {author} at {createdAt}',
  'cli.pr.thread.more': '    {hidden} more comment(s) on this thread',
  'cli.pr.thread.open': '  unresolved  {path}:{line}  {id}',
  'cli.pr.thread.outdated':
    '    the diff has moved under this thread — {line} is where the comment was written',
  'cli.test.fail': '{failed} of {workers} shard(s) failed',
  'cli.test.affected.none': 'nothing is affected by {base}...HEAD — 0 test file(s) ran',
  'cli.test.pass': '{files} test file(s) on {workers} worker(s) passed in {ms}ms',
  'cli.test.sampled': 'sampled {kept} of {total} {type} file(s)',
  'cli.test.type.fail': '{type} — {failed} of {workers} shard(s) failed',
  'cli.test.type.pass': '{type} — {files} test file(s) on {workers} worker(s) passed in {ms}ms',
  // The banner a `--only` run carries, in front of whichever summary above it renders. Rendered
  // output, so it lives here — `data.notAGateRun` is the machine marker, and a reader testing for
  // one narrowed run reads that boolean rather than substring-matching this line.
  'cli.verify.notAGateRun': 'NOT A GATE RUN — {summary}',
  'cli.verify.pass': 'all {count} steps passed in {ms}ms',
  'cli.verify.fail': '{failed} of {count} steps failed',
  // A skipped step is not a passed one, so the two counts never share a sentence — and the skipped
  // ones are named, because "which suite has nothing to run here?" is the question a green gate
  // over a missing suite has to answer on its own line. Whole sentences per case rather than a
  // clause the caller glues on, the same shape `cli.jobs.drained`/`drainedPartial` already uses.
  'cli.verify.passSkipped':
    '{passed} of {count} steps passed in {ms}ms — {skipped} skipped: {names}',
  'cli.verify.failSkipped': '{failed} of {count} steps failed — {skipped} skipped: {names}',
  // The `errors` step's own coverage, in `output`: a scan without a parser reads most fix lines
  // and not all of them, and a step that reports findings alone claims a completeness it lacks.
  'cli.verify.fixCoverage': 'checked {checked} fix line(s), could not read {unreadable}',
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
