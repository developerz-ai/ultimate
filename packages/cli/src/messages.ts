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
  'cli.db.branch.ready': 'branch {name} ready',
  'cli.dev.ready': 'dev ready on {url} — /_x mounted ({panels} panels), {services}',
  // The mail and CDN halves of that boot line. Rendered text, so it lives here — while
  // `describeMail`/`describeCdn` keep the same wording as the fixed vocabulary `x dev --json`
  // carries, and `dev-runtime.test.ts` pins the two together so neither can drift alone.
  'cli.dev.cdn.external': 'cdn=external({driver} via {detail})',
  'cli.dev.cdn.none': 'cdn=none',
  'cli.dev.mail.embedded': 'mail=embedded',
  'cli.dev.mail.external': 'mail=external({driver} via {detail})',
  'cli.dev.hmr': 'reloaded {file} in {ms}ms',
  'cli.dev.roles': '  roles {roles}',
  'cli.dev.panels': '  panels {panels}',
  'cli.dev.introspect': '  introspect {url}',
  'cli.dev.manifest': '  manifest {path}',
  'cli.deploy.plan': 'containers only: {images} image, roles {roles}',
  'cli.doctor.clean': 'no findings — environment is shippable',
  'cli.doctor.findings': '{count} finding(s)',
  'cli.errors.count': '{count} registered error code(s)',
  'cli.errors.explained': '{code} — {title}',
  'cli.fix.clean': 'no boundary violation involves {file}',
  'cli.fix.plan': '{count} boundary violation(s) involve {file} — {edits} edit(s) to make',
  'cli.generate.wrote': 'wrote {count} file(s) for {kind} {name}',
  'cli.i18n.added': 'added {locale} — {keys} key(s) seeded from {from}',
  'cli.i18n.dynamic': '{count} dynamic t() call(s) the extractor cannot verify:',
  'cli.i18n.gaps': '{missing} missing key(s) across {locales} locale(s)',
  'cli.i18n.ok': '{locales} locale(s), {keys} key(s) used — no gaps',
  'cli.i18n.synced': 'synced {locale} from {from} — {added} key(s) added, {total} total',
  'cli.i18n.unused': '{count} key(s) defined in {locale} and never used:',
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
