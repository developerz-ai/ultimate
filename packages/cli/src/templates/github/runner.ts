// The one `runs-on:` every workflow `x new` writes: a free GitHub-hosted runner unless the
// repository says otherwise. Spelled once so the gate and the image build can never disagree
// about the machine they assume.

/** The repository variable that overrides the runner — Settings → Secrets and variables → Actions. */
export const RUNNER_VARIABLE = 'CI_RUNNER';

/**
 * The default label. GitHub-hosted and free for a public repository; a paid or self-hosted runner
 * is a choice an owner makes by setting the variable, never one a scaffold makes for them.
 */
export const DEFAULT_RUNNER = 'ubuntu-latest';

/**
 * `vars.*` is an expression context `runs-on` accepts, and an unset variable reads as `''`, so the
 * `||` falls through to the default on every repository that never set one.
 */
export const RUNS_ON = `\${{ vars.${RUNNER_VARIABLE} || '${DEFAULT_RUNNER}' }}`;
