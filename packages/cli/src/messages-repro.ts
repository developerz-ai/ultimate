// The `x repro` rows of the CLI catalog (`messages.ts` composes them), and `create-ultimate repro`'s.
// Data only — `msg()` is the one lookup.

export const REPRO_MESSAGES = {
  'cli.repro.job': 'job {name} ({id}) died with {code} at step {step}',
  'cli.repro.request': '{primitive} {name} answered {code} — fingerprint {fingerprint}',
  'cli.repro.written': '  wrote {file}',
  'cli.repro.reproduced': '  reproduced: {file} fails with {code}',
  'cli.repro.notReproduced': '  not reproduced: {file} ended in {got}',
  'cli.repro.listed': '{count} captured bundle(s)',
  'cli.repro.bundled': 'wrote the repro bundle {file}',
  'cli.repro.bundleMasked':
    '  {count} field(s) masked or stood in — the bundle lists them under masked',
  'cli.repro.bundleScrubbed': '  {env} env value(s) and {hosts} hostname(s) found and replaced',
  'cli.repro.bundleReadFirst':
    '  read {file} before you attach it to an issue: it is all that leaves',
  'cli.repro.opened': 'opened {code} from {bundle} into {dir}',
  'cli.repro.openedFramework':
    '  @ultimat3/* linked from {framework} (the bundle was made on {versions})',
  'cli.repro.openedRegistry':
    '  @ultimat3/* from the registry: pass --framework <checkout> to run on framework source',
  'cli.repro.openedStandIn':
    '  stand in {name} in apps/web/api and the entities in repro/bundle.json schema, then:',
  'cli.repro.openedNext': '  cd {dir} && bun install && bun test ./{file}',
} as const;
