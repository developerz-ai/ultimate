// The `x repro` rows of the CLI catalog (`messages.ts` composes them). Data only — `msg()` is the
// one lookup.

export const REPRO_MESSAGES = {
  'cli.repro.job': 'job {name} ({id}) died with {code} at step {step}',
  'cli.repro.request': '{primitive} {name} answered {code} — fingerprint {fingerprint}',
  'cli.repro.written': '  wrote {file}',
  'cli.repro.reproduced': '  reproduced: {file} fails with {code}',
  'cli.repro.notReproduced': '  not reproduced: {file} ended in {got}',
  'cli.repro.listed': '{count} captured bundle(s)',
} as const;
