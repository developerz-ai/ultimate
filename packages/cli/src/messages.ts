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
  'cli.db.branch.ready': 'branch {name} ready',
  'cli.dev.ready': 'dev ready on {url} — /_x mounted, {services}',
  'cli.dev.hmr': 'reloaded {file} in {ms}ms',
  'cli.deploy.plan': 'containers only: {images} image, roles {roles}',
  'cli.doctor.clean': 'no findings — environment is shippable',
  'cli.doctor.findings': '{count} finding(s)',
  'cli.generate.wrote': 'wrote {count} file(s) for {kind} {name}',
  'cli.manifest.wrote': 'manifest written to {path} ({routes} routes, {actions} actions)',
  'cli.mcp.serving': 'mcp {transport} serving {tools} tools',
  'cli.new.done': 'created {name} — next: cd {name} && x dev',
  'cli.routes.empty': 'no routes in the manifest — run `x manifest` first',
  'cli.test.fail': '{failed} of {workers} shard(s) failed',
  'cli.test.pass': '{files} test file(s) on {workers} worker(s) passed in {ms}ms',
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
