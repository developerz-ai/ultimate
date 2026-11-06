// The `x upgrade` rows of the CLI catalog (`messages.ts` composes them): the hop walk, its stages
// and its `then:` lines. Data only — `msg()` is the one lookup.

export const UPGRADE_MESSAGES = {
  'cli.upgrade.atLatest': 'already at {version}, the newest release',
  'cli.upgrade.atTarget': 'already at {version}; {next} is the next release',
  'cli.upgrade.noApp.done':
    '{from} -> {to}: no app.config.ts, so no x verify ran; {count} script(s) passed',
  'cli.upgrade.noApp.none':
    '{from} -> {to}: nothing checked: no app.config.ts, and no typecheck or test script',
  'cli.upgrade.noApp.red': '{from} -> {to}: no app.config.ts, and a script failed: {names}',
  'cli.upgrade.scriptRed': 'failed, re-run it: bun run {name}',
  'cli.upgrade.then.atTarget':
    'nothing to do at {version}; a bare x upgrade --json takes the next release, {next}',
  'cli.upgrade.then.dryRunNoApp':
    'no app.config.ts, so on a clean tree x upgrade --json moves the pins and runs {scripts} in place of x verify',
  'cli.upgrade.then.noProof':
    'nothing checked this hop: confirm {to} works by hand, commit it, then re-run x upgrade --json for the next one',
  'cli.upgrade.then.scriptsGreen':
    'the scripts passed, which is less than x verify would say: review the diff, commit this hop to {to}, then re-run x upgrade --json for the next one',
  'cli.upgrade.then.scriptsRed':
    'read the section, make each failed script pass, commit this hop to {to}, then re-run x upgrade --json for the next one',
  'cli.upgrade.agentsMd.link':
    'AGENTS.md: byte-identical to CLAUDE.md, so this hop makes it a symlink to it',
  'cli.upgrade.agentsMd.differs':
    'AGENTS.md: differs from CLAUDE.md, left alone. Merge what only AGENTS.md says into CLAUDE.md, then: ln -sf CLAUDE.md AGENTS.md',
  'cli.upgrade.bunEdited': 'bun floor: {path} {from} -> {to}',
  'cli.upgrade.bunManual': 'bun floor, by hand: {path}:{line} — {why}',
  'cli.upgrade.done': '{from} -> {to}: the gate is green',
  'cli.upgrade.dryRun': '{from} -> {to}: nothing written, no gate run',
  'cli.upgrade.guard': 'guard, yours to take or leave: {fix}',
  'cli.upgrade.read': 'read: {title} — {url}',
  'cli.upgrade.red': '{from} -> {to}: not done, the gate says: {summary}',
  'cli.upgrade.stillRunning': 'x upgrade: still in {stage} ({elapsed})',
  'cli.upgrade.then': 'then: {then}',
  'cli.upgrade.then.atLatest':
    'nothing to do: this app is on {version}, and no newer release is published',
  'cli.upgrade.then.dryRun': 'on a clean tree, run the hop: x upgrade --json',
  'cli.upgrade.then.last':
    'review the diff and commit this hop to {to}: it is the newest release, so the walk is over',
  'cli.upgrade.then.red':
    'read the section, close each finding by its fix, re-check with x verify --json, commit this hop to {to}, then re-run x upgrade --json for the next one',
  'cli.upgrade.then.walk':
    'review the diff and commit this hop to {to}, then re-run x upgrade --json to take the next one, {next}',
} as const;
